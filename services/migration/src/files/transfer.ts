import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import type { AdapterContext, SourceAdapter } from '../adapters/types.js';
import { idempotencyKey } from '../canonical/hash.js';
import { config } from '../config.js';
import { getPool, withTransaction } from '../db/pool.js';
import * as errorsRepo from '../db/repositories/errors.js';
import * as recordsRepo from '../db/repositories/records.js';
import type { DestinationClient } from '../destination/types.js';
import type { EntityType } from '../domain/entities.js';
import { MigrationError, toMigrationError } from '../domain/errors.js';
import { metrics } from '../observability/metrics.js';
import { silentLogger, type Logger } from '../observability/logger.js';
import { mapWithConcurrency, RateLimiter } from '../pipeline/ratelimit.js';
import { retryOptionsFrom, withRetry } from '../pipeline/retry.js';

/**
 * File and image transfer (Guide §14, Scope §22-24).
 *
 * Separate from the record pipeline for one reason that Scope §24 states
 * directly: a single failed photo must not fail the migration. Assets get their
 * own ledger (migration_files), their own retry counter, and their own
 * disposition, so a customer with 40,000 photos and 12 broken URLs completes
 * with 12 explained failures rather than a rolled-back migration.
 *
 * Metadata discovery and binary transfer are two phases (Guide §14.1): the
 * engine learns what exists, then moves bytes in bounded batches, so an
 * enormous photo library never lives in one execution's memory.
 */

/** Extensions never accepted regardless of declared MIME type. */
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.dll', '.scr', '.bat', '.cmd', '.com', '.msi', '.jar',
  '.sh', '.ps1', '.vbs', '.js', '.app', '.deb', '.rpm',
]);

const ALLOWED_MIME_PREFIXES = ['image/', 'video/', 'audio/', 'text/', 'application/'];

/** Refuse anything larger than this per asset (Scope §22 bounded batches). */
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;

export interface FileMetadata {
  sourceFileId: string;
  fileName: string;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sourceUrl: string | null;
  sourceHash: string | null;
  kind: 'document' | 'image' | 'attachment';
  parentEntityType: string | null;
  parentSourceId: string | null;
  uploadedByUserSourceId: string | null;
  sourceCreatedAt: Date | null;
  width?: number | null;
  height?: number | null;
  album?: string | null;
}

export interface FileTransferOptions {
  adapter: SourceAdapter;
  destination: DestinationClient;
  logger?: Logger;
  concurrency?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

export interface FileTransferSummary {
  discovered: number;
  uploaded: number;
  skipped: number;
  failed: number;
  unsupported: number;
  bytesTransferred: number;
}

export class FileTransferEngine {
  private readonly adapter: SourceAdapter;
  private readonly destination: DestinationClient;
  private readonly logger: Logger;
  private readonly limiter: RateLimiter;
  private readonly concurrency: number;
  private readonly maxFileBytes: number;
  private readonly signal?: AbortSignal;

  constructor(options: FileTransferOptions) {
    this.adapter = options.adapter;
    this.destination = options.destination;
    this.logger = options.logger ?? silentLogger;
    this.limiter = new RateLimiter(options.adapter.rateLimit);
    this.concurrency = options.concurrency ?? config().DEFAULT_FILE_CONCURRENCY;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.signal = options.signal;
  }

  /**
   * Phase 1 (Guide §14.1): record what assets exist, before moving any bytes.
   * Idempotent -- re-registering an already-known file is a no-op.
   */
  async registerMetadata(
    context: AdapterContext,
    entity: EntityType,
    files: readonly FileMetadata[],
  ): Promise<number> {
    if (files.length === 0) return 0;

    await withTransaction(async (client) => {
      for (const file of files) {
        await client.query(
          `INSERT INTO migration_files (
             migration_id, tenant_id, entity_type, source_file_id, source_filename, source_url,
             source_size_bytes, source_hash, mime_type, parent_entity_type, parent_source_id, state)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DISCOVERED')
           ON CONFLICT (migration_id, entity_type, source_file_id) DO UPDATE SET
             source_filename = EXCLUDED.source_filename,
             source_url = EXCLUDED.source_url,
             source_size_bytes = EXCLUDED.source_size_bytes,
             mime_type = EXCLUDED.mime_type,
             parent_entity_type = EXCLUDED.parent_entity_type,
             parent_source_id = EXCLUDED.parent_source_id,
             updated_at = now()`,
          [
            context.migrationId, context.tenantId, entity, file.sourceFileId, file.fileName,
            file.sourceUrl, file.sizeBytes, file.sourceHash, file.mimeType,
            file.parentEntityType, file.parentSourceId,
          ],
        );
      }
    });

    return files.length;
  }

  /**
   * Phase 2: move the bytes for everything still pending, in bounded batches.
   *
   * Resumable by construction: the query only selects assets not already
   * uploaded, so re-running after a crash picks up exactly what is left.
   */
  async transferPending(
    context: AdapterContext,
    options: { batchSize?: number; entity?: EntityType } = {},
  ): Promise<FileTransferSummary> {
    const batchSize = options.batchSize ?? 100;
    const summary: FileTransferSummary = {
      discovered: 0, uploaded: 0, skipped: 0, failed: 0, unsupported: 0, bytesTransferred: 0,
    };

    for (;;) {
      if (this.signal?.aborted) break;

      const { rows } = await getPool().query<PendingFileRow>(
        `SELECT * FROM migration_files
          WHERE tenant_id = $1 AND migration_id = $2
            AND state IN ('DISCOVERED','QUEUED','FAILED')
            AND ($3::text IS NULL OR entity_type = $3::text)
            AND (next_retry_at IS NULL OR next_retry_at <= now())
            AND attempt_count < 5
          ORDER BY created_at
          LIMIT $4`,
        [context.tenantId, context.migrationId, options.entity ?? null, batchSize],
      );

      if (rows.length === 0) break;
      summary.discovered += rows.length;

      const results = await mapWithConcurrency(rows, this.concurrency, (row) => this.transferOne(context, row));

      for (const result of results) {
        summary.uploaded += result.uploaded ? 1 : 0;
        summary.skipped += result.skipped ? 1 : 0;
        summary.failed += result.failed ? 1 : 0;
        summary.unsupported += result.unsupported ? 1 : 0;
        summary.bytesTransferred += result.bytes;
      }
    }

    return summary;
  }

  private async transferOne(context: AdapterContext, row: PendingFileRow): Promise<TransferOutcome> {
    const log = this.logger.child({
      migration_id: context.migrationId, tenant_id: context.tenantId,
      entity: row.entity_type, source_id: row.source_file_id,
    });

    try {
      // --- validate before spending bandwidth ---------------------------
      const rejection = this.rejectUnsupported(row);
      if (rejection) {
        await this.markFile(row.id, 'UNSUPPORTED', {
          failureCode: 'UNSUPPORTED_FIELD', failureReason: rejection,
        });
        await this.logFileProblem(context, row, new MigrationError('UNSUPPORTED_FIELD', rejection, {
          entity: row.entity_type, sourceId: row.source_file_id,
        }), 'warning');
        return { uploaded: false, skipped: false, failed: false, unsupported: true, bytes: 0 };
      }

      // --- resolve the parent -------------------------------------------
      // A file whose parent never migrated has nowhere to attach. Uploading it
      // anyway would produce exactly the "files without parent records" defect
      // Scope §39 asks reconciliation to detect.
      let parentBuilderLyncId: string | null = null;
      if (row.parent_entity_type && row.parent_source_id) {
        const resolved = await recordsRepo.resolveDestinationIds(
          context.tenantId, this.adapter.platform, row.parent_entity_type as EntityType, [row.parent_source_id],
        );
        parentBuilderLyncId = resolved.get(row.parent_source_id) ?? null;

        if (!parentBuilderLyncId) {
          const error = new MigrationError(
            'DEPENDENCY_MISSING',
            `Parent ${row.parent_entity_type} "${row.parent_source_id}" has not been migrated, so this asset cannot be attached.`,
            { entity: row.entity_type, sourceId: row.source_file_id },
          );
          await this.markFile(row.id, 'FAILED', {
            failureCode: error.code, failureReason: error.message, incrementAttempt: true, scheduleRetry: true,
          });
          await this.logFileProblem(context, row, error, 'error');
          return { uploaded: false, skipped: false, failed: true, unsupported: false, bytes: 0 };
        }
      }

      // --- download (Guide §14.2) ----------------------------------------
      if (!this.adapter.downloadFile) {
        throw new MigrationError('FILE_DOWNLOAD_ERROR', `Adapter ${this.adapter.platform} does not implement downloadFile()`, {
          entity: row.entity_type, sourceId: row.source_file_id,
        });
      }

      const downloaded = await withRetry(
        async () => {
          await this.limiter.acquire();
          return this.adapter.downloadFile!(context, { sourceId: row.source_file_id, url: row.source_url });
        },
        retryOptionsFrom(this.adapter.rateLimit, {
          signal: this.signal,
          onRetry: ({ attempt, delayMs, error }) => {
            metrics.increment('migration_retry_total', { entity: row.entity_type, code: error.code, level: 'file' });
            log.warn('Retrying asset download', { attempt, delay_ms: delayMs, error_code: error.code });
          },
        }),
      );

      if (downloaded.content.byteLength === 0) {
        throw new MigrationError('FILE_DOWNLOAD_ERROR', 'Source returned an empty asset body', {
          entity: row.entity_type, sourceId: row.source_file_id,
        });
      }
      if (downloaded.content.byteLength > this.maxFileBytes) {
        throw new MigrationError(
          'FILE_UPLOAD_ERROR',
          `Asset is ${downloaded.content.byteLength} bytes, above the ${this.maxFileBytes}-byte limit`,
          { entity: row.entity_type, sourceId: row.source_file_id },
          { retryable: false },
        );
      }

      await this.markFile(row.id, 'PROCESSING', { downloadStatus: 'COMPLETE' });

      // --- hash and upload (Guide §14.4, Scope §23) ----------------------
      const sourceHash = createHash('sha256').update(downloaded.content).digest('hex');

      const uploaded = await withRetry(
        () =>
          this.destination.uploadFile({
            tenantId: context.tenantId,
            migrationId: context.migrationId,
            idempotencyKey: idempotencyKey({
              migrationId: context.migrationId,
              sourcePlatform: this.adapter.platform,
              objectType: row.entity_type,
              sourceObjectId: row.source_file_id,
            }),
            fileName: downloaded.fileName ?? row.source_filename ?? row.source_file_id,
            originalName: row.source_filename,
            mimeType: downloaded.mimeType ?? row.mime_type,
            kind: kindFor(row.entity_type),
            content: downloaded.content,
            contentHash: sourceHash,
            parentEntityType: row.parent_entity_type,
            parentBuilderLyncId,
            uploadedByUserId: null,
            sourceCreatedAt: null,
            externalSourcePlatform: this.adapter.platform,
            externalSourceId: row.source_file_id,
          }),
        retryOptionsFrom(this.adapter.rateLimit, { signal: this.signal }),
      );

      // Scope §23: true integrity validation compares what we sent with what
      // the destination says it stored, rather than assuming a 200 means intact.
      if (uploaded.destination_hash !== sourceHash) {
        throw new MigrationError(
          'FILE_UPLOAD_ERROR',
          `Integrity check failed: source hash ${sourceHash.slice(0, 12)} != destination hash ${uploaded.destination_hash.slice(0, 12)}`,
          { entity: row.entity_type, sourceId: row.source_file_id },
        );
      }

      await getPool().query(
        `UPDATE migration_files
            SET state = 'CREATED', download_status = 'COMPLETE', upload_status = 'COMPLETE',
                source_hash = $2, destination_hash = $3, destination_file_id = $4,
                destination_url = $5, destination_size_bytes = $6,
                parent_builderlync_id = $7, failure_reason = NULL, failure_code = NULL,
                next_retry_at = NULL, updated_at = now()
          WHERE id = $1`,
        [
          row.id, sourceHash, uploaded.destination_hash, uploaded.builderlync_file_id,
          uploaded.destination_url, uploaded.size_bytes, parentBuilderLyncId,
        ],
      );

      metrics.increment('migration_files_processed_total', { entity: row.entity_type, result: 'uploaded' });
      return { uploaded: true, skipped: false, failed: false, unsupported: false, bytes: uploaded.size_bytes };
    } catch (err) {
      const error = toMigrationError(err, { entity: row.entity_type, sourceId: row.source_file_id });
      await this.markFile(row.id, 'FAILED', {
        failureCode: error.code,
        failureReason: error.message,
        incrementAttempt: true,
        scheduleRetry: error.retryable,
      });
      await this.logFileProblem(context, row, error, 'error');
      metrics.increment('migration_files_processed_total', { entity: row.entity_type, result: 'failed' });
      return { uploaded: false, skipped: false, failed: true, unsupported: false, bytes: 0 };
    }
  }

  /** Guide §14.2: reject unsafe extensions and implausible metadata up front. */
  private rejectUnsupported(row: PendingFileRow): string | null {
    const name = row.source_filename ?? '';
    const extension = extname(name).toLowerCase();

    if (BLOCKED_EXTENSIONS.has(extension)) {
      return `File extension "${extension}" is not an accepted asset type.`;
    }
    if (row.mime_type && !ALLOWED_MIME_PREFIXES.some((p) => row.mime_type?.startsWith(p))) {
      return `MIME type "${row.mime_type}" is not an accepted asset type.`;
    }
    if (row.source_size_bytes !== null && row.source_size_bytes > this.maxFileBytes) {
      return `Source reports ${row.source_size_bytes} bytes, above the ${this.maxFileBytes}-byte limit.`;
    }
    return null;
  }

  private async markFile(
    id: string,
    state: string,
    options: {
      failureCode?: string;
      failureReason?: string;
      downloadStatus?: string;
      incrementAttempt?: boolean;
      scheduleRetry?: boolean;
    } = {},
  ): Promise<void> {
    await getPool().query(
      `UPDATE migration_files
          SET state = $2,
              failure_code = $3,
              failure_reason = $4,
              download_status = coalesce($5, download_status),
              attempt_count = attempt_count + CASE WHEN $6::boolean THEN 1 ELSE 0 END,
              next_retry_at = CASE WHEN $7::boolean
                                   THEN now() + (interval '30 seconds' * power(2, least(attempt_count, 4)))
                                   ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [
        id, state, options.failureCode ?? null, options.failureReason?.slice(0, 2000) ?? null,
        options.downloadStatus ?? null, options.incrementAttempt ?? false, options.scheduleRetry ?? false,
      ],
    );
  }

  private async logFileProblem(
    context: AdapterContext,
    row: PendingFileRow,
    error: MigrationError,
    severity: 'error' | 'warning',
  ): Promise<void> {
    await withTransaction((client) =>
      severity === 'error'
        ? errorsRepo.recordError(client, {
            migrationId: context.migrationId, tenantId: context.tenantId,
            entity: row.entity_type, sourceId: row.source_file_id, error,
          })
        : errorsRepo.recordWarning(client, {
            migrationId: context.migrationId, tenantId: context.tenantId,
            entity: row.entity_type, sourceId: row.source_file_id,
            code: error.code, message: error.message,
          }),
    );
  }
}

interface PendingFileRow {
  id: string;
  migration_id: string;
  tenant_id: string;
  entity_type: EntityType;
  source_file_id: string;
  source_filename: string | null;
  source_url: string | null;
  source_size_bytes: number | null;
  mime_type: string | null;
  parent_entity_type: string | null;
  parent_source_id: string | null;
  attempt_count: number;
}

interface TransferOutcome {
  uploaded: boolean;
  skipped: boolean;
  failed: boolean;
  unsupported: boolean;
  bytes: number;
}

function kindFor(entity: EntityType): 'document' | 'image' | 'attachment' {
  if (entity === 'image') return 'image';
  if (entity === 'attachment') return 'attachment';
  return 'document';
}

/** File reconciliation counts (Guide §17.3). */
export async function fileCounts(tenantId: string, migrationId: string): Promise<{
  discovered: number; uploaded: number; failed: number; unsupported: number; pending: number;
}> {
  const { rows } = await getPool().query<{
    discovered: number; uploaded: number; failed: number; unsupported: number; pending: number;
  }>(
    `SELECT count(*)::int                                       AS discovered,
            count(*) FILTER (WHERE state = 'CREATED')::int       AS uploaded,
            count(*) FILTER (WHERE state = 'FAILED')::int        AS failed,
            count(*) FILTER (WHERE state = 'UNSUPPORTED')::int   AS unsupported,
            count(*) FILTER (WHERE state IN ('DISCOVERED','QUEUED','PROCESSING'))::int AS pending
       FROM migration_files
      WHERE tenant_id = $1 AND migration_id = $2`,
    [tenantId, migrationId],
  );
  return rows[0] ?? { discovered: 0, uploaded: 0, failed: 0, unsupported: 0, pending: 0 };
}
