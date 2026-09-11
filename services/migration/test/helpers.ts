import { randomUUID } from 'node:crypto';
import { grantAll, tokens } from '../src/api/auth.js';
import { MockAdapter, type MockAdapterOptions } from '../src/adapters/mock/index.js';
import { closePool, getPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { SandboxDestination } from '../src/destination/sandbox.js';
import { setDestination } from '../src/destination/index.js';
import type { Principal } from '../src/domain/permissions.js';
import { MigrationService } from '../src/service/migration-service.js';
import { silentLogger } from '../src/observability/logger.js';

/**
 * Test harness.
 *
 * Tests run against a real Postgres database and the real sandbox destination
 * rather than mocks of either. The guarantees under test -- idempotency across
 * process restart, checkpoint resume, per-record batch accounting -- are
 * properties of durable state, and a mocked store cannot falsify them.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://builderlync:builderlync@localhost:5432/builderlync_migration_test';

let schemaReady = false;

export async function setupSchema(): Promise<void> {
  if (schemaReady) return;
  await runMigrations({ silent: true });
  schemaReady = true;
}

/** Wipe migration and destination state between suites. */
export async function resetDatabase(): Promise<void> {
  await setupSchema();
  const { rows } = await getPool().query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND (tablename LIKE 'migration%' OR tablename LIKE 'bl_%')
        AND tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  await getPool().query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  tokens.clear();
}

export async function teardown(): Promise<void> {
  await closePool();
}

export interface Harness {
  service: MigrationService;
  adapter: MockAdapter;
  destination: SandboxDestination;
  principal: Principal;
  tenantId: string;
}

export function createHarness(
  options: MockAdapterOptions & { tenantId?: string; adapter?: MockAdapter } = { contacts: 100, jobs: 20 },
): Harness {
  const tenantId = options.tenantId ?? `tenant-${randomUUID().slice(0, 8)}`;
  const adapter = options.adapter ?? new MockAdapter(options);
  const destination = new SandboxDestination();
  setDestination(destination);

  const principal = grantAll(`user-${tenantId}`, tenantId, `token-${tenantId}`);
  const service = new MigrationService({ destination, adapterFor: () => adapter, logger: silentLogger });

  return { service, adapter, destination, principal, tenantId };
}

/** Create + discover + start, the sequence every test needs before asserting. */
export async function runMigration(
  harness: Harness,
  options: {
    entities?: string[];
    crashAfterBatches?: number;
    batchSize?: number;
    skipPreflight?: boolean;
  } = {},
): Promise<string> {
  const migration = await harness.service.create(harness.principal, {
    sourcePlatform: 'mock',
    configuration: {
      selectedEntities: options.entities ?? ['user', 'tag', 'pipeline', 'pipeline_stage', 'contact', 'job'],
    },
  });

  await harness.service.discover(harness.principal, migration.id);
  await harness.service.start(harness.principal, migration.id, {
    skipPreflight: options.skipPreflight ?? true,
    runnerOptions: {
      ...(options.crashAfterBatches ? { crashAfterBatches: options.crashAfterBatches } : {}),
      ...(options.batchSize ? { batchSize: options.batchSize } : {}),
    },
  });

  return migration.id;
}

export async function countTable(table: string, tenantId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`,
    [tenantId],
  );
  return rows[0]?.n ?? 0;
}

export { getPool };
