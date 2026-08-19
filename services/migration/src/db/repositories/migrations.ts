import type { PoolClient } from 'pg';
import { getPool, withTransaction, type Sql } from '../pool.js';
import { assertTransition, type MigrationState } from '../../domain/states.js';
import type { AuditAction } from '../../domain/permissions.js';
import type { SourcePlatform } from '../../canonical/common.js';

export interface MigrationRow {
  id: string;
  tenant_id: string;
  source_platform: string;
  source_tenant_id: string | null;
  status: MigrationState;
  started_at: Date | null;
  completed_at: Date | null;
  created_by: string;
  configuration_json: MigrationConfiguration;
  statistics_json: Record<string, unknown>;
  connector_version: string;
  schema_version: string;
  destination_api_version: string;
  accepted_by: string | null;
  accepted_at: Date | null;
  migration_report_version: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MigrationConfiguration {
  /** Entities the customer selected in wizard step 4. */
  selectedEntities?: string[];
  batchSize?: number;
  fileConcurrency?: number;
  /** Scope §6 conflict rules chosen in wizard step 6. */
  dedupePolicy?: Record<string, unknown>;
  /** Delta run: only pull records changed since this instant. */
  updatedSince?: string | null;
  [key: string]: unknown;
}

export async function createMigration(input: {
  tenantId: string;
  sourcePlatform: SourcePlatform;
  sourceTenantId?: string | null;
  createdBy: string;
  configuration?: MigrationConfiguration;
  connectorVersion?: string;
  schemaVersion?: string;
  destinationApiVersion?: string;
}): Promise<MigrationRow> {
  const { rows } = await getPool().query<MigrationRow>(
    `INSERT INTO migrations
       (tenant_id, source_platform, source_tenant_id, created_by, configuration_json,
        connector_version, schema_version, destination_api_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      input.tenantId,
      input.sourcePlatform,
      input.sourceTenantId ?? null,
      input.createdBy,
      JSON.stringify(input.configuration ?? {}),
      input.connectorVersion ?? 'unknown',
      input.schemaVersion ?? 'unknown',
      input.destinationApiVersion ?? 'unknown',
    ],
  );
  return rows[0] as MigrationRow;
}

/**
 * Tenant-scoped read. Every accessor in this module takes a tenantId and puts
 * it in the WHERE clause: Scope §47 requires that a migration worker cannot
 * reach another customer's migration even if it is handed the right uuid.
 */
export async function getMigration(sql: Sql, tenantId: string, migrationId: string): Promise<MigrationRow | null> {
  const { rows } = await sql.query<MigrationRow>(
    'SELECT * FROM migrations WHERE id = $1 AND tenant_id = $2',
    [migrationId, tenantId],
  );
  return rows[0] ?? null;
}

/** Unscoped read for internal staff tooling (Scope §41). Audit separately. */
export async function getMigrationAsStaff(migrationId: string): Promise<MigrationRow | null> {
  const { rows } = await getPool().query<MigrationRow>('SELECT * FROM migrations WHERE id = $1', [migrationId]);
  return rows[0] ?? null;
}

export async function listMigrations(tenantId: string, limit = 50): Promise<MigrationRow[]> {
  const { rows } = await getPool().query<MigrationRow>(
    'SELECT * FROM migrations WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2',
    [tenantId, limit],
  );
  return rows;
}

/**
 * Advance a migration's state, validating the transition first.
 *
 * The read and the write happen in one transaction with SELECT ... FOR UPDATE
 * so two workers cannot both observe IMPORTING and both move it to VALIDATING.
 */
export async function transitionState(
  tenantId: string,
  migrationId: string,
  next: MigrationState,
  options: { startedAt?: boolean; completedAt?: boolean } = {},
): Promise<MigrationRow> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<MigrationRow>(
      'SELECT * FROM migrations WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [migrationId, tenantId],
    );
    const current = rows[0];
    if (!current) throw new Error(`Migration ${migrationId} not found for tenant ${tenantId}`);

    assertTransition(current.status, next);

    const { rows: updated } = await client.query<MigrationRow>(
      `UPDATE migrations
          SET status = $3,
              started_at = CASE WHEN $4::boolean THEN coalesce(started_at, now()) ELSE started_at END,
              completed_at = CASE WHEN $5::boolean THEN now() ELSE completed_at END,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *`,
      [migrationId, tenantId, next, options.startedAt ?? false, options.completedAt ?? false],
    );
    return updated[0] as MigrationRow;
  });
}

export async function updateStatistics(
  tenantId: string,
  migrationId: string,
  statistics: Record<string, unknown>,
): Promise<void> {
  await getPool().query(
    'UPDATE migrations SET statistics_json = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2',
    [migrationId, tenantId, JSON.stringify(statistics)],
  );
}

export async function updateConfiguration(
  tenantId: string,
  migrationId: string,
  configuration: MigrationConfiguration,
): Promise<void> {
  await getPool().query(
    'UPDATE migrations SET configuration_json = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2',
    [migrationId, tenantId, JSON.stringify(configuration)],
  );
}

export async function acceptMigration(
  tenantId: string,
  migrationId: string,
  acceptedBy: string,
  reportVersion: string,
): Promise<void> {
  await getPool().query(
    `UPDATE migrations SET accepted_by = $3, accepted_at = now(), migration_report_version = $4, updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [migrationId, tenantId, acceptedBy, reportVersion],
  );
}

/** Scope §16: refuse to start while another migration is mid-flight. */
export async function findActiveMigrations(
  tenantId: string,
  activeStates: readonly string[],
  excludeId?: string,
): Promise<MigrationRow[]> {
  const { rows } = await getPool().query<MigrationRow>(
    `SELECT * FROM migrations
      WHERE tenant_id = $1 AND status = ANY($2::text[]) AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [tenantId, activeStates, excludeId ?? null],
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Audit log (Scope §49)
// ---------------------------------------------------------------------------

export async function recordAudit(
  sql: Sql,
  input: {
    migrationId: string | null;
    tenantId: string;
    actorId: string;
    actorType?: 'user' | 'staff' | 'system' | 'n8n';
    action: AuditAction;
    detail?: Record<string, unknown>;
    requestId?: string | null;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO migration_audit_log (migration_id, tenant_id, actor_id, actor_type, action, detail_json, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      input.migrationId,
      input.tenantId,
      input.actorId,
      input.actorType ?? 'user',
      input.action,
      JSON.stringify(input.detail ?? {}),
      input.requestId ?? null,
    ],
  );
}

export async function listAudit(tenantId: string, migrationId: string, limit = 200): Promise<Array<Record<string, unknown>>> {
  const { rows } = await getPool().query(
    `SELECT * FROM migration_audit_log
      WHERE tenant_id = $1 AND migration_id = $2
      ORDER BY created_at DESC LIMIT $3`,
    [tenantId, migrationId, limit],
  );
  return rows;
}

export type { PoolClient };
