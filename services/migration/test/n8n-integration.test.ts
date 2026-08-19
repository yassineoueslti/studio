import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock/index.js';
import { grantAll } from '../src/api/auth.js';
import { buildServer } from '../src/api/server.js';
import { SandboxDestination } from '../src/destination/sandbox.js';
import { MigrationService } from '../src/service/migration-service.js';
import { silentLogger } from '../src/observability/logger.js';
import { resetDatabase, setupSchema, teardown } from './helpers.js';

/**
 * The n8n boundary (Guide §5).
 *
 * Two things are checked here:
 *   1. The endpoints the MIG-* workflows call actually exist and behave as the
 *      workflows assume -- checkpoint round-trip, batch results, error intake.
 *   2. The workflow JSON stays structurally valid and keeps calling only
 *      endpoints this service exposes, so a rename here fails a test rather
 *      than silently breaking a deployed workflow.
 */

const WORKFLOW_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'n8n', 'workflows');

beforeAll(async () => {
  await setupSchema();
});

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await teardown();
});

function buildApp() {
  const adapter = new MockAdapter({ contacts: 20, jobs: 5, seed: 'n8n' });
  const destination = new SandboxDestination();
  const service = new MigrationService({ destination, adapterFor: () => adapter, logger: silentLogger });
  const app = buildServer({ service, logLevel: 'silent' });
  grantAll('n8n-worker', 'n8n-tenant', 'n8n-token');
  return { app, service, adapter, destination };
}

describe('n8n orchestration endpoints', () => {
  it('round-trips a checkpoint so an interrupted execution resumes where it stopped', async () => {
    const { app } = buildApp();
    const auth = { authorization: 'Bearer n8n-token' };

    const created = await app.inject({
      method: 'POST', url: '/api/migrations', headers: auth,
      payload: { source_platform: 'mock' },
    });
    const migrationId = created.json().migration.id as string;

    // A migration with no checkpoint reports a clean start rather than 404:
    // a first run is not an error condition.
    const initial = await app.inject({
      method: 'GET', url: `/internal/migration/${migrationId}/checkpoint/contact`, headers: auth,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({ cursor: null, batch_number: 0, extraction_complete: false });

    const saved = await app.inject({
      method: 'POST', url: `/internal/migration/${migrationId}/checkpoint`, headers: auth,
      payload: {
        entity: 'contact', cursor: { offset: 500 }, last_source_id: 'C000500',
        records_processed: 500, batch_number: 1, extraction_complete: false,
      },
    });
    expect(saved.statusCode).toBe(200);

    const resumed = await app.inject({
      method: 'GET', url: `/internal/migration/${migrationId}/checkpoint/contact`, headers: auth,
    });
    expect(resumed.json().cursor).toEqual({ offset: 500 });
    expect(resumed.json().records_processed).toBe(500);
    expect(resumed.json().batch_number).toBe(1);

    // Re-saving the same entity updates in place rather than accumulating rows.
    await app.inject({
      method: 'POST', url: `/internal/migration/${migrationId}/checkpoint`, headers: auth,
      payload: {
        entity: 'contact', cursor: null, records_processed: 1000,
        batch_number: 2, extraction_complete: true,
      },
    });
    const final = await app.inject({
      method: 'GET', url: `/internal/migration/${migrationId}/checkpoint/contact`, headers: auth,
    });
    expect(final.json().extraction_complete).toBe(true);
    expect(final.json().records_processed).toBe(1000);

    await app.close();
  });

  it('accepts a worker-reported error into the customer error dashboard', async () => {
    const { app, service } = buildApp();
    const auth = { authorization: 'Bearer n8n-token' };

    const created = await app.inject({
      method: 'POST', url: '/api/migrations', headers: auth,
      payload: { source_platform: 'mock' },
    });
    const migrationId = created.json().migration.id as string;

    const reported = await app.inject({
      method: 'POST', url: `/internal/migration/${migrationId}/errors`, headers: auth,
      payload: {
        entity: 'contact', source_id: 'C42', error_code: 'RATE_LIMIT',
        message: 'Source API throttled the request', context: { workflow: 'MIG-100' },
      },
    });
    expect(reported.statusCode).toBe(200);

    const principal = grantAll('n8n-worker', 'n8n-tenant', 'n8n-token');
    const { errors, summary } = await service.errors(principal, migrationId, {});
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error_code).toBe('RATE_LIMIT');
    // The taxonomy decides retryability; the caller does not get to assert it.
    expect(errors[0]?.retryable).toBe(true);
    expect(summary[0]?.summary).toContain('throttled');

    await app.close();
  });

  it('rejects an unauthenticated worker call', async () => {
    const { app } = buildApp();
    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch',
      payload: { migration_id: '00000000-0000-4000-8000-000000000000', records: [] },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('ignores a tenant id smuggled into a worker payload', async () => {
    const { app } = buildApp();
    const auth = { authorization: 'Bearer n8n-token' };

    const created = await app.inject({
      method: 'POST', url: '/api/migrations', headers: auth,
      payload: { source_platform: 'mock' },
    });
    const migrationId = created.json().migration.id as string;

    const response = await app.inject({
      method: 'POST', url: '/internal/migration/contacts/batch', headers: auth,
      payload: {
        migration_id: migrationId,
        records: [{
          source_id: 'SPOOF-1',
          idempotency_key: `mig_${migrationId}:mock:contact:SPOOF-1`,
          content_hash: 'h',
          payload: { source_platform: 'mock', tenant_id: 'victim-tenant', first_name: 'Spoof' },
        }],
      },
    });

    // The write is rejected outright rather than landing in either tenant.
    expect(response.json().results[0].status).toBe('FAILED');
    expect(response.json().results[0].error.message).toMatch(/tenant/i);

    await app.close();
  });
});

describe('n8n workflow definitions (Guide §5.4)', () => {
  const files = readdirSync(WORKFLOW_DIR).filter((f) => f.endsWith('.json'));

  it('ships the workflows the first sprint requires', () => {
    // Guide §25 task 8: MIG-001, MIG-100, MIG-140 and MIG-900.
    for (const required of ['MIG-001', 'MIG-100', 'MIG-140', 'MIG-900']) {
      expect(files.some((f) => f.startsWith(required)), `${required} workflow is missing`).toBe(true);
    }
  });

  it.each(files)('%s is structurally valid and internally consistent', (file) => {
    const workflow = JSON.parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as {
      name: string;
      nodes: Array<{ name: string; type: string; parameters: Record<string, unknown> }>;
      connections: Record<string, { main: Array<Array<{ node: string }>> }>;
      settings?: Record<string, unknown>;
    };

    expect(workflow.name).toBeTruthy();
    expect(workflow.nodes.length).toBeGreaterThan(0);

    const names = new Set(workflow.nodes.map((n) => n.name));
    expect(names.size, 'node names must be unique').toBe(workflow.nodes.length);

    // Every connection must reference a node that exists, in both directions.
    for (const [from, spec] of Object.entries(workflow.connections)) {
      expect(names.has(from), `connection source "${from}" does not exist`).toBe(true);
      for (const group of spec.main) {
        for (const target of group) {
          expect(names.has(target.node), `connection target "${target.node}" does not exist`).toBe(true);
        }
      }
    }
  });

  it.each(files)('%s calls only endpoints this service exposes', (file) => {
    const raw = readFileSync(join(WORKFLOW_DIR, file), 'utf8');

    // Extract the path portion of every migration-API URL in the workflow,
    // with n8n expressions collapsed to a wildcard segment.
    const paths = [...raw.matchAll(/BUILDERLYNC_MIGRATION_API \}\}([^"\\]*)/g)]
      .map((m) => (m[1] ?? '').replace(/\{\{[^}]*\}\}/g, ':param').trim())
      .filter(Boolean);

    expect(paths.length, 'workflow should call the migration API').toBeGreaterThan(0);

    const KNOWN = [
      '/api/migrations/:param/status',
      '/api/migrations/:param/validate',
      '/internal/migration/:param/checkpoint',
      '/internal/migration/:param/checkpoint/contact',
      '/internal/migration/:param/checkpoint/job',
      '/internal/migration/:param/errors',
      '/internal/migration/contacts/batch',
      '/internal/migration/jobs/batch',
    ];

    for (const path of paths) {
      expect(KNOWN, `workflow ${file} calls unknown endpoint "${path}"`).toContain(path);
    }
  });

  it('routes every workflow failure to the central error handler', () => {
    for (const file of files.filter((f) => !f.startsWith('MIG-900'))) {
      const workflow = JSON.parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as {
        settings?: { errorWorkflow?: string };
      };
      // Guide §5.4: MIG-900 is the single place workflow failures converge, so
      // an operator has one dashboard rather than one per workflow.
      expect(workflow.settings?.errorWorkflow, `${file} must set errorWorkflow`).toContain('MIG_900');
    }
  });

  it('keeps source-specific logic confined to one node per entity workflow', () => {
    // Guide §5.5 / Scope §88: this is the architectural rule that decides
    // whether the platform survives growing from five sources to twenty-five.
    for (const file of ['MIG-100-contacts.json', 'MIG-140-jobs.json']) {
      const workflow = JSON.parse(readFileSync(join(WORKFLOW_DIR, file), 'utf8')) as {
        nodes: Array<{ name: string; notes?: string }>;
      };
      const sourceSpecific = workflow.nodes.filter((n) => /ONLY source-specific/i.test(n.notes ?? ''));
      expect(sourceSpecific, `${file} must isolate source logic in exactly one node`).toHaveLength(1);
      expect(sourceSpecific[0]?.name).toBe('Extract And Normalize');
    }
  });
});
