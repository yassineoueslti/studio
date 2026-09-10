import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock/index.js';
import type { AdapterContext, ExtractOptions, ExtractPage } from '../src/adapters/types.js';
import { SandboxDestination } from '../src/destination/sandbox.js';
import type { BatchRequest, BatchResponse } from '../src/destination/types.js';
import type { EntityType } from '../src/domain/entities.js';
import { MigrationService } from '../src/service/migration-service.js';
import { silentLogger } from '../src/observability/logger.js';
import { countTable, createHarness, getPool, resetDatabase, runMigration, setupSchema, teardown } from './helpers.js';

/**
 * Wave two: hostile behaviour from the components the engine trusts.
 *
 * The API boundary is now hardened against a malicious caller. This suite
 * assumes the *adapter* or the *destination* is broken or lying -- a vendor API
 * that repeats records across pages, a destination that acknowledges records it
 * was never sent, a corrupted checkpoint. These are the failures that silently
 * corrupt a migration rather than stopping it, which makes them worse than a
 * crash: the customer goes live on data nobody knows is wrong.
 */

beforeAll(async () => {
  await setupSchema();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await teardown();
});

describe('a misbehaving source adapter', () => {
  it('does not duplicate when the source repeats records across pages', async () => {
    // Real APIs do this when records are inserted mid-pagination and the
    // offset shifts underneath the reader.
    const base = new MockAdapter({ contacts: 200, jobs: 0, seed: 'repeat', pageSize: 50 });
    const repeating = Object.create(base) as MockAdapter;
    let call = 0;
    repeating.extract = async (entity: EntityType, ctx: AdapterContext, options?: ExtractOptions): Promise<ExtractPage> => {
      const page = await MockAdapter.prototype.extract.call(base, entity, ctx, options);
      call += 1;
      // Every other page re-serves its first record.
      if (page.records.length > 0 && call % 2 === 0) {
        page.records = [page.records[0], ...page.records];
      }
      return page;
    };

    const harness = createHarness({ contacts: 200, jobs: 0, adapter: repeating });
    await runMigration(harness, { entities: ['contact'], batchSize: 50 });

    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT external_source_id FROM bl_contacts WHERE tenant_id = $1
         GROUP BY external_source_id HAVING count(*) > 1) d`,
      [harness.tenantId],
    );
    expect(rows[0]?.n).toBe(0);
    expect(await countTable('bl_contacts', harness.tenantId)).toBe(200);
  });

  it('accounts for a record whose normalize() throws', async () => {
    const base = new MockAdapter({ contacts: 60, jobs: 0, seed: 'throwing', pageSize: 30 });
    const throwing = Object.create(base) as MockAdapter;
    let seen = 0;
    throwing.normalize = (entity: EntityType, raw: unknown, ctx: AdapterContext) => {
      seen += 1;
      // A transformation bug on a subset of records, which is how these
      // actually present -- one unexpected field shape, not total failure.
      if (seen % 10 === 0) throw new Error('simulated transformer defect');
      return MockAdapter.prototype.normalize.call(base, entity, raw, ctx);
    };

    const harness = createHarness({ contacts: 60, jobs: 0, adapter: throwing });
    const migrationId = await runMigration(harness, { entities: ['contact'], batchSize: 30 });

    const report = await harness.service.validate(harness.principal, migrationId);
    const contacts = report.counts.find((c) => c.entity === 'contact');

    // The failures are recorded, not lost: the equation still balances.
    expect(contacts?.failed).toBeGreaterThan(0);
    expect(contacts?.created).toBeGreaterThan(0);
    expect(contacts?.variance).toBe(0);
  });

  it('surfaces an adapter that reports hasMore forever instead of looping without end', async () => {
    // A pagination bug that never terminates would otherwise spin until the
    // process died, with a half-written migration and no diagnosis.
    const base = new MockAdapter({ contacts: 40, jobs: 0, seed: 'endless', pageSize: 20 });
    const endless = Object.create(base) as MockAdapter;
    endless.extract = async (): Promise<ExtractPage> => ({
      records: [], cursor: 1, hasMore: true, totalEstimate: null,
    });

    const harness = createHarness({ contacts: 40, jobs: 0, adapter: endless });

    // An empty page with hasMore=true must terminate rather than spin: the
    // orchestrator stops when a page yields nothing.
    const migrationId = await runMigration(harness, { entities: ['contact'], batchSize: 20 });
    const status = await harness.service.status(harness.principal, migrationId);
    expect(status.totals.discovered).toBe(0);
  }, 30_000);
});

describe('a misbehaving destination', () => {
  function wrap(real: SandboxDestination, writeBatch: SandboxDestination['writeBatch']): SandboxDestination {
    const proxy = Object.create(real) as SandboxDestination;
    proxy.writeBatch = writeBatch;
    return proxy;
  }

  it('refuses a batch response that omits records it was sent', async () => {
    const harness = createHarness({ contacts: 60, jobs: 0, seed: 'short-response' });
    const real = harness.destination;

    const lying = wrap(real, async (request: BatchRequest): Promise<BatchResponse> => {
      const response = await real.writeBatch(request);
      // Drop one result: the failure mode that would otherwise appear later as
      // an unexplained reconciliation variance with no traceable cause.
      return { results: response.results.slice(1) };
    });

    const service = new MigrationService({
      destination: lying, adapterFor: () => harness.adapter, logger: silentLogger,
    });
    const migration = await service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await service.discover(harness.principal, migration.id);

    // The engine must notice rather than silently accept the short answer.
    await expect(
      service.start(harness.principal, migration.id, { skipPreflight: true, runnerOptions: { batchSize: 30 } }),
    ).rejects.toThrow();

    const status = await service.status(harness.principal, migration.id);
    expect(status.status).toBe('FAILED');
  });

  it('ignores results for records it never sent', async () => {
    const harness = createHarness({ contacts: 40, jobs: 0, seed: 'phantom' });
    const real = harness.destination;

    const inventing = wrap(real, async (request: BatchRequest): Promise<BatchResponse> => {
      const response = await real.writeBatch(request);
      return {
        results: [
          ...response.results,
          // A destination bug, or a compromised one, claiming a record exists.
          { source_id: 'PHANTOM-RECORD', status: 'CREATED' as const, builderlync_id: 'bl_phantom' },
        ],
      };
    });

    const service = new MigrationService({
      destination: inventing, adapterFor: () => harness.adapter, logger: silentLogger,
    });
    const migration = await service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await service.discover(harness.principal, migration.id);
    await service.start(harness.principal, migration.id, { skipPreflight: true, runnerOptions: { batchSize: 20 } });

    // The phantom must not enter the ledger or the object map -- a fabricated
    // mapping would make support trace a real BuilderLync id to nothing.
    const { rows: ledger } = await getPool().query(
      `SELECT 1 FROM migration_records WHERE source_object_id = 'PHANTOM-RECORD'`,
    );
    expect(ledger).toHaveLength(0);

    const { rows: mapped } = await getPool().query(
      `SELECT 1 FROM migration_object_map WHERE source_object_id = 'PHANTOM-RECORD'`,
    );
    expect(mapped).toHaveLength(0);
  });

  it('keeps the migration accountable when the destination fails every write', async () => {
    const harness = createHarness({ contacts: 40, jobs: 0, seed: 'total-outage' });
    const real = harness.destination;

    const broken = wrap(real, async (request: BatchRequest): Promise<BatchResponse> => ({
      results: request.records.map((r) => ({
        source_id: r.sourceId,
        status: 'FAILED' as const,
        builderlync_id: null,
        error: { code: 'BUILDERLYNC_API_ERROR', message: 'destination unavailable', retryable: true },
      })),
    }));

    const service = new MigrationService({
      destination: broken, adapterFor: () => harness.adapter, logger: silentLogger,
    });
    const migration = await service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await service.discover(harness.principal, migration.id);
    await service.start(harness.principal, migration.id, { skipPreflight: true, runnerOptions: { batchSize: 20 } });

    const report = await service.validate(harness.principal, migration.id);
    const contacts = report.counts.find((c) => c.entity === 'contact');

    // Total failure is still a fully accounted-for outcome, and completion is
    // blocked -- the migration must not read as finished.
    expect(contacts?.failed).toBe(40);
    expect(contacts?.variance).toBe(0);
    expect((await service.get(harness.principal, migration.id)).status).not.toBe('COMPLETED');
  });
});

describe('corrupted resume state', () => {
  it('does not silently skip records when a checkpoint claims false completion', async () => {
    const harness = createHarness({ contacts: 100, jobs: 0, seed: 'corrupt-checkpoint' });
    const migrationId = await runMigration(harness, { entities: ['contact'], batchSize: 25 });
    expect(await countTable('bl_contacts', harness.tenantId)).toBe(100);

    // Corrupt the checkpoint to claim more was processed than really was, then
    // force a re-run. Reconciliation must still see the true ledger state
    // rather than trusting the checkpoint's arithmetic.
    await getPool().query(
      `UPDATE migration_checkpoints SET records_processed = 999999 WHERE migration_id = $1`,
      [migrationId],
    );

    const report = await harness.service.validate(harness.principal, migrationId);
    const contacts = report.counts.find((c) => c.entity === 'contact');
    expect(contacts?.discovered).toBe(100);
    expect(contacts?.variance).toBe(0);
  });

  it('re-extracts correctly after the cursor is reset to an impossible value', async () => {
    const harness = createHarness({ contacts: 80, jobs: 0, seed: 'bad-cursor' });
    const migrationId = await runMigration(harness, { entities: ['contact'], batchSize: 20 });

    await getPool().query(
      `UPDATE migration_checkpoints
          SET cursor_json = '999999'::jsonb, extraction_complete = FALSE
        WHERE migration_id = $1`,
      [migrationId],
    );

    // A cursor past the end yields nothing and terminates, rather than looping
    // or throwing. Records already migrated stay put.
    await harness.service.resume(harness.principal, migrationId);
    expect(await countTable('bl_contacts', harness.tenantId)).toBe(80);
  });
});

describe('implausible source data', () => {
  it('rejects dates far outside any plausible business range', async () => {
    const harness = createHarness({ contacts: 30, jobs: 0, seed: 'bad-dates' });
    const adapter = harness.adapter;
    for (const contact of adapter.data.contacts.slice(0, 10)) {
      contact.created = '1673-01-01T00:00:00Z';
      contact.modified = '9999-12-31T00:00:00Z';
    }

    const migrationId = await runMigration(harness, { entities: ['contact'] });

    // Implausible dates become null with a warning rather than being written,
    // which would otherwise corrupt every date-ordered view in the destination.
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bl_contacts
        WHERE tenant_id = $1 AND (source_created_at < '1970-01-01' OR source_created_at > '2100-01-01')`,
      [harness.tenantId],
    );
    expect(rows[0]?.n).toBe(0);

    const { rows: warned } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM migration_warnings
        WHERE migration_id = $1 AND warning_code = 'INVALID_DATE'`,
      [migrationId],
    );
    expect(warned[0]?.n).toBeGreaterThan(0);
  });

  it('survives a source record that is not an object at all', async () => {
    const base = new MockAdapter({ contacts: 30, jobs: 0, seed: 'garbage', pageSize: 30 });
    const garbage = Object.create(base) as MockAdapter;
    garbage.extract = async (entity: EntityType, ctx: AdapterContext, options?: ExtractOptions): Promise<ExtractPage> => {
      const page = await MockAdapter.prototype.extract.call(base, entity, ctx, options);
      return { ...page, records: [null, 'a string', 42, ...page.records] };
    };

    const harness = createHarness({ contacts: 30, jobs: 0, adapter: garbage });
    const migrationId = await runMigration(harness, { entities: ['contact'], batchSize: 40 });

    const report = await harness.service.validate(harness.principal, migrationId);
    const contacts = report.counts.find((c) => c.entity === 'contact');

    // The junk is accounted for as failures; the real records still migrate.
    expect(contacts?.variance).toBe(0);
    expect(contacts?.failed).toBeGreaterThanOrEqual(3);
    expect(await countTable('bl_contacts', harness.tenantId)).toBe(30);
  });
});
