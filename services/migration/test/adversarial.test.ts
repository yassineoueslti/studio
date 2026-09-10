import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock/index.js';
import { grantAll, tokens } from '../src/api/auth.js';
import { buildServer } from '../src/api/server.js';
import { SandboxDestination } from '../src/destination/sandbox.js';
import { setDestination } from '../src/destination/index.js';
import { PERMISSIONS } from '../src/domain/permissions.js';
import { MigrationService } from '../src/service/migration-service.js';
import { silentLogger } from '../src/observability/logger.js';
import { getPool, resetDatabase, setupSchema, teardown } from './helpers.js';

/**
 * Adversarial suite: deliberately hostile input against every boundary.
 *
 * The rest of the suite proves the engine works when used correctly. This one
 * assumes the caller is malicious or broken -- a compromised n8n worker, a
 * hostile source CRM, a stray script with a valid token -- and asserts the
 * engine refuses rather than corrupts.
 *
 * The threat model that matters: this service holds several contractors' entire
 * customer databases at once. The catastrophic failure is not a crash, it is
 * one customer's records silently landing in another's account, or a migration
 * whose audit trail cannot be trusted.
 */

let app: ReturnType<typeof buildServer>;
let service: MigrationService;
let destination: SandboxDestination;

const TENANT_A = 'tenant-alpha';
const TENANT_B = 'tenant-beta';
const authA = { authorization: 'Bearer token-alpha' };
const authB = { authorization: 'Bearer token-beta' };

beforeAll(async () => {
  await setupSchema();
});

beforeEach(async () => {
  await resetDatabase();
  destination = new SandboxDestination();
  setDestination(destination);
  const adapter = new MockAdapter({ contacts: 20, jobs: 5, seed: 'adversarial' });
  service = new MigrationService({ destination, adapterFor: () => adapter, logger: silentLogger });
  app = buildServer({ service, logLevel: 'silent' });
  grantAll('user-alpha', TENANT_A, 'token-alpha');
  grantAll('user-beta', TENANT_B, 'token-beta');
});

afterAll(async () => {
  await teardown();
});

async function createMigration(auth: Record<string, string>): Promise<string> {
  const created = await app.inject({
    method: 'POST', url: '/api/migrations', headers: auth,
    payload: { source_platform: 'mock', configuration: { selectedEntities: ['contact'] } },
  });
  return created.json().migration.id as string;
}

// ---------------------------------------------------------------------------
// Cross-tenant and cross-migration writes
// ---------------------------------------------------------------------------
describe('a valid token must not reach another tenant migration', () => {
  it('refuses an ingestion batch aimed at a migration the caller does not own', async () => {
    const victimMigration = await createMigration(authA);

    // Tenant B holds a perfectly valid token. The only thing it should not be
    // able to do is write into tenant A's migration.
    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: authB,
      payload: {
        migration_id: victimMigration,
        records: [{
          source_id: 'HOSTILE-1',
          idempotency_key: `mig_${victimMigration}:mock:contact:HOSTILE-1`,
          content_hash: 'h',
          payload: { source_platform: 'mock', first_name: 'Hostile' },
        }],
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    // Nothing was written under either tenant.
    const { rows } = await getPool().query(
      `SELECT tenant_id FROM bl_contacts WHERE external_source_id = 'HOSTILE-1'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a checkpoint written against a migration the caller does not own', async () => {
    const victimMigration = await createMigration(authA);

    const response = await app.inject({
      method: 'POST', url: `/internal/migration/${victimMigration}/checkpoint`, headers: authB,
      payload: {
        entity: 'contact', cursor: { offset: 9999 }, records_processed: 9999,
        batch_number: 99, extraction_complete: true,
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    // Tenant A's migration must not have acquired a checkpoint it never made.
    // Poisoning this would make a resumed migration skip real records.
    const { rows } = await getPool().query(
      'SELECT * FROM migration_checkpoints WHERE migration_id = $1',
      [victimMigration],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses an error logged against a migration the caller does not own', async () => {
    const victimMigration = await createMigration(authA);

    const response = await app.inject({
      method: 'POST', url: `/internal/migration/${victimMigration}/errors`, headers: authB,
      payload: { error_code: 'UNKNOWN_ERROR', message: 'injected noise' },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    const { rows } = await getPool().query(
      'SELECT * FROM migration_errors WHERE migration_id = $1',
      [victimMigration],
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a batch aimed at a migration id that does not exist at all', async () => {
    // A garbage id would otherwise tag destination rows with an unresolvable
    // migration, breaking the audit chain Scope §83 requires.
    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: authA,
      payload: {
        migration_id: '00000000-0000-4000-8000-00000000dead',
        records: [{
          source_id: 'ORPHAN-1',
          idempotency_key: 'mig_x:mock:contact:ORPHAN-1',
          content_hash: 'h',
          payload: { source_platform: 'mock', first_name: 'Orphan' },
        }],
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    const { rows } = await getPool().query(
      `SELECT 1 FROM bl_contacts WHERE external_source_id = 'ORPHAN-1'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses a file upload aimed at a migration the caller does not own', async () => {
    const victimMigration = await createMigration(authA);

    const response = await app.inject({
      method: 'POST', url: '/internal/migration/files', headers: authB,
      payload: {
        migration_id: victimMigration,
        idempotency_key: 'mig_x:mock:document:HOSTILE',
        file_name: 'hostile.pdf',
        external_source_platform: 'mock',
        external_source_id: 'HOSTILE-FILE',
        content_base64: Buffer.from('hostile').toString('base64'),
      },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// Unauthenticated surface
// ---------------------------------------------------------------------------
describe('unauthenticated surface', () => {
  it('does not expose the webhook inbox to anonymous readers', async () => {
    // The inbox holds vendor event ids, event types, timestamps and error text
    // for every customer. It must not be world-readable.
    await app.inject({
      method: 'POST', url: '/webhooks/proline',
      payload: { event_id: 'evt_secret', type: 'project.updated', data: { id: 'P1' } },
    });

    const anonymous = await app.inject({ method: 'GET', url: '/webhooks/proline/inbox' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.body).not.toContain('evt_secret');
  });

  it('does not expose operational metrics to anonymous readers', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/metrics' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('keeps health unauthenticated, since load balancers need it', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    // ...but it must not leak configuration beyond liveness.
    expect(health.body).not.toMatch(/postgres:\/\/|password|secret|token/i);
  });

  it('rejects an unknown or malformed bearer token', async () => {
    for (const header of [
      { authorization: 'Bearer not-a-real-token' },
      { authorization: 'Bearer ' },
      { authorization: 'token-alpha' },
      { authorization: 'Basic dXNlcjpwYXNz' },
    ]) {
      const response = await app.inject({ method: 'GET', url: '/api/migrations', headers: header });
      expect(response.statusCode, JSON.stringify(header)).toBe(401);
    }
  });

  it('requires migration.admin for the staff console, not merely a valid token', async () => {
    // A token with every permission EXCEPT admin.
    tokens.register({
      token: 'token-nonadmin', userId: 'u', tenantId: TENANT_A,
      permissions: PERMISSIONS.filter((p) => p !== 'migration.admin'),
    });
    const migrationId = await createMigration(authA);

    const response = await app.inject({
      method: 'GET', url: `/admin/migrations/${migrationId}/object-map`,
      headers: { authorization: 'Bearer token-nonadmin' },
    });
    expect(response.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Injection and traversal
// ---------------------------------------------------------------------------
describe('hostile content is stored as data, never executed', () => {
  it('treats SQL metacharacters in identifiers as literal text', async () => {
    const migrationId = await createMigration(authA);
    const hostileId = "'; DROP TABLE bl_contacts; --";

    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: authA,
      payload: {
        migration_id: migrationId,
        records: [{
          source_id: hostileId,
          idempotency_key: `mig_${migrationId}:mock:contact:${hostileId}`,
          content_hash: 'h',
          payload: { source_platform: 'mock', first_name: "Robert'); DROP TABLE bl_jobs;--" },
        }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].status).toBe('CREATED');

    // Both tables still exist and the payload round-tripped verbatim.
    const { rows } = await getPool().query(
      `SELECT first_name, external_source_id FROM bl_contacts WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(rows[0]?.external_source_id).toBe(hostileId);
    expect(rows[0]?.first_name).toBe("Robert'); DROP TABLE bl_jobs;--");
    await expect(getPool().query('SELECT 1 FROM bl_jobs LIMIT 1')).resolves.toBeDefined();
  });

  it('confines uploaded files to the storage root despite traversal attempts', async () => {
    const migrationId = await createMigration(authA);
    const storageRoot = resolve(process.env['FILE_STORAGE_ROOT'] ?? './storage');

    const result = await destination.uploadFile({
      tenantId: TENANT_A,
      migrationId,
      idempotencyKey: `mig_${migrationId}:mock:document:TRAVERSAL`,
      fileName: '../../../../../../etc/passwd',
      originalName: '../../../../../../etc/passwd',
      mimeType: 'application/pdf',
      kind: 'document',
      content: Buffer.from('not actually passwd'),
      contentHash: 'h',
      parentEntityType: null,
      parentBuilderLyncId: null,
      uploadedByUserId: null,
      sourceCreatedAt: null,
      externalSourcePlatform: 'mock',
      externalSourceId: 'TRAVERSAL-1',
    });

    // Whatever path was chosen, it must resolve inside the storage root.
    expect(resolve(result.destination_url).startsWith(storageRoot)).toBe(true);
    expect(resolve(result.destination_url)).not.toContain('/etc/passwd');
  });

  it('confines files even when the tenant identifier itself is hostile', async () => {
    // Defence in depth: the tenant comes from a verified token today, but a
    // path built from an identity string should not depend on that for safety.
    const hostileTenant = '../../../../tmp/escaped';
    const storageRoot = resolve(process.env['FILE_STORAGE_ROOT'] ?? './storage');

    const result = await destination.uploadFile({
      tenantId: hostileTenant,
      migrationId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'mig_x:mock:document:HOSTILE-TENANT',
      fileName: 'ok.pdf',
      originalName: 'ok.pdf',
      mimeType: 'application/pdf',
      kind: 'document',
      content: Buffer.from('bytes'),
      contentHash: 'h',
      parentEntityType: null,
      parentBuilderLyncId: null,
      uploadedByUserId: null,
      sourceCreatedAt: null,
      externalSourcePlatform: 'mock',
      externalSourceId: 'HOSTILE-TENANT-1',
    });

    expect(resolve(result.destination_url).startsWith(storageRoot)).toBe(true);
  });

  it('survives control characters, null bytes and very long text', async () => {
    const migrationId = await createMigration(authA);
    const nasty = [
      'Null', String.fromCharCode(0), 'byte',
      String.fromCharCode(27), '[31mANSI',
      String.fromCharCode(0x202e), 'reversed',
    ].join('');

    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: authA,
      payload: {
        migration_id: migrationId,
        records: [{
          source_id: 'NASTY-1',
          idempotency_key: `mig_${migrationId}:mock:contact:NASTY-1`,
          content_hash: 'h',
          payload: {
            source_platform: 'mock',
            first_name: nasty,
            last_name: 'A'.repeat(50_000),
          },
        }],
      },
    });

    // Postgres rejects NUL in text, so the engine must either sanitize it or
    // fail that one record cleanly -- never 500 and never corrupt the batch.
    expect([200]).toContain(response.statusCode);
    const result = response.json().results[0];
    expect(['CREATED', 'FAILED']).toContain(result.status);
    if (result.status === 'FAILED') expect(result.error?.message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Resource limits
// ---------------------------------------------------------------------------
describe('resource limits', () => {
  it('rejects a batch larger than the documented maximum', async () => {
    const migrationId = await createMigration(authA);
    const records = Array.from({ length: 2001 }, (_, i) => ({
      source_id: `BULK-${i}`,
      idempotency_key: `mig_${migrationId}:mock:contact:BULK-${i}`,
      content_hash: 'h',
      payload: { source_platform: 'mock', first_name: `Bulk${i}` },
    }));

    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: authA,
      payload: { migration_id: migrationId, records },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects an empty batch rather than treating it as success', async () => {
    const migrationId = await createMigration(authA);
    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: authA,
      payload: { migration_id: migrationId, records: [] },
    });
    expect(response.statusCode).toBe(400);
  });

  it('does not stack-overflow on deeply nested payloads', async () => {
    const migrationId = await createMigration(authA);
    let nested: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 2000; i += 1) nested = { nested };

    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: authA,
      payload: {
        migration_id: migrationId,
        records: [{
          source_id: 'DEEP-1',
          idempotency_key: `mig_${migrationId}:mock:contact:DEEP-1`,
          content_hash: 'h',
          payload: { source_platform: 'mock', first_name: 'Deep', custom_fields: nested },
        }],
      },
    });

    // Any definitive answer is acceptable; a crashed process is not.
    expect(response.statusCode).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// Idempotency under abuse
// ---------------------------------------------------------------------------
describe('idempotency cannot be subverted', () => {
  it('does not let a reused idempotency key overwrite a different source record', async () => {
    const migrationId = await createMigration(authA);
    const sharedKey = `mig_${migrationId}:mock:contact:SHARED`;

    const first = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: authA,
      payload: {
        migration_id: migrationId,
        records: [{ source_id: 'REAL-1', idempotency_key: sharedKey, content_hash: 'h1',
          payload: { source_platform: 'mock', first_name: 'Real' } }],
      },
    });
    const realId = first.json().results[0].builderlync_id as string;

    // A second, different source record replaying the same key must not be
    // able to take over the first record's destination row.
    const second = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: authA,
      payload: {
        migration_id: migrationId,
        records: [{ source_id: 'IMPOSTOR-1', idempotency_key: sharedKey, content_hash: 'h1',
          payload: { source_platform: 'mock', first_name: 'Impostor' } }],
      },
    });

    // The ledger answer is returned unchanged; the impostor's content is not
    // written over the real record.
    expect(second.json().results[0].builderlync_id).toBe(realId);
    const { rows } = await getPool().query(
      'SELECT first_name FROM bl_contacts WHERE id = $1', [realId],
    );
    expect(rows[0]?.first_name).toBe('Real');
  });

  it('handles the same source id appearing twice inside one batch', async () => {
    const migrationId = await createMigration(authA);
    const record = {
      source_id: 'DUP-IN-BATCH',
      idempotency_key: `mig_${migrationId}:mock:contact:DUP-IN-BATCH`,
      content_hash: 'h',
      payload: { source_platform: 'mock', first_name: 'Twice' },
    };

    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: authA,
      payload: { migration_id: migrationId, records: [record, record] },
    });

    expect(response.statusCode).toBe(200);
    // Every input gets a result (Scope §44) but only one row is created.
    expect(response.json().results).toHaveLength(2);
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM bl_contacts WHERE external_source_id = 'DUP-IN-BATCH'`,
    );
    expect(rows[0]?.n).toBe(1);
  });

  it('does not duplicate under concurrent identical batches', async () => {
    const migrationId = await createMigration(authA);
    const payload = {
      migration_id: migrationId,
      records: Array.from({ length: 25 }, (_, i) => ({
        source_id: `RACE-${i}`,
        idempotency_key: `mig_${migrationId}:mock:contact:RACE-${i}`,
        content_hash: 'h',
        payload: { source_platform: 'mock', first_name: `Race${i}` },
      })),
    };

    await Promise.all([
      app.inject({ method: 'POST', url: '/internal/migration/contacts/batch', headers: authA, payload }),
      app.inject({ method: 'POST', url: '/internal/migration/contacts/batch', headers: authA, payload }),
      app.inject({ method: 'POST', url: '/internal/migration/contacts/batch', headers: authA, payload }),
    ]);

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM (
         SELECT external_source_id FROM bl_contacts WHERE tenant_id = $1
         GROUP BY external_source_id HAVING count(*) > 1) dupes`,
      [TENANT_A],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------
describe('secrets never leave the service', () => {
  it('never echoes a stored credential back through the API', async () => {
    const migrationId = await createMigration(authA);

    await app.inject({
      method: 'POST', url: `/api/migrations/${migrationId}/connect`, headers: authA,
      payload: {
        credential_type: 'api_key',
        secret: { apiKey: 'SUPER-SECRET-KEY-12345' },
      },
    });

    for (const url of [
      `/api/migrations/${migrationId}`,
      `/api/migrations/${migrationId}/status`,
      `/api/migrations/${migrationId}/audit`,
      `/api/migrations/${migrationId}/report`,
    ]) {
      const response = await app.inject({ method: 'GET', url, headers: authA });
      expect(response.body, url).not.toContain('SUPER-SECRET-KEY-12345');
    }

    // And it is not sitting in the database in plaintext either.
    const { rows } = await getPool().query(
      'SELECT ciphertext FROM migration_credentials WHERE tenant_id = $1', [TENANT_A],
    );
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0].ciphertext).toString('utf8')).not.toContain('SUPER-SECRET-KEY');
  });

  it('does not leak internal detail in an error response', async () => {
    const response = await app.inject({
      method: 'GET', url: '/api/migrations/not-a-uuid', headers: authA,
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toMatch(/at .*\.ts:\d+|node_modules|postgres:\/\//);
  });
});

/** Storage layout check used by the traversal tests. */
export function listStorageFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  try {
    walk(root);
  } catch {
    // No storage directory yet.
  }
  return out;
}
