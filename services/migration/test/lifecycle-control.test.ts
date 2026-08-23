import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock/index.js';
import { SimulatedWorkerCrash } from '../src/pipeline/orchestrator.js';
import { createHarness, resetDatabase, setupSchema, teardown } from './helpers.js';

/**
 * Pause, cancel and concurrency control (Scope §34).
 *
 * Pause and cancel work by aborting the running orchestrator, which means the
 * run's own error path and the operator's state change race each other. These
 * tests pin down who wins, because getting it wrong produces the two worst
 * outcomes: a paused migration that reports FAILED, and a cancel that throws an
 * unrelated error at the caller.
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

describe('pause (Scope §34)', () => {
  it('leaves the migration PAUSED, not FAILED, when a run is interrupted', async () => {
    // Slow the source down so the run is guaranteed to still be in flight when
    // pause lands, rather than finishing first and making the test vacuous.
    const adapter = new MockAdapter({
      contacts: 2000, jobs: 0, seed: 'pause', pageSize: 50,
      faults: { pageLatencyMs: 25 },
    });
    const harness = createHarness({ contacts: 2000, jobs: 0, adapter });

    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await harness.service.discover(harness.principal, migration.id);

    const run = harness.service.start(harness.principal, migration.id, {
      skipPreflight: true, runnerOptions: { batchSize: 50 },
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await harness.service.pause(harness.principal, migration.id);

    // The interrupted run rejects. The error must say the run was aborted --
    // not report a bookkeeping problem, which would hide the real reason from
    // anyone debugging.
    const error = await run.then(() => null, (e: Error) => e);
    expect(error?.name).toBe('MigrationAborted');

    const status = await harness.service.get(harness.principal, migration.id);
    expect(status.status).toBe('PAUSED');
  });

  it('resumes a paused migration and finishes it', async () => {
    const adapter = new MockAdapter({
      contacts: 600, jobs: 0, seed: 'pause-resume', pageSize: 50,
      faults: { pageLatencyMs: 20 },
    });
    const harness = createHarness({ contacts: 600, jobs: 0, adapter });

    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await harness.service.discover(harness.principal, migration.id);

    const run = harness.service.start(harness.principal, migration.id, {
      skipPreflight: true, runnerOptions: { batchSize: 50 },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await harness.service.pause(harness.principal, migration.id);
    await run.catch(() => undefined);

    expect((await harness.service.get(harness.principal, migration.id)).status).toBe('PAUSED');

    await harness.service.resume(harness.principal, migration.id);

    const final = await harness.service.status(harness.principal, migration.id);
    expect(final.status).not.toBe('PAUSED');
    expect(final.status).not.toBe('FAILED');
    expect(final.totals.remaining).toBe(0);
  });
});

describe('cancel (Scope §34)', () => {
  it('leaves the migration CANCELLED and does not mask the interruption', async () => {
    const adapter = new MockAdapter({
      contacts: 2000, jobs: 0, seed: 'cancel', pageSize: 50,
      faults: { pageLatencyMs: 25 },
    });
    const harness = createHarness({ contacts: 2000, jobs: 0, adapter });

    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await harness.service.discover(harness.principal, migration.id);

    const run = harness.service.start(harness.principal, migration.id, {
      skipPreflight: true, runnerOptions: { batchSize: 50 },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // CANCELLED is terminal. If the run's error path tried to force FAILED it
    // would throw an illegal-transition error from inside a catch block,
    // replacing the real reason with a confusing one.
    await expect(harness.service.cancel(harness.principal, migration.id)).resolves.toBeUndefined();
    await run.catch(() => undefined);

    expect((await harness.service.get(harness.principal, migration.id)).status).toBe('CANCELLED');
  });
});

describe('a genuine failure still lands FAILED', () => {
  it('does not swallow a real crash just because interruption is handled', async () => {
    const harness = createHarness({ contacts: 500, jobs: 0, seed: 'real-crash' });

    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await harness.service.discover(harness.principal, migration.id);

    await expect(
      harness.service.start(harness.principal, migration.id, {
        skipPreflight: true, runnerOptions: { batchSize: 50, crashAfterBatches: 2 },
      }),
    ).rejects.toThrow(SimulatedWorkerCrash);

    expect((await harness.service.get(harness.principal, migration.id)).status).toBe('FAILED');
  });
});

describe('concurrency guard', () => {
  it('refuses a second run of a migration that is already running', async () => {
    const adapter = new MockAdapter({
      contacts: 1000, jobs: 0, seed: 'concurrent', pageSize: 50,
      faults: { pageLatencyMs: 20 },
    });
    const harness = createHarness({ contacts: 1000, jobs: 0, adapter });

    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await harness.service.discover(harness.principal, migration.id);

    const first = harness.service.start(harness.principal, migration.id, {
      skipPreflight: true, runnerOptions: { batchSize: 50 },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Two workers on one migration would double-process every remaining page.
    await expect(
      harness.service.execute(harness.principal, migration.id, { batchSize: 50 }),
    ).rejects.toThrow(/already running/i);

    await first;

    // And the single legitimate run still completed correctly.
    const status = await harness.service.status(harness.principal, migration.id);
    expect(status.totals.remaining).toBe(0);
    expect(status.totals.discovered).toBe(1000);
  });
});
