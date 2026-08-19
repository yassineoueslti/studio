import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock/index.js';
import { grantAll } from '../src/api/auth.js';
import { buildServer } from '../src/api/server.js';
import { getPool } from '../src/db/pool.js';
import * as recordsRepo from '../src/db/repositories/records.js';
import { SandboxDestination } from '../src/destination/sandbox.js';
import { MigrationError } from '../src/domain/errors.js';
import { FileTransferEngine, fileCounts } from '../src/files/transfer.js';
import { SimulatedWorkerCrash } from '../src/pipeline/orchestrator.js';
import { MigrationService } from '../src/service/migration-service.js';
import { silentLogger } from '../src/observability/logger.js';
import { reconcile } from '../src/validation/reconcile.js';
import { countTable, createHarness, resetDatabase, runMigration, setupSchema, teardown } from './helpers.js';

/**
 * Guide §20 "Test Plan Before Production", tests 1-11, in order.
 *
 * These run against a real Postgres database and the real sandbox destination.
 * Each test's name is the guide's own name for it, so a reviewer can check the
 * plan off directly against the suite.
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

// ---------------------------------------------------------------------------
// Test 1 - Small happy path: 100 contacts, 20 jobs, 50 files
// ---------------------------------------------------------------------------
describe('Test 1 - Small happy path', () => {
  it('migrates 100 contacts, 20 jobs and their files with every record accounted for', async () => {
    const harness = createHarness({
      contacts: 100, jobs: 20, filesPerJob: 3, notesPerJob: 1,
      duplicateRate: 0, noContactInfoRate: 0, seed: 'happy-path',
    });

    const migrationId = await runMigration(harness, {
      entities: ['user', 'tag', 'pipeline', 'pipeline_stage', 'contact', 'job', 'note'],
    });

    expect(await countTable('bl_contacts', harness.tenantId)).toBe(100);
    expect(await countTable('bl_jobs', harness.tenantId)).toBe(20);

    // Files move through their own pipeline (Guide §14.1: metadata, then bytes).
    const files = harness.adapter.data.files;
    const context = {
      migrationId, tenantId: harness.tenantId, sourceTenantId: 'mock-tenant-001',
      credentials: { type: 'none' as const },
    };
    const engine = new FileTransferEngine({
      adapter: harness.adapter, destination: harness.destination, logger: silentLogger,
    });

    await engine.registerMetadata(context, 'document', files.filter((f) => f.kind === 'document').map(toMetadata));
    await engine.registerMetadata(context, 'image', files.filter((f) => f.kind === 'image').map(toMetadata));
    const summary = await engine.transferPending(context);

    expect(summary.failed).toBe(0);
    expect(summary.uploaded).toBe(files.length);
    expect(await countTable('bl_files', harness.tenantId)).toBe(files.length);

    const report = await reconcile(harness.destination, harness.tenantId, migrationId);
    for (const count of report.counts) {
      expect(count.variance, `${count.entity} must balance`).toBe(0);
    }
    expect(report.files.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2 - Duplicate replay: run the same migration twice, no uncontrolled duplicates
// ---------------------------------------------------------------------------
describe('Test 2 - Duplicate replay', () => {
  it('creates no new destination rows when the identical source data is replayed', async () => {
    const harness = createHarness({ contacts: 200, jobs: 40, duplicateRate: 0, seed: 'replay' });

    const migrationId = await runMigration(harness);
    const contactsAfterFirst = await countTable('bl_contacts', harness.tenantId);
    const jobsAfterFirst = await countTable('bl_jobs', harness.tenantId);
    expect(contactsAfterFirst).toBe(200);

    // Replay: reset the checkpoints and run the same source data again.
    await harness.service.retry(harness.principal, migrationId, { scope: 'all' });
    await harness.service.resume(harness.principal, migrationId);

    expect(await countTable('bl_contacts', harness.tenantId)).toBe(contactsAfterFirst);
    expect(await countTable('bl_jobs', harness.tenantId)).toBe(jobsAfterFirst);

    // Second pass should be skips, not writes: unchanged content hash.
    const counts = await recordsRepo.countsByEntity(harness.tenantId, migrationId);
    const contacts = counts.find((c) => c.entity_type === 'contact');
    expect(contacts?.skipped).toBe(200);
    expect(contacts?.created).toBe(0);
  });

  it('serves a repeated batch from the idempotency ledger rather than rewriting', async () => {
    const harness = createHarness({ contacts: 10, jobs: 0, seed: 'idem' });
    const migrationId = await runMigration(harness, { entities: ['contact'] });

    const request = {
      tenantId: harness.tenantId,
      migrationId,
      entity: 'contact' as const,
      records: [{
        sourceId: 'MANUAL-1',
        idempotencyKey: `mig_${migrationId}:mock:contact:MANUAL-1`,
        contentHash: 'hash-abc',
        payload: { source_platform: 'mock', first_name: 'Repeat', last_name: 'Test', email: 'r@t.com' },
      }],
    };

    const first = await harness.destination.writeBatch(request);
    expect(first.results[0]?.status).toBe('CREATED');

    const second = await harness.destination.writeBatch(request);
    expect(second.results[0]?.status).toBe('CREATED');
    expect(second.results[0]?.idempotent_replay).toBe(true);
    expect(second.results[0]?.builderlync_id).toBe(first.results[0]?.builderlync_id);
  });
});

// ---------------------------------------------------------------------------
// Test 3 - Mid-run crash: kill the worker, restart, resume from checkpoint
// ---------------------------------------------------------------------------
describe('Test 3 - Mid-run crash', () => {
  it('resumes from the last checkpoint without duplicating the batch it had committed', async () => {
    const harness = createHarness({ contacts: 500, jobs: 100, seed: 'crash' });

    await expect(
      runMigration(harness, { crashAfterBatches: 3, batchSize: 50 }),
    ).rejects.toThrow(SimulatedWorkerCrash);

    const migrations = await harness.service.list(harness.principal);
    const migrationId = migrations[0]?.id as string;

    const midway = await harness.service.status(harness.principal, migrationId);
    expect(midway.status).toBe('FAILED');
    const partial = await countTable('bl_contacts', harness.tenantId);

    // Checkpoints survived the crash: that is what makes resume possible.
    const checkpoints = await recordsRepo.listCheckpoints(harness.tenantId, migrationId);
    expect(checkpoints.length).toBeGreaterThan(0);

    await harness.service.resume(harness.principal, migrationId);

    const finalContacts = await countTable('bl_contacts', harness.tenantId);
    expect(finalContacts).toBe(500);
    expect(finalContacts).toBeGreaterThan(partial);

    // No source contact was written twice.
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT external_source_id FROM bl_contacts WHERE tenant_id = $1
         GROUP BY external_source_id HAVING count(*) > 1) dupes`,
      [harness.tenantId],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4 - API throttling: simulate 429 and verify bounded backoff/retry
// ---------------------------------------------------------------------------
describe('Test 4 - API throttling', () => {
  it('backs off and completes when the source returns 429 on every third call', async () => {
    const adapter = new MockAdapter({
      contacts: 300, jobs: 0, seed: 'throttle', pageSize: 50,
      faults: { failEveryNthExtract: { n: 3, code: 'RATE_LIMIT' } },
    });
    const harness = createHarness({ contacts: 300, jobs: 0, adapter });

    const migrationId = await runMigration(harness, { entities: ['contact'] });

    // Throttling delays the migration; it must not lose records.
    expect(await countTable('bl_contacts', harness.tenantId)).toBe(300);
    const report = await reconcile(harness.destination, harness.tenantId, migrationId);
    expect(report.counts.find((c) => c.entity === 'contact')?.variance).toBe(0);
  });

  it('stops retrying a permission failure instead of burning the rate-limit budget', async () => {
    const adapter = new MockAdapter({
      contacts: 50, jobs: 0, seed: 'perm',
      faults: { failEveryNthExtract: { n: 1, code: 'PERMISSION_ERROR' } },
    });
    const harness = createHarness({ contacts: 50, jobs: 0, adapter });

    await expect(runMigration(harness, { entities: ['contact'] })).rejects.toThrow(MigrationError);
  });
});

// ---------------------------------------------------------------------------
// Test 5 - Destination outage: retries must not duplicate data
// ---------------------------------------------------------------------------
describe('Test 5 - Destination outage', () => {
  it('recovers when ingestion is temporarily unavailable, without double-writing', async () => {
    const harness = createHarness({ contacts: 150, jobs: 0, seed: 'outage' });

    // Wrap the destination so the first two batch writes fail as a 503 would.
    const real = harness.destination;
    let failuresRemaining = 2;
    const flaky = Object.create(real) as SandboxDestination;
    flaky.writeBatch = async (request) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new MigrationError('BUILDERLYNC_API_ERROR', 'Destination temporarily unavailable (simulated 503)', {});
      }
      return real.writeBatch(request);
    };

    const service = new MigrationService({
      destination: flaky, adapterFor: () => harness.adapter, logger: silentLogger,
    });

    const migration = await service.create(harness.principal, {
      sourcePlatform: 'mock',
      configuration: { selectedEntities: ['contact'] },
    });
    await service.discover(harness.principal, migration.id);
    await service.start(harness.principal, migration.id, {
      skipPreflight: true, runnerOptions: { batchSize: 50 },
    });

    expect(failuresRemaining).toBe(0);
    expect(await countTable('bl_contacts', harness.tenantId)).toBe(150);

    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT external_source_id FROM bl_contacts WHERE tenant_id = $1
         GROUP BY external_source_id HAVING count(*) > 1) dupes`,
      [harness.tenantId],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6 - Bad record: other valid records must remain accounted for
// ---------------------------------------------------------------------------
describe('Test 6 - Bad record', () => {
  it('fails only the malformed record and migrates the rest of its batch', async () => {
    const harness = createHarness({
      contacts: 100, jobs: 0, seed: 'bad-record', malformedRate: 0.1, duplicateRate: 0,
    });

    const migrationId = await runMigration(harness, { entities: ['contact'], batchSize: 100 });

    const counts = await recordsRepo.countsByEntity(harness.tenantId, migrationId);
    const contacts = counts.find((c) => c.entity_type === 'contact');

    expect(contacts?.failed).toBeGreaterThan(0);
    expect(contacts?.created).toBeGreaterThan(0);
    // The equation still balances: a failure is an explanation, not a hole.
    expect(contacts?.discovered).toBe((contacts?.created ?? 0) + (contacts?.failed ?? 0) + (contacts?.skipped ?? 0));

    const { errors } = await harness.service.errors(harness.principal, migrationId, {});
    expect(errors.some((e) => e.error_code === 'VALIDATION_ERROR')).toBe(true);

    const report = await reconcile(harness.destination, harness.tenantId, migrationId);
    expect(report.counts.find((c) => c.entity === 'contact')?.variance).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 7 - Expired credentials: actionable reconnect message
// ---------------------------------------------------------------------------
describe('Test 7 - Expired credentials', () => {
  it('reports an actionable reconnect message rather than a generic failure', async () => {
    const adapter = new MockAdapter({ contacts: 10, jobs: 0, seed: 'expired', faults: { authFails: true } });
    const harness = createHarness({ contacts: 10, jobs: 0, adapter });

    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });

    const result = await harness.service.testConnection(harness.principal, migration.id);
    expect(result.ok).toBe(false);
    expect(result.message.toLowerCase()).toContain('reconnect');

    const preflight = await harness.service.preflight(harness.principal, migration.id);
    expect(preflight.passed).toBe(false);
    expect(preflight.checks.find((c) => c.name === 'authentication')?.passed).toBe(false);

    // Start must refuse rather than half-migrate against a dead credential.
    const started = await harness.service.start(harness.principal, migration.id);
    expect(started.started).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 8 - Restricted access profile: preflight reports missing permissions
// ---------------------------------------------------------------------------
describe('Test 8 - Restricted access profile', () => {
  it('names the inaccessible objects before the migration starts', async () => {
    const adapter = new MockAdapter({
      contacts: 50, jobs: 10, seed: 'restricted',
      faults: { deniedEntities: ['document', 'image'] },
    });
    const harness = createHarness({ contacts: 50, jobs: 10, adapter });

    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock',
      configuration: { selectedEntities: ['user', 'contact', 'job', 'document'] },
    });

    const connection = await harness.service.testConnection(harness.principal, migration.id);
    const denied = connection.resourceAccess?.filter((r) => !r.accessible) ?? [];
    expect(denied.map((d) => d.entity)).toContain('document');
    expect(denied[0]?.reason).toMatch(/access profile|permission/i);

    await harness.service.discover(harness.principal, migration.id);
    const preflight = await harness.service.preflight(harness.principal, migration.id);
    const permissionCheck = preflight.checks.find((c) => c.name === 'source_permissions');
    expect(permissionCheck?.passed).toBe(false);
    expect(permissionCheck?.detail).toContain('document');

    // Discovery must report the object as unsupported rather than count zero
    // silently, so the customer sees why it will not be migrated.
    const discovery = await harness.service.getDiscovery(harness.principal, migration.id);
    const documents = discovery.find((d) => d.entity_type === 'document');
    expect(documents?.supported).toBe(false);
    expect(documents?.capability_note).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Test 9 - File failures: complete with explicit failures, never silent loss
// ---------------------------------------------------------------------------
describe('Test 9 - File failures', () => {
  it('records unavailable assets as failed rather than dropping them', async () => {
    const harness = createHarness({
      contacts: 30, jobs: 10, filesPerJob: 3, seed: 'file-fail', unavailableFileRate: 0.3,
    });

    const migrationId = await runMigration(harness, { entities: ['user', 'contact', 'job'] });

    const context = {
      migrationId, tenantId: harness.tenantId, sourceTenantId: 'mock-tenant-001',
      credentials: { type: 'none' as const },
    };
    const engine = new FileTransferEngine({
      adapter: harness.adapter, destination: harness.destination, logger: silentLogger,
    });

    const all = harness.adapter.data.files;
    await engine.registerMetadata(context, 'document', all.filter((f) => f.kind === 'document').map(toMetadata));
    await engine.registerMetadata(context, 'image', all.filter((f) => f.kind === 'image').map(toMetadata));
    await engine.transferPending(context);

    const counts = await fileCounts(harness.tenantId, migrationId);
    expect(counts.failed).toBeGreaterThan(0);
    expect(counts.uploaded).toBeGreaterThan(0);
    // Every discovered asset has a disposition; none vanished.
    expect(counts.discovered).toBe(counts.uploaded + counts.failed + counts.unsupported + counts.pending);

    // A failed photo did not roll back the contacts and jobs beside it.
    expect(await countTable('bl_contacts', harness.tenantId)).toBe(30);
    expect(await countTable('bl_jobs', harness.tenantId)).toBe(10);

    const { errors } = await harness.service.errors(harness.principal, migrationId, {});
    expect(errors.some((e) => e.error_code === 'FILE_DOWNLOAD_ERROR')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 10 - Tenant isolation: a mismatched tenant context must be rejected
// ---------------------------------------------------------------------------
describe('Test 10 - Tenant isolation', () => {
  it('rejects a batch whose payload targets a different tenant', async () => {
    const harness = createHarness({ contacts: 5, jobs: 0, seed: 'tenant-a' });
    const migrationId = await runMigration(harness, { entities: ['contact'] });

    const response = await harness.destination.writeBatch({
      tenantId: harness.tenantId,
      migrationId,
      entity: 'contact',
      records: [{
        sourceId: 'CROSS-1',
        idempotencyKey: `mig_${migrationId}:mock:contact:CROSS-1`,
        contentHash: 'x',
        // A crafted payload naming another tenant must not be honoured.
        payload: { source_platform: 'mock', tenant_id: 'some-other-tenant', first_name: 'Cross' },
      }],
    });

    expect(response.results[0]?.status).toBe('FAILED');
    expect(response.results[0]?.error?.message).toMatch(/tenant/i);

    const { rows } = await getPool().query(
      `SELECT id FROM bl_contacts WHERE external_source_id = 'CROSS-1'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('does not let one tenant read another tenant migration', async () => {
    const tenantA = createHarness({ contacts: 5, jobs: 0, seed: 'iso-a', tenantId: 'tenant-alpha' });
    const migrationId = await runMigration(tenantA, { entities: ['contact'] });

    const tenantB = createHarness({ contacts: 5, jobs: 0, seed: 'iso-b', tenantId: 'tenant-beta' });

    // Same uuid, different tenant: reported as not-found, so the API cannot be
    // used to probe which migration ids exist elsewhere.
    await expect(tenantB.service.get(tenantB.principal, migrationId)).rejects.toThrow(/not found/i);
    await expect(tenantB.service.status(tenantB.principal, migrationId)).rejects.toThrow(/not found/i);
  });

  it('scopes migration listings to the caller tenant', async () => {
    const tenantA = createHarness({ contacts: 3, jobs: 0, seed: 'list-a', tenantId: 'tenant-list-a' });
    await runMigration(tenantA, { entities: ['contact'] });

    const tenantB = createHarness({ contacts: 3, jobs: 0, seed: 'list-b', tenantId: 'tenant-list-b' });
    expect(await tenantB.service.list(tenantB.principal)).toHaveLength(0);
    expect(await tenantA.service.list(tenantA.principal)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test 11 - Large-volume load
// ---------------------------------------------------------------------------
describe('Test 11 - Large-volume load', () => {
  it('migrates a large dataset with every record accounted for', async () => {
    const harness = createHarness({
      contacts: 5000, jobs: 1000, seed: 'volume', duplicateRate: 0, pageSize: 500,
    });

    const migrationId = await runMigration(harness, {
      entities: ['user', 'tag', 'pipeline', 'pipeline_stage', 'contact', 'job'],
      batchSize: 500,
    });

    expect(await countTable('bl_contacts', harness.tenantId)).toBe(5000);
    expect(await countTable('bl_jobs', harness.tenantId)).toBe(1000);

    const report = await reconcile(harness.destination, harness.tenantId, migrationId);
    for (const count of report.counts) {
      expect(count.variance, `${count.entity} must balance`).toBe(0);
      expect(count.inFlight, `${count.entity} must have nothing in flight`).toBe(0);
    }

    // Scope §3.5: relationships survived at volume.
    expect(report.relationshipAnalysis.jobsOrphanedByMigration).toBe(0);

    const objectMap = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM migration_object_map WHERE migration_id = $1',
      [migrationId],
    );
    expect(objectMap.rows[0]?.n).toBeGreaterThanOrEqual(6000);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// API surface (Guide §4 "Done when: the migration lifecycle can be driven
// through API calls before a real CRM connector exists")
// ---------------------------------------------------------------------------
describe('Migration API', () => {
  it('drives a full migration lifecycle over HTTP', async () => {
    const adapter = new MockAdapter({ contacts: 40, jobs: 10, seed: 'api' });
    const destination = new SandboxDestination();
    const service = new MigrationService({ destination, adapterFor: () => adapter, logger: silentLogger });
    const app = buildServer({ service, logLevel: 'silent' });
    grantAll('api-user', 'api-tenant', 'api-token');
    const auth = { authorization: 'Bearer api-token' };

    const created = await app.inject({
      method: 'POST', url: '/api/migrations', headers: auth,
      payload: { source_platform: 'mock', configuration: { selectedEntities: ['user', 'contact', 'job'] } },
    });
    expect(created.statusCode).toBe(201);
    const migrationId = created.json().migration.id as string;

    expect((await app.inject({ method: 'POST', url: `/api/migrations/${migrationId}/test-connection`, headers: auth })).json().result.ok).toBe(true);
    expect((await app.inject({ method: 'POST', url: `/api/migrations/${migrationId}/discover`, headers: auth })).statusCode).toBe(200);

    const started = await app.inject({
      method: 'POST', url: `/api/migrations/${migrationId}/start`, headers: auth,
      payload: { skip_preflight: true },
    });
    expect(started.statusCode).toBe(200);

    const status = await app.inject({ method: 'GET', url: `/api/migrations/${migrationId}/status`, headers: auth });
    expect(status.json().totals.discovered).toBeGreaterThan(0);
    expect(status.json().progress_percent).toBe(100);

    const validated = await app.inject({ method: 'POST', url: `/api/migrations/${migrationId}/validate`, headers: auth });
    expect(validated.json().validation.counts.length).toBeGreaterThan(0);

    const report = await app.inject({ method: 'GET', url: `/api/migrations/${migrationId}/report`, headers: auth });
    expect(report.json().report.totals.discovered).toBeGreaterThan(0);

    const text = await app.inject({ method: 'GET', url: `/api/migrations/${migrationId}/report?format=text`, headers: auth });
    expect(text.body).toContain('BUILDERLYNC MIGRATION REPORT');
    expect(text.body).toContain('[BALANCED]');

    await app.close();
  });

  it('refuses unauthenticated requests', async () => {
    const adapter = new MockAdapter({ contacts: 1, jobs: 0 });
    const service = new MigrationService({
      destination: new SandboxDestination(), adapterFor: () => adapter, logger: silentLogger,
    });
    const app = buildServer({ service, logLevel: 'silent' });

    const response = await app.inject({ method: 'GET', url: '/api/migrations' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns a per-record result for every record in an ingestion batch', async () => {
    const adapter = new MockAdapter({ contacts: 1, jobs: 0 });
    const service = new MigrationService({
      destination: new SandboxDestination(), adapterFor: () => adapter, logger: silentLogger,
    });
    const app = buildServer({ service, logLevel: 'silent' });
    grantAll('batch-user', 'batch-tenant', 'batch-token');

    const created = await app.inject({
      method: 'POST', url: '/api/migrations',
      headers: { authorization: 'Bearer batch-token' },
      payload: { source_platform: 'mock' },
    });
    const migrationId = created.json().migration.id as string;

    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch',
      headers: { authorization: 'Bearer batch-token' },
      payload: {
        migration_id: migrationId,
        records: [1, 2, 3].map((n) => ({
          source_id: `B${n}`,
          idempotency_key: `mig_${migrationId}:mock:contact:B${n}`,
          content_hash: `hash-${n}`,
          payload: { source_platform: 'mock', first_name: `Batch${n}` },
        })),
      },
    });

    expect(response.statusCode).toBe(200);
    const results = response.json().results as Array<{ source_id: string; status: string }>;
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.source_id).sort()).toEqual(['B1', 'B2', 'B3']);
    for (const result of results) expect(result.status).toBe('CREATED');

    await app.close();
  });

  it('deduplicates repeated vendor webhook events in the inbox', async () => {
    const adapter = new MockAdapter({ contacts: 1, jobs: 0 });
    const service = new MigrationService({
      destination: new SandboxDestination(), adapterFor: () => adapter, logger: silentLogger,
    });
    const app = buildServer({ service, logLevel: 'silent' });

    const payload = { event_id: 'evt_123', type: 'project.updated', data: { id: 'P1' } };
    const first = await app.inject({ method: 'POST', url: '/webhooks/proline', payload });
    const second = await app.inject({ method: 'POST', url: '/webhooks/proline', payload });

    expect(first.json().duplicate).toBe(false);
    // ProLine documents no delivery guarantee, so redelivery is expected and
    // must be absorbed rather than double-processed (Guide §10.5).
    expect(second.json().duplicate).toBe(true);

    // An event with no vendor id falls back to payload hashing.
    const noId = { type: 'contact.created', data: { id: 'C9' } };
    expect((await app.inject({ method: 'POST', url: '/webhooks/proline', payload: noId })).json().duplicate).toBe(false);
    expect((await app.inject({ method: 'POST', url: '/webhooks/proline', payload: noId })).json().duplicate).toBe(true);

    await app.close();
  });
});

function toMetadata(file: { id: string; name: string; mime: string; size: number; url: string | null; kind: 'document' | 'image'; parent_type: string; parent_id: string }) {
  return {
    sourceFileId: file.id,
    fileName: file.name,
    originalName: file.name,
    mimeType: file.mime,
    sizeBytes: file.size,
    sourceUrl: file.url,
    sourceHash: null,
    kind: file.kind,
    parentEntityType: file.parent_type,
    parentSourceId: file.parent_id,
    uploadedByUserSourceId: null,
    sourceCreatedAt: null,
  };
}
