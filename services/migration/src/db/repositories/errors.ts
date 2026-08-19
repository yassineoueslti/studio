import { getPool, type Sql } from '../pool.js';
import { ERROR_PROFILES, type ErrorCode, type MigrationError } from '../../domain/errors.js';
import type { EntityType } from '../../domain/entities.js';

/**
 * Error and warning persistence, and the discovery/validation result tables.
 *
 * Scope §35 requires the error dashboard to filter by entity, error type,
 * source id, retryable status and resolution state -- so those are columns,
 * not fields buried inside a JSON blob.
 */

export interface ErrorRow {
  id: string;
  migration_id: string;
  batch_id: string | null;
  entity: string | null;
  source_id: string | null;
  error_code: ErrorCode;
  message: string;
  retryable: boolean;
  raw_context: Record<string, unknown> | null;
  attempt_count: number;
  resolution_status: string;
  created_at: Date;
}

export async function recordError(
  sql: Sql,
  input: {
    migrationId: string;
    tenantId: string;
    batchId?: string | null;
    entity?: string | null;
    sourceId?: string | null;
    error: MigrationError;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO migration_errors
       (migration_id, tenant_id, batch_id, entity, source_id, error_code, message, retryable, raw_context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      input.migrationId, input.tenantId, input.batchId ?? null,
      input.entity ?? input.error.context.entity ?? null,
      input.sourceId ?? input.error.context.sourceId ?? null,
      input.error.code,
      // Truncated: an error message is a diagnostic, not a payload dump, and
      // an unbounded vendor error body can be megabytes.
      input.error.message.slice(0, 4000),
      input.error.retryable,
      JSON.stringify(input.error.context.raw ?? {}),
    ],
  );
}

export async function recordWarning(
  sql: Sql,
  input: {
    migrationId: string;
    tenantId: string;
    batchId?: string | null;
    entity?: string | null;
    sourceId?: string | null;
    code: string;
    message: string;
    context?: Record<string, unknown>;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO migration_warnings (migration_id, tenant_id, batch_id, entity, source_id, warning_code, message, raw_context)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      input.migrationId, input.tenantId, input.batchId ?? null, input.entity ?? null,
      input.sourceId ?? null, input.code, input.message.slice(0, 4000), JSON.stringify(input.context ?? {}),
    ],
  );
}

export interface ErrorFilter {
  entity?: string;
  errorCode?: ErrorCode;
  sourceId?: string;
  retryable?: boolean;
  resolutionStatus?: string;
  limit?: number;
  offset?: number;
}

export async function listErrors(tenantId: string, migrationId: string, filter: ErrorFilter = {}): Promise<ErrorRow[]> {
  const { rows } = await getPool().query<ErrorRow>(
    `SELECT * FROM migration_errors
      WHERE tenant_id = $1 AND migration_id = $2
        AND ($3::text    IS NULL OR entity = $3::text)
        AND ($4::text    IS NULL OR error_code = $4::text)
        AND ($5::text    IS NULL OR source_id = $5::text)
        AND ($6::boolean IS NULL OR retryable = $6::boolean)
        AND ($7::text    IS NULL OR resolution_status = $7::text)
      ORDER BY created_at DESC
      LIMIT $8 OFFSET $9`,
    [
      tenantId, migrationId, filter.entity ?? null, filter.errorCode ?? null, filter.sourceId ?? null,
      filter.retryable ?? null, filter.resolutionStatus ?? null, filter.limit ?? 200, filter.offset ?? 0,
    ],
  );
  return rows;
}

export async function summarizeErrors(
  tenantId: string,
  migrationId: string,
): Promise<Array<{ error_code: ErrorCode; entity: string | null; count: number; retryable: boolean; summary: string }>> {
  const { rows } = await getPool().query<{ error_code: ErrorCode; entity: string | null; count: number; retryable: boolean }>(
    `SELECT error_code, entity, count(*)::int AS count, bool_or(retryable) AS retryable
       FROM migration_errors
      WHERE tenant_id = $1 AND migration_id = $2 AND resolution_status = 'OPEN'
      GROUP BY error_code, entity
      ORDER BY count DESC`,
    [tenantId, migrationId],
  );
  return rows.map((r) => ({ ...r, summary: ERROR_PROFILES[r.error_code]?.summary ?? 'Unclassified error.' }));
}

export async function summarizeWarnings(
  tenantId: string,
  migrationId: string,
): Promise<Array<{ warning_code: string; entity: string | null; count: number }>> {
  const { rows } = await getPool().query<{ warning_code: string; entity: string | null; count: number }>(
    `SELECT warning_code, entity, count(*)::int AS count
       FROM migration_warnings
      WHERE tenant_id = $1 AND migration_id = $2
      GROUP BY warning_code, entity
      ORDER BY count DESC`,
    [tenantId, migrationId],
  );
  return rows;
}

/** Mark open errors resolved after a successful retry. */
export async function markErrorsRetried(
  sql: Sql,
  migrationId: string,
  entity: EntityType,
  sourceIds: readonly string[],
): Promise<void> {
  if (sourceIds.length === 0) return;
  await sql.query(
    `UPDATE migration_errors
        SET resolution_status = 'RESOLVED', resolved_at = now(), updated_at = now()
      WHERE migration_id = $1 AND entity = $2 AND source_id = ANY($3::text[]) AND resolution_status = 'OPEN'`,
    [migrationId, entity, sourceIds as string[]],
  );
}

// ---------------------------------------------------------------------------
// Discovery (Scope §15)
// ---------------------------------------------------------------------------

export async function saveDiscovery(
  sql: Sql,
  input: {
    migrationId: string;
    tenantId: string;
    counts: ReadonlyArray<{ entity: EntityType; count: number; supported: boolean; note?: string }>;
  },
): Promise<void> {
  for (const row of input.counts) {
    await sql.query(
      `INSERT INTO migration_discovery (migration_id, tenant_id, entity_type, discovered_count, supported, capability_note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (migration_id, entity_type) DO UPDATE SET
         discovered_count = EXCLUDED.discovered_count,
         supported = EXCLUDED.supported,
         capability_note = EXCLUDED.capability_note`,
      [input.migrationId, input.tenantId, row.entity, row.count, row.supported, row.note ?? null],
    );
  }
}

export interface DiscoveryRow {
  entity_type: EntityType;
  discovered_count: number;
  supported: boolean;
  capability_note: string | null;
}

export async function getDiscovery(tenantId: string, migrationId: string): Promise<DiscoveryRow[]> {
  const { rows } = await getPool().query<DiscoveryRow>(
    'SELECT entity_type, discovered_count, supported, capability_note FROM migration_discovery WHERE tenant_id = $1 AND migration_id = $2 ORDER BY entity_type',
    [tenantId, migrationId],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Validation results (Scope §37-39)
// ---------------------------------------------------------------------------

export async function saveValidationResult(
  sql: Sql,
  input: {
    migrationId: string;
    tenantId: string;
    step: string;
    entity?: EntityType | null;
    passed: boolean;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO migration_validation_results (migration_id, tenant_id, validation_step, entity_type, passed, detail_json)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.migrationId, input.tenantId, input.step, input.entity ?? null, input.passed, JSON.stringify(input.detail)],
  );
}

export async function listValidationResults(tenantId: string, migrationId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await getPool().query(
    `SELECT validation_step, entity_type, passed, detail_json, created_at
       FROM migration_validation_results
      WHERE tenant_id = $1 AND migration_id = $2
      ORDER BY created_at DESC`,
    [tenantId, migrationId],
  );
  return rows;
}

/** Clear prior results so a re-run reports current state, not history. */
export async function clearValidationResults(sql: Sql, tenantId: string, migrationId: string): Promise<void> {
  await sql.query('DELETE FROM migration_validation_results WHERE tenant_id = $1 AND migration_id = $2', [tenantId, migrationId]);
}

// ---------------------------------------------------------------------------
// Duplicate candidates (Scope §20)
// ---------------------------------------------------------------------------

export async function recordDuplicateCandidate(
  sql: Sql,
  input: {
    migrationId: string;
    tenantId: string;
    entity: EntityType;
    sourceObjectId: string;
    candidateBuilderLyncId: string | null;
    tier: number;
    confidence: number;
    signals: Record<string, unknown>;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO migration_duplicate_candidates
       (migration_id, tenant_id, entity_type, source_object_id, candidate_builderlync_id, match_tier, match_signals, confidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (migration_id, entity_type, source_object_id, candidate_builderlync_id) DO NOTHING`,
    [
      input.migrationId, input.tenantId, input.entity, input.sourceObjectId,
      input.candidateBuilderLyncId, input.tier, JSON.stringify(input.signals), input.confidence,
    ],
  );
}

/** Guide §13.4: a confirmed decision is reused by retries and delta sync. */
export async function getDuplicateDecisions(
  tenantId: string,
  migrationId: string,
  entity: EntityType,
  sourceIds: readonly string[],
): Promise<Map<string, { decision: string; candidateId: string | null }>> {
  if (sourceIds.length === 0) return new Map();
  const { rows } = await getPool().query<{ source_object_id: string; decision: string; candidate_builderlync_id: string | null }>(
    `SELECT source_object_id, decision, candidate_builderlync_id
       FROM migration_duplicate_candidates
      WHERE tenant_id = $1 AND migration_id = $2 AND entity_type = $3
        AND source_object_id = ANY($4::text[]) AND decision <> 'PENDING'`,
    [tenantId, migrationId, entity, sourceIds as string[]],
  );
  return new Map(rows.map((r) => [r.source_object_id, { decision: r.decision, candidateId: r.candidate_builderlync_id }]));
}

export async function listDuplicateCandidates(
  tenantId: string,
  migrationId: string,
  decision = 'PENDING',
): Promise<Array<Record<string, unknown>>> {
  const { rows } = await getPool().query(
    `SELECT * FROM migration_duplicate_candidates
      WHERE tenant_id = $1 AND migration_id = $2 AND decision = $3
      ORDER BY confidence DESC LIMIT 500`,
    [tenantId, migrationId, decision],
  );
  return rows;
}

export async function resolveDuplicate(
  tenantId: string,
  candidateId: string,
  decision: 'MERGE' | 'CREATE_NEW' | 'SKIP',
  decidedBy: string,
): Promise<void> {
  await getPool().query(
    `UPDATE migration_duplicate_candidates
        SET decision = $3, decided_by = $4, decided_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, candidateId, decision, decidedBy],
  );
}
