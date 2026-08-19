import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PoolClient } from 'pg';
import { config } from '../config.js';
import { getPool, withTransaction } from '../db/pool.js';
import type { EntityType } from '../domain/entities.js';
import { addressKey, normalizeNameKey } from '../transformers/normalize.js';
import type {
  BatchRecordResult, BatchRequest, BatchResponse, ContactCandidate, ContactLookupCriteria,
  DestinationClient, DestinationCounts, FileUploadRequest, FileUploadResult,
  RelationshipIntegrityReport,
} from './types.js';

/**
 * Sandbox destination driver: a working implementation of the BuilderLync
 * ingestion contract, backed by the bl_* tables.
 *
 * It exists to make the engine's guarantees demonstrable before BuilderLync's
 * own endpoints exist, and it implements them for real rather than by
 * pretending:
 *
 *   * Idempotency (Guide §1.3) via the bl_idempotency_keys ledger.
 *   * Per-record batch results (Scope §44) -- one bad record fails alone.
 *   * Tenant enforcement (Scope §47) -- checked here as well as in the API,
 *     because "the destination trusted the caller" is exactly the failure the
 *     requirement is written against.
 *   * created_by_migration_id / updated_by_migration_id tagging (Scope §63).
 *
 * This module is the ONLY place in the codebase permitted to reference bl_*.
 */

interface EntityWriter {
  table: string;
  /** Maps a canonical payload to a destination column set. */
  toRow(payload: Record<string, unknown>, ctx: WriteContext): Record<string, unknown>;
}

interface WriteContext {
  tenantId: string;
  migrationId: string;
  sourcePlatform: string;
  sourceId: string;
}

export class SandboxDestination implements DestinationClient {
  readonly driver = 'sandbox' as const;
  readonly apiVersion: string;

  constructor(apiVersion = 'sandbox-v1') {
    this.apiVersion = apiVersion;
  }

  async writeBatch(request: BatchRequest): Promise<BatchResponse> {
    const writer = WRITERS[request.entity];
    if (!writer) {
      return {
        results: request.records.map((r) => ({
          source_id: r.sourceId,
          status: 'UNSUPPORTED' as const,
          builderlync_id: null,
          error: {
            code: 'UNSUPPORTED_FIELD',
            message: `BuilderLync ingestion does not accept entity "${request.entity}"`,
            retryable: false,
          },
        })),
      };
    }

    const results: BatchRecordResult[] = [];

    // Each record commits in its own transaction. Scope §44: one malformed
    // record must not roll back the 499 valid ones beside it.
    for (const record of request.records) {
      try {
        const result = await withTransaction((client) =>
          this.writeOne(client, writer, request, record),
        );
        results.push(result);
      } catch (err) {
        results.push({
          source_id: record.sourceId,
          status: 'FAILED',
          builderlync_id: null,
          error: {
            code: 'BUILDERLYNC_API_ERROR',
            message: (err as Error).message,
            // A constraint violation is deterministic; retrying repeats it.
            retryable: !isDeterministicWriteFailure(err),
          },
        });
      }
    }

    return { results };
  }

  private async writeOne(
    client: PoolClient,
    writer: EntityWriter,
    request: BatchRequest,
    record: BatchRequest['records'][number],
  ): Promise<BatchRecordResult> {
    // --- Idempotency replay (Guide §1.3) ---------------------------------
    const existing = await client.query<{ object_id: string; result_status: string; content_hash: string | null }>(
      'SELECT object_id, result_status, content_hash FROM bl_idempotency_keys WHERE idempotency_key = $1',
      [record.idempotencyKey],
    );

    if (existing.rowCount && existing.rows[0]) {
      const prior = existing.rows[0];
      // Same key, same content: return the stored outcome, write nothing.
      if (prior.content_hash === record.contentHash) {
        return {
          source_id: record.sourceId,
          status: prior.result_status as BatchRecordResult['status'],
          builderlync_id: prior.object_id,
          idempotent_replay: true,
        };
      }
      // Same key, changed content: this is a delta update, not a duplicate.
      const updated = await this.applyRow(client, writer, request, record, prior.object_id, 'UPDATE');
      await client.query(
        'UPDATE bl_idempotency_keys SET result_status = $2, content_hash = $3 WHERE idempotency_key = $1',
        [record.idempotencyKey, 'UPDATED', record.contentHash],
      );
      return { source_id: record.sourceId, status: 'UPDATED', builderlync_id: updated };
    }

    // --- External-identity replay ----------------------------------------
    // A different migration may already have imported this exact source object
    // (Scope §3.2). The idempotency key embeds the migration id, so it would
    // miss that; external_source_* would not.
    const byExternal = await client.query<{ id: string }>(
      `SELECT id FROM ${writer.table}
        WHERE tenant_id = $1 AND external_source_platform = $2 AND external_source_id = $3
        LIMIT 1`,
      [request.tenantId, sourcePlatformOf(record.payload), record.sourceId],
    );

    let objectId: string;
    let status: BatchRecordResult['status'];

    if (byExternal.rowCount && byExternal.rows[0]) {
      objectId = byExternal.rows[0].id;
      await this.applyRow(client, writer, request, record, objectId, 'UPDATE');
      status = 'UPDATED';
    } else {
      objectId = `bl_${request.entity}_${randomUUID()}`;
      await this.applyRow(client, writer, request, record, objectId, 'INSERT');
      status = 'CREATED';
    }

    await client.query(
      `INSERT INTO bl_idempotency_keys (idempotency_key, tenant_id, object_type, object_id, result_status, content_hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [record.idempotencyKey, request.tenantId, request.entity, objectId, status, record.contentHash],
    );

    return { source_id: record.sourceId, status, builderlync_id: objectId };
  }

  private async applyRow(
    client: PoolClient,
    writer: EntityWriter,
    request: BatchRequest,
    record: BatchRequest['records'][number],
    objectId: string,
    mode: 'INSERT' | 'UPDATE',
  ): Promise<string> {
    const ctx: WriteContext = {
      tenantId: request.tenantId,
      migrationId: request.migrationId,
      sourcePlatform: sourcePlatformOf(record.payload) ?? 'unknown',
      sourceId: record.sourceId,
    };

    // Scope §47: the destination independently verifies tenancy rather than
    // trusting that the caller already did.
    const payloadTenant = record.payload['tenant_id'];
    if (typeof payloadTenant === 'string' && payloadTenant !== request.tenantId) {
      throw new Error(`Tenant mismatch: payload targets "${payloadTenant}", request is scoped to "${request.tenantId}"`);
    }

    const row = writer.toRow(record.payload, ctx);
    row['tenant_id'] = request.tenantId;
    row['external_source_platform'] = ctx.sourcePlatform;
    row['external_source_id'] = record.sourceId;

    if (mode === 'INSERT') {
      row['id'] = objectId;
      row['created_by_migration_id'] = request.migrationId;
      const columns = Object.keys(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      await client.query(
        `INSERT INTO ${writer.table} (${columns.map(quote).join(', ')}) VALUES (${placeholders.join(', ')})`,
        Object.values(row),
      );
    } else {
      row['updated_by_migration_id'] = request.migrationId;
      row['updated_at'] = new Date();
      delete row['created_by_migration_id'];
      const columns = Object.keys(row);
      const assignments = columns.map((c, i) => `${quote(c)} = $${i + 1}`);
      await client.query(
        `UPDATE ${writer.table} SET ${assignments.join(', ')} WHERE id = $${columns.length + 1}`,
        [...Object.values(row), objectId],
      );
    }
    return objectId;
  }

  async findContactCandidates(criteria: ContactLookupCriteria): Promise<ContactCandidate[]> {
    const clauses: string[] = [];
    const params: unknown[] = [criteria.tenantId];

    if (criteria.normalizedEmail) {
      params.push(criteria.normalizedEmail);
      clauses.push(`normalized_email = $${params.length}`);
    }
    if (criteria.normalizedPhone) {
      params.push(criteria.normalizedPhone);
      clauses.push(`normalized_phone = $${params.length}`);
    }
    // A name alone is not an identity signal -- "John Smith" collides freely in
    // any contractor CRM -- so a name is only used to fetch candidates when it
    // is paired with an address key that can corroborate it.
    if (criteria.nameKey && criteria.addressKey) {
      params.push(criteria.nameKey);
      const nameParam = params.length;
      params.push(criteria.addressKey);
      clauses.push(`(normalized_name_key = $${nameParam} AND address_key = $${params.length})`);
    }

    if (clauses.length === 0) return [];

    const { rows } = await getPool().query<{
      id: string; normalized_email: string | null; normalized_phone: string | null;
      first_name: string | null; last_name: string | null;
      normalized_name_key: string | null; address_key: string | null;
      external_source_platform: string | null; external_source_id: string | null;
    }>(
      `SELECT id, normalized_email, normalized_phone, first_name, last_name,
              normalized_name_key, address_key, external_source_platform, external_source_id
         FROM bl_contacts
        WHERE tenant_id = $1 AND (${clauses.join(' OR ')})
        LIMIT 25`,
      params,
    );

    return rows.map((r) => ({
      builderlync_id: r.id,
      normalized_email: r.normalized_email,
      normalized_phone: r.normalized_phone,
      first_name: r.first_name,
      last_name: r.last_name,
      address_key: r.address_key,
      external_source_platform: r.external_source_platform,
      external_source_id: r.external_source_id,
    }));
  }

  async uploadFile(request: FileUploadRequest): Promise<FileUploadResult> {
    const pool = getPool();

    const existing = await pool.query<{ object_id: string }>(
      'SELECT object_id FROM bl_idempotency_keys WHERE idempotency_key = $1',
      [request.idempotencyKey],
    );
    if (existing.rowCount && existing.rows[0]) {
      const fileId = existing.rows[0].object_id;
      const { rows } = await pool.query<{ content_hash: string; storage_key: string; size_bytes: number }>(
        'SELECT content_hash, storage_key, size_bytes FROM bl_files WHERE id = $1',
        [fileId],
      );
      const row = rows[0];
      if (row) {
        return {
          builderlync_file_id: fileId,
          destination_hash: row.content_hash,
          destination_url: row.storage_key,
          size_bytes: row.size_bytes,
          idempotent_replay: true,
        };
      }
    }

    // Scope §23: hash what was actually stored, not what the source claimed.
    const destinationHash = createHash('sha256').update(request.content).digest('hex');
    const fileId = `bl_file_${randomUUID()}`;
    const storageKey = join(
      config().FILE_STORAGE_ROOT,
      request.tenantId,
      request.migrationId,
      `${fileId}-${sanitizeFileName(request.fileName)}`,
    );

    await mkdir(dirname(storageKey), { recursive: true });
    await writeFile(storageKey, request.content);

    await pool.query(
      `INSERT INTO bl_files (
         id, tenant_id, parent_entity_type, parent_id, file_name, original_name, mime_type,
         size_bytes, storage_key, content_hash, kind, width, height, album,
         uploaded_by_user_id, source_created_at, external_source_platform, external_source_id,
         created_by_migration_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        fileId, request.tenantId, request.parentEntityType, request.parentBuilderLyncId,
        request.fileName, request.originalName, request.mimeType, request.content.byteLength,
        storageKey, destinationHash, request.kind, request.width ?? null, request.height ?? null,
        request.album ?? null, request.uploadedByUserId, request.sourceCreatedAt,
        request.externalSourcePlatform, request.externalSourceId, request.migrationId,
      ],
    );

    await pool.query(
      `INSERT INTO bl_idempotency_keys (idempotency_key, tenant_id, object_type, object_id, result_status, content_hash)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING`,
      [request.idempotencyKey, request.tenantId, 'file', fileId, 'CREATED', destinationHash],
    );

    return {
      builderlync_file_id: fileId,
      destination_hash: destinationHash,
      destination_url: storageKey,
      size_bytes: request.content.byteLength,
    };
  }

  async countsForMigration(tenantId: string, migrationId: string): Promise<DestinationCounts[]> {
    const out: DestinationCounts[] = [];
    for (const [entity, writer] of Object.entries(WRITERS) as Array<[EntityType, EntityWriter]>) {
      const hasUpdatedColumn = TABLES_WITH_UPDATED_BY.has(writer.table);
      const { rows } = await getPool().query<{ created: number; updated: number }>(
        `SELECT
           count(*) FILTER (WHERE created_by_migration_id = $2)::int AS created,
           ${hasUpdatedColumn ? 'count(*) FILTER (WHERE updated_by_migration_id = $2)::int' : '0'} AS updated
         FROM ${writer.table} WHERE tenant_id = $1`,
        [tenantId, migrationId],
      );
      const row = rows[0];
      if (row && (row.created > 0 || row.updated > 0)) {
        out.push({ entity, created_by_migration: row.created, updated_by_migration: row.updated });
      }
    }
    return out;
  }

  async relationshipIntegrity(tenantId: string, migrationId: string): Promise<RelationshipIntegrityReport> {
    const pool = getPool();
    const scalar = async (sql: string): Promise<number> => {
      const { rows } = await pool.query<{ n: number }>(sql, [tenantId, migrationId]);
      return rows[0]?.n ?? 0;
    };

    return {
      jobs_without_contact: await scalar(`
        SELECT count(*)::int AS n FROM bl_jobs j
         WHERE j.tenant_id = $1 AND (j.created_by_migration_id = $2 OR j.updated_by_migration_id = $2)
           AND (j.contact_id IS NULL
                OR NOT EXISTS (SELECT 1 FROM bl_contacts c WHERE c.id = j.contact_id AND c.tenant_id = j.tenant_id))`),
      opportunities_without_pipeline: await scalar(`
        SELECT count(*)::int AS n FROM bl_opportunities o
         WHERE o.tenant_id = $1 AND (o.created_by_migration_id = $2 OR o.updated_by_migration_id = $2)
           AND o.pipeline_id IS NULL`),
      jobs_without_assigned_user: await scalar(`
        SELECT count(*)::int AS n FROM bl_jobs j
         WHERE j.tenant_id = $1 AND (j.created_by_migration_id = $2 OR j.updated_by_migration_id = $2)
           AND jsonb_array_length(coalesce(j.assigned_user_ids, '[]'::jsonb)) = 0`),
      files_without_parent: await scalar(`
        SELECT count(*)::int AS n FROM bl_files f
         WHERE f.tenant_id = $1 AND f.created_by_migration_id = $2
           AND (f.parent_id IS NULL OR f.parent_entity_type IS NULL)`),
      contacts_without_jobs: await scalar(`
        SELECT count(*)::int AS n FROM bl_contacts c
         WHERE c.tenant_id = $1 AND c.created_by_migration_id = $2
           AND NOT EXISTS (SELECT 1 FROM bl_jobs j WHERE j.contact_id = c.id)`),
      records_referencing_missing_user: await scalar(`
        SELECT count(*)::int AS n FROM bl_contacts c
         WHERE c.tenant_id = $1 AND (c.created_by_migration_id = $2 OR c.updated_by_migration_id = $2)
           AND c.assigned_user_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM bl_users u WHERE u.id = c.assigned_user_id AND u.tenant_id = c.tenant_id)`),
    };
  }

  async resolveId(tenantId: string, entity: EntityType, builderLyncId: string): Promise<boolean> {
    const writer = WRITERS[entity];
    if (!writer) return false;
    const { rowCount } = await getPool().query(
      `SELECT 1 FROM ${writer.table} WHERE tenant_id = $1 AND id = $2`,
      [tenantId, builderLyncId],
    );
    return (rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------
// Canonical payload -> destination row mapping
// ---------------------------------------------------------------------------

function s(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
function d(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
function n(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function j(value: unknown): string {
  return JSON.stringify(value ?? null);
}
function money(value: unknown): number | null {
  if (value && typeof value === 'object' && 'amount_cents' in value) {
    return n((value as { amount_cents: unknown }).amount_cents);
  }
  return null;
}
function currency(value: unknown): string {
  if (value && typeof value === 'object' && 'currency' in value) {
    return s((value as { currency: unknown }).currency) ?? 'USD';
  }
  return 'USD';
}
function sourcePlatformOf(payload: Record<string, unknown>): string | null {
  return s(payload['source_platform']);
}
function quote(column: string): string {
  return `"${column}"`;
}
function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
}

/**
 * Postgres error codes that mean "this write will fail identically forever":
 * unique violation, check violation, not-null violation, invalid text
 * representation. Retrying these burns quota to reproduce the same failure.
 */
function isDeterministicWriteFailure(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === '23505' || code === '23514' || code === '23502' || code === '22P02' || code === '23503';
}

const TABLES_WITH_UPDATED_BY = new Set([
  'bl_accounts', 'bl_locations', 'bl_users', 'bl_companies', 'bl_contacts',
  'bl_pipelines', 'bl_pipeline_stages', 'bl_opportunities', 'bl_jobs', 'bl_notes',
  'bl_tags', 'bl_custom_fields',
]);

const WRITERS: Partial<Record<EntityType, EntityWriter>> = {
  account: {
    table: 'bl_accounts',
    toRow: (p) => ({
      name: s(p['name']) ?? 'Unnamed Account',
      legal_name: s(p['legal_name']),
      phone: s(p['phone']),
      email: s(p['email']),
      website: s(p['website']),
      address_json: j(p['address']),
    }),
  },
  location: {
    table: 'bl_locations',
    toRow: (p) => ({
      name: s(p['name']) ?? 'Unnamed Location',
      branch_code: s(p['branch_code']),
      phone: s(p['phone']),
      address_json: j(p['address']),
      is_active: p['is_active'] !== false,
    }),
  },
  user: {
    table: 'bl_users',
    toRow: (p) => ({
      first_name: s(p['first_name']),
      last_name: s(p['last_name']),
      email: s(p['email']),
      phone: s(p['phone']),
      role: s(p['role']),
      source_role: s(p['source_role']),
      team: s(p['team']),
      is_active: p['is_active'] !== false,
      is_historical: p['is_historical'] === true,
    }),
  },
  tag: {
    table: 'bl_tags',
    toRow: (p) => ({ name: s(p['name']) ?? 'untitled', color: s(p['color']) }),
  },
  custom_field: {
    table: 'bl_custom_fields',
    toRow: (p) => ({
      entity_type: s(p['entity_type']) ?? 'contact',
      key: s(p['key']) ?? 'unknown',
      label: s(p['label']),
      field_type: s(p['field_type']) ?? 'text',
      options: j(p['options'] ?? []),
    }),
  },
  pipeline: {
    table: 'bl_pipelines',
    toRow: (p) => ({ name: s(p['name']) ?? 'Pipeline', is_active: p['is_active'] !== false }),
  },
  pipeline_stage: {
    table: 'bl_pipeline_stages',
    toRow: (p) => ({
      name: s(p['name']) ?? 'Stage',
      pipeline_id: s(p['pipeline_builderlync_id']),
      position: n(p['position']) ?? 0,
      is_won: p['is_won'] === true,
      is_lost: p['is_lost'] === true,
    }),
  },
  company: {
    table: 'bl_companies',
    toRow: (p) => ({
      name: s(p['name']) ?? 'Unnamed Company',
      phone: s(p['phone']),
      email: s(p['email']),
      website: s(p['website']),
      address_json: j(p['address']),
      assigned_user_id: s(p['assigned_user_builderlync_id']),
    }),
  },
  contact: {
    table: 'bl_contacts',
    toRow: (p) => ({
      first_name: s(p['first_name']),
      last_name: s(p['last_name']),
      company_name: s(p['company_name']),
      company_id: s(p['company_builderlync_id']),
      email: s(p['email']),
      phone: s(p['phone']),
      secondary_emails: j(p['secondary_emails'] ?? []),
      secondary_phones: j(p['secondary_phones'] ?? []),
      address_json: j(p['address']),
      lead_source: s(p['lead_source']),
      assigned_user_id: s(p['assigned_user_builderlync_id']),
      tags: j(p['tags'] ?? []),
      custom_fields: j(p['custom_fields'] ?? {}),
      communication_prefs: j(p['communication_prefs'] ?? {}),
      normalized_email: s(p['normalized_email']),
      normalized_phone: s(p['normalized_phone']),
      // Match keys are derived here, by the destination, so both sides of a
      // duplicate comparison are normalized by identical rules (Guide §13.1).
      normalized_name_key: normalizeNameKey([s(p['first_name']), s(p['last_name'])].filter(Boolean).join(' ')),
      address_key: addressKey((p['address'] as never) ?? null),
      source_created_at: d(p['source_created_at']),
      source_updated_at: d(p['source_updated_at']),
    }),
  },
  opportunity: {
    table: 'bl_opportunities',
    toRow: (p) => ({
      name: s(p['name']),
      contact_id: s(p['contact_builderlync_id']),
      pipeline_id: s(p['pipeline_builderlync_id']),
      stage_id: s(p['stage_builderlync_id']),
      status: s(p['status']),
      value_cents: money(p['value']),
      currency: currency(p['value']),
      assigned_user_id: s(p['assigned_user_builderlync_id']),
      lead_source: s(p['lead_source']),
      lost_reason: s(p['lost_reason']),
      closed_at: d(p['closed_at']),
      source_created_at: d(p['source_created_at']),
      source_updated_at: d(p['source_updated_at']),
      custom_fields: j(p['custom_fields'] ?? {}),
    }),
  },
  job: {
    table: 'bl_jobs',
    toRow: (p) => ({
      job_number: s(p['job_number']),
      name: s(p['name']),
      contact_id: s(p['contact_builderlync_id']),
      opportunity_id: s(p['opportunity_builderlync_id']),
      address_json: j(p['address']),
      job_type: s(p['job_type']),
      status: s(p['status']),
      stage_id: s(p['stage_builderlync_id']),
      value_cents: money(p['value']),
      currency: currency(p['value']),
      lead_source: s(p['lead_source']),
      start_date: d(p['start_date']),
      completion_date: d(p['completion_date']),
      assigned_user_ids: j(p['assigned_user_builderlync_ids'] ?? []),
      tags: j(p['tags'] ?? []),
      custom_fields: j(p['custom_fields'] ?? {}),
      source_created_at: d(p['source_created_at']),
      source_updated_at: d(p['source_updated_at']),
    }),
  },
  note: {
    table: 'bl_notes',
    toRow: (p) => ({
      parent_entity_type: s(p['parent_entity_type']),
      parent_id: s(p['parent_builderlync_id']),
      body: s(p['body']),
      body_format: s(p['body_format']) ?? 'text',
      authored_at: d(p['authored_at']),
      author_user_id: s(p['author_user_builderlync_id']),
      author_source_name: s(p['author_source_name']),
    }),
  },
  activity: {
    table: 'bl_activities',
    toRow: (p) => ({
      parent_entity_type: s(p['parent_entity_type']),
      parent_id: s(p['parent_builderlync_id']),
      activity_type: s(p['activity_type']) ?? 'other',
      subject: s(p['subject']),
      body: s(p['body']),
      direction: s(p['direction']),
      occurred_at: d(p['occurred_at']),
      user_id: s(p['user_builderlync_id']),
      author_source_name: s(p['author_source_name']),
      metadata: j(p['metadata'] ?? {}),
    }),
  },
  task: {
    table: 'bl_tasks',
    toRow: (p) => ({
      parent_entity_type: s(p['parent_entity_type']),
      parent_id: s(p['parent_builderlync_id']),
      title: s(p['title']),
      description: s(p['description']),
      status: s(p['status']),
      due_at: d(p['due_at']),
      completed_at: d(p['completed_at']),
      assigned_user_id: s(p['assigned_user_builderlync_id']),
    }),
  },
  appointment: {
    table: 'bl_appointments',
    toRow: (p) => ({
      parent_entity_type: s(p['parent_entity_type']),
      parent_id: s(p['parent_builderlync_id']),
      title: s(p['title']),
      location: s(p['location']),
      starts_at: d(p['starts_at']),
      ends_at: d(p['ends_at']),
      assigned_user_id: s(p['assigned_user_builderlync_id']),
      status: s(p['status']),
    }),
  },
};

/** Exposed so reconciliation can ask which entities the destination accepts. */
export function sandboxSupportedEntities(): EntityType[] {
  return Object.keys(WRITERS) as EntityType[];
}
