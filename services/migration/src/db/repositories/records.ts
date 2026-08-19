import { getPool, withTransaction, type Sql } from '../pool.js';
import type { EntityType } from '../../domain/entities.js';
import type { BatchState, RecordState } from '../../domain/states.js';
import { dispositionForRecordState } from '../../domain/states.js';
import { config } from '../../config.js';

/**
 * The record ledger, batches, checkpoints and the object map.
 *
 * Together these four tables are what make the platform's three headline
 * guarantees true rather than aspirational:
 *   idempotency  -> migration_object_map (unique on source identity)
 *   resumability -> migration_checkpoints + batch states
 *   auditability -> migration_records (one row per discovered source object)
 */

// ---------------------------------------------------------------------------
// Object map (Scope §11) - the idempotency foundation
// ---------------------------------------------------------------------------

export interface ObjectMapRow {
  id: string;
  migration_id: string;
  tenant_id: string;
  source_platform: string;
  source_object_type: string;
  source_object_id: string;
  builderlync_object_type: string;
  builderlync_object_id: string | null;
  content_hash: string | null;
  migration_status: string;
  source_updated_at: Date | null;
}

/**
 * Upsert on the source identity. The ON CONFLICT clause is the mechanism that
 * turns a replayed migration into an update instead of a duplicate -- the
 * unique key is (tenant, platform, object type, source id), so the same source
 * record can only ever hold one destination id per tenant.
 */
export async function upsertObjectMap(
  sql: Sql,
  input: {
    migrationId: string;
    tenantId: string;
    sourcePlatform: string;
    sourceObjectType: string;
    sourceObjectId: string;
    builderLyncObjectType: string;
    builderLyncObjectId: string | null;
    contentHash: string | null;
    migrationStatus: RecordState;
    sourceUpdatedAt: Date | null;
    transformerVersion: string | null;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO migration_object_map (
       migration_id, tenant_id, source_platform, source_object_type, source_object_id,
       builderlync_object_type, builderlync_object_id, content_hash, migration_status,
       source_updated_at, builderlync_updated_at, transformer_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), $11)
     ON CONFLICT (tenant_id, source_platform, source_object_type, source_object_id)
     DO UPDATE SET
       migration_id = EXCLUDED.migration_id,
       builderlync_object_id = coalesce(EXCLUDED.builderlync_object_id, migration_object_map.builderlync_object_id),
       content_hash = EXCLUDED.content_hash,
       migration_status = EXCLUDED.migration_status,
       source_updated_at = EXCLUDED.source_updated_at,
       builderlync_updated_at = now(),
       transformer_version = EXCLUDED.transformer_version,
       updated_at = now()`,
    [
      input.migrationId, input.tenantId, input.sourcePlatform, input.sourceObjectType,
      input.sourceObjectId, input.builderLyncObjectType, input.builderLyncObjectId,
      input.contentHash, input.migrationStatus, input.sourceUpdatedAt, input.transformerVersion,
    ],
  );
}

/** Bulk-load existing mappings for a page of source ids (dedupe tier 1). */
export async function lookupObjectMap(
  tenantId: string,
  sourcePlatform: string,
  sourceObjectType: string,
  sourceObjectIds: readonly string[],
): Promise<Map<string, ObjectMapRow>> {
  if (sourceObjectIds.length === 0) return new Map();
  const { rows } = await getPool().query<ObjectMapRow>(
    `SELECT * FROM migration_object_map
      WHERE tenant_id = $1 AND source_platform = $2 AND source_object_type = $3
        AND source_object_id = ANY($4::text[])`,
    [tenantId, sourcePlatform, sourceObjectType, sourceObjectIds as string[]],
  );
  return new Map(rows.map((r) => [r.source_object_id, r]));
}

/** Resolve source ids to BuilderLync ids, for parent references. */
export async function resolveDestinationIds(
  tenantId: string,
  sourcePlatform: string,
  sourceObjectType: string,
  sourceObjectIds: readonly string[],
): Promise<Map<string, string>> {
  const map = await lookupObjectMap(tenantId, sourcePlatform, sourceObjectType, sourceObjectIds);
  const out = new Map<string, string>();
  for (const [sourceId, row] of map) {
    if (row.builderlync_object_id) out.set(sourceId, row.builderlync_object_id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Batches (Scope §28)
// ---------------------------------------------------------------------------

export interface BatchRow {
  id: string;
  migration_id: string;
  tenant_id: string;
  entity_type: EntityType;
  batch_number: number;
  batch_label: string;
  status: BatchState;
  record_count: number;
  created_count: number;
  updated_count: number;
  merged_count: number;
  skipped_count: number;
  unsupported_count: number;
  failed_count: number;
  retry_count: number;
  cursor_json: unknown;
}

export async function createBatch(
  sql: Sql,
  input: {
    migrationId: string;
    tenantId: string;
    entity: EntityType;
    batchNumber: number;
    recordCount: number;
    cursor: unknown;
  },
): Promise<BatchRow> {
  const label = `${titleCase(input.entity)} Batch ${String(input.batchNumber).padStart(3, '0')}`;
  const { rows } = await sql.query<BatchRow>(
    `INSERT INTO migration_batches (migration_id, tenant_id, entity_type, batch_number, batch_label, record_count, cursor_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (migration_id, entity_type, batch_number)
     DO UPDATE SET record_count = EXCLUDED.record_count, updated_at = now()
     RETURNING *`,
    [input.migrationId, input.tenantId, input.entity, input.batchNumber, label, input.recordCount, JSON.stringify(input.cursor ?? null)],
  );
  return rows[0] as BatchRow;
}

export async function markBatchStarted(sql: Sql, batchId: string): Promise<void> {
  await sql.query(
    `UPDATE migration_batches
        SET status = 'PROCESSING', started_at = coalesce(started_at, now()), updated_at = now()
      WHERE id = $1`,
    [batchId],
  );
}

export async function finishBatch(
  sql: Sql,
  batchId: string,
  counts: { created: number; updated: number; merged: number; skipped: number; unsupported: number; failed: number },
): Promise<void> {
  const status: BatchState = counts.failed > 0 ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED';
  await sql.query(
    `UPDATE migration_batches
        SET status = $2, created_count = $3, updated_count = $4, merged_count = $5,
            skipped_count = $6, unsupported_count = $7, failed_count = $8,
            completed_at = now(), updated_at = now()
      WHERE id = $1`,
    [batchId, status, counts.created, counts.updated, counts.merged, counts.skipped, counts.unsupported, counts.failed],
  );
}

export async function failBatch(sql: Sql, batchId: string): Promise<void> {
  await sql.query(
    `UPDATE migration_batches SET status = 'FAILED', retry_count = retry_count + 1, updated_at = now() WHERE id = $1`,
    [batchId],
  );
}

export async function listBatches(tenantId: string, migrationId: string): Promise<BatchRow[]> {
  const { rows } = await getPool().query<BatchRow>(
    `SELECT * FROM migration_batches WHERE tenant_id = $1 AND migration_id = $2
      ORDER BY entity_type, batch_number`,
    [tenantId, migrationId],
  );
  return rows;
}

/** Scope §29 level 2: batches eligible for retry after a failure. */
export async function findRetryableBatches(tenantId: string, migrationId: string): Promise<BatchRow[]> {
  const { rows } = await getPool().query<BatchRow>(
    `SELECT * FROM migration_batches
      WHERE tenant_id = $1 AND migration_id = $2 AND status IN ('FAILED','COMPLETED_WITH_ERRORS','PROCESSING')
      ORDER BY entity_type, batch_number`,
    [tenantId, migrationId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Checkpoints (Scope §27)
// ---------------------------------------------------------------------------

export interface CheckpointRow {
  migration_id: string;
  tenant_id: string;
  entity_type: EntityType;
  cursor_json: unknown;
  last_source_id: string | null;
  records_processed: number;
  batch_number: number;
  extraction_complete: boolean;
}

export async function saveCheckpoint(
  sql: Sql,
  input: {
    migrationId: string;
    tenantId: string;
    entity: EntityType;
    cursor: unknown;
    lastSourceId: string | null;
    recordsProcessed: number;
    batchNumber: number;
    extractionComplete: boolean;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO migration_checkpoints
       (migration_id, tenant_id, entity_type, cursor_json, last_source_id, records_processed, batch_number, extraction_complete)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (migration_id, entity_type) DO UPDATE SET
       cursor_json = EXCLUDED.cursor_json,
       last_source_id = EXCLUDED.last_source_id,
       records_processed = EXCLUDED.records_processed,
       batch_number = EXCLUDED.batch_number,
       extraction_complete = EXCLUDED.extraction_complete,
       updated_at = now()`,
    [
      input.migrationId, input.tenantId, input.entity, JSON.stringify(input.cursor ?? null),
      input.lastSourceId, input.recordsProcessed, input.batchNumber, input.extractionComplete,
    ],
  );
}

export async function getCheckpoint(
  tenantId: string,
  migrationId: string,
  entity: EntityType,
): Promise<CheckpointRow | null> {
  const { rows } = await getPool().query<CheckpointRow>(
    'SELECT * FROM migration_checkpoints WHERE tenant_id = $1 AND migration_id = $2 AND entity_type = $3',
    [tenantId, migrationId, entity],
  );
  return rows[0] ?? null;
}

export async function listCheckpoints(tenantId: string, migrationId: string): Promise<CheckpointRow[]> {
  const { rows } = await getPool().query<CheckpointRow>(
    'SELECT * FROM migration_checkpoints WHERE tenant_id = $1 AND migration_id = $2 ORDER BY entity_type',
    [tenantId, migrationId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Record ledger (Scope §3.4)
// ---------------------------------------------------------------------------

export interface RecordRow {
  id: string;
  migration_id: string;
  batch_id: string | null;
  tenant_id: string;
  entity_type: EntityType;
  source_object_id: string;
  state: RecordState;
  disposition: string | null;
  builderlync_object_id: string | null;
  content_hash: string | null;
  attempt_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
}

/**
 * Register discovered source records. Called as each page is extracted, before
 * anything is written, so a crash between extraction and loading still leaves
 * every discovered record visible to reconciliation.
 */
export async function registerDiscovered(
  sql: Sql,
  input: {
    migrationId: string;
    tenantId: string;
    entity: EntityType;
    batchId: string;
    records: ReadonlyArray<{ sourceId: string; rawPayload?: unknown }>;
  },
): Promise<void> {
  if (input.records.length === 0) return;

  const retentionDays = config().RAW_PAYLOAD_RETENTION_DAYS;
  const expiresAt = retentionDays > 0 ? new Date(Date.now() + retentionDays * 86_400_000) : null;

  const values: unknown[] = [];
  const tuples: string[] = [];
  input.records.forEach((record, i) => {
    const base = i * 7;
    tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`);
    values.push(
      input.migrationId, input.tenantId, input.entity, input.batchId, record.sourceId,
      // Scope §30: bounded raw retention for troubleshooting.
      retentionDays > 0 && record.rawPayload !== undefined ? JSON.stringify(record.rawPayload) : null,
      expiresAt,
    );
  });

  await sql.query(
    `INSERT INTO migration_records
       (migration_id, tenant_id, entity_type, batch_id, source_object_id, raw_payload, raw_payload_expires_at)
     VALUES ${tuples.join(',')}
     ON CONFLICT (migration_id, entity_type, source_object_id)
     DO UPDATE SET batch_id = EXCLUDED.batch_id, updated_at = now()`,
    values,
  );
}

export interface RecordOutcome {
  sourceId: string;
  state: RecordState;
  builderLyncId: string | null;
  contentHash: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  transformerVersion?: string | null;
}

/** Write the final disposition for a page of records in one statement. */
export async function recordOutcomes(
  sql: Sql,
  input: { migrationId: string; tenantId: string; entity: EntityType; outcomes: readonly RecordOutcome[] },
): Promise<void> {
  if (input.outcomes.length === 0) return;

  const values: unknown[] = [];
  const tuples: string[] = [];
  input.outcomes.forEach((outcome, i) => {
    const base = i * 8;
    tuples.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4}::text,$${base + 5}::text,` +
        `$${base + 6}::text,$${base + 7}::text,$${base + 8}::text)`,
    );
    values.push(
      input.migrationId, input.entity, outcome.sourceId, outcome.state,
      dispositionForRecordState(outcome.state), outcome.builderLyncId,
      outcome.errorCode ?? null, outcome.errorMessage ?? null,
    );
  });

  await sql.query(
    `UPDATE migration_records AS r
        SET state = v.state,
            disposition = v.disposition,
            builderlync_object_id = coalesce(v.builderlync_object_id, r.builderlync_object_id),
            last_error_code = v.error_code,
            last_error_message = v.error_message,
            attempt_count = r.attempt_count + 1,
            updated_at = now()
       FROM (VALUES ${tuples.join(',')}) AS v(
         migration_id, entity_type, source_object_id, state, disposition,
         builderlync_object_id, error_code, error_message)
      WHERE r.migration_id = v.migration_id::uuid
        AND r.entity_type = v.entity_type
        AND r.source_object_id = v.source_object_id`,
    values,
  );
}

export interface EntityCounts {
  entity_type: EntityType;
  discovered: number;
  created: number;
  updated: number;
  merged: number;
  skipped: number;
  unsupported: number;
  failed: number;
  in_flight: number;
}

/**
 * The counts reconciliation is built on (Scope §38). `discovered` is the total
 * ledger size for the entity; the rest partition it. in_flight being non-zero
 * is precisely what blocks a COMPLETED status.
 */
export async function countsByEntity(tenantId: string, migrationId: string): Promise<EntityCounts[]> {
  const { rows } = await getPool().query<EntityCounts>(
    `SELECT entity_type,
            count(*)::int                                          AS discovered,
            count(*) FILTER (WHERE state = 'CREATED')::int          AS created,
            count(*) FILTER (WHERE state = 'UPDATED')::int          AS updated,
            count(*) FILTER (WHERE state = 'MERGED')::int           AS merged,
            count(*) FILTER (WHERE state = 'SKIPPED')::int          AS skipped,
            count(*) FILTER (WHERE state = 'UNSUPPORTED')::int      AS unsupported,
            count(*) FILTER (WHERE state = 'FAILED')::int           AS failed,
            count(*) FILTER (WHERE state IN ('DISCOVERED','QUEUED','PROCESSING'))::int AS in_flight
       FROM migration_records
      WHERE tenant_id = $1 AND migration_id = $2
      GROUP BY entity_type
      ORDER BY entity_type`,
    [tenantId, migrationId],
  );
  return rows;
}

/** Scope §29 level 3: individual failed records eligible for retry. */
export async function findFailedRecords(
  tenantId: string,
  migrationId: string,
  options: { entity?: EntityType; limit?: number } = {},
): Promise<RecordRow[]> {
  const { rows } = await getPool().query<RecordRow>(
    `SELECT * FROM migration_records
      WHERE tenant_id = $1 AND migration_id = $2 AND state = 'FAILED'
        AND ($3::text IS NULL OR entity_type = $3::text)
      ORDER BY entity_type, source_object_id
      LIMIT $4`,
    [tenantId, migrationId, options.entity ?? null, options.limit ?? 1000],
  );
  return rows;
}

/** Support tooling (Scope §64): trace any record back to its source. */
export async function traceRecord(
  tenantId: string,
  query: { sourceId?: string; builderLyncId?: string },
): Promise<Array<Record<string, unknown>>> {
  const { rows } = await getPool().query(
    `SELECT m.id AS migration_id, m.source_platform, m.status AS migration_status,
            r.entity_type, r.source_object_id, r.state, r.disposition,
            r.builderlync_object_id, r.last_error_code, r.last_error_message, r.updated_at
       FROM migration_records r
       JOIN migrations m ON m.id = r.migration_id
      WHERE r.tenant_id = $1
        AND (($2::text IS NOT NULL AND r.source_object_id = $2::text)
          OR ($3::text IS NOT NULL AND r.builderlync_object_id = $3::text))
      ORDER BY r.updated_at DESC LIMIT 100`,
    [tenantId, query.sourceId ?? null, query.builderLyncId ?? null],
  );
  return rows;
}

/** Scope §30: purge raw payloads past their retention window. */
export async function purgeExpiredRawPayloads(): Promise<number> {
  const { rowCount } = await getPool().query(
    `UPDATE migration_records SET raw_payload = NULL
      WHERE raw_payload IS NOT NULL AND raw_payload_expires_at IS NOT NULL AND raw_payload_expires_at < now()`,
  );
  return rowCount ?? 0;
}

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export { withTransaction };
