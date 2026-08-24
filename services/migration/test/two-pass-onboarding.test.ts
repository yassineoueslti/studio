import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock/index.js';
import { countTable, createHarness, getPool, resetDatabase, setupSchema, teardown } from './helpers.js';

/**
 * The two-pass delivery model agreed at the Aug 21 meeting.
 *
 *   HISTORICAL   bulk load, with client training running alongside it
 *   FINAL_DELTA  a smaller pass just before go-live, picking up what changed
 *                while training was happening
 *
 * The property that matters commercially: the second pass must import the
 * *new* work without touching the thousands of records already migrated. If a
 * weekend delta re-wrote every record, it would be indistinguishable from a
 * second full migration and would blow the go-live window.
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

describe('two-pass migration', () => {
  it('runs a historical pass, then a final delta that only imports new work', async () => {
    const adapter = new MockAdapter({ contacts: 300, jobs: 60, seed: 'two-pass', duplicateRate: 0 });
    const harness = createHarness({ contacts: 300, jobs: 60, adapter });

    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock',
      configuration: { selectedEntities: ['user', 'contact', 'job'] },
    });
    await harness.service.discover(harness.principal, migration.id);

    // --- Pass 1: historical -------------------------------------------
    await harness.service.start(harness.principal, migration.id, { skipPreflight: true });

    expect(await countTable('bl_contacts', harness.tenantId)).toBe(300);
    expect(await countTable('bl_jobs', harness.tenantId)).toBe(60);

    const afterHistorical = await harness.service.onboarding.goLiveReadiness(harness.principal, migration.id);
    expect(afterHistorical.current_pass).toBe('HISTORICAL');
    expect(afterHistorical.passes).toHaveLength(1);
    expect(afterHistorical.passes[0]?.status).toBe('COMPLETED');
    expect(afterHistorical.passes[0]?.records_created).toBeGreaterThan(0);
    // The checklist item closes itself; nobody has to remember to tick it.
    expect(afterHistorical.tasks.find((t) => t.task_key === 'historical_pass_complete')?.status).toBe('DONE');

    // --- The client keeps working during training ----------------------
    // New jobs land at the source after the historical cutoff.
    const now = new Date();
    for (let i = 0; i < 12; i += 1) {
      adapter.data.jobs.push({
        id: `J-NEW-${i}`,
        job_number: `2026-${9000 + i}`,
        name: `Job booked during training ${i}`,
        contact_id: adapter.data.contacts[i]?.id ?? null,
        street: '1 New Work Ave', city: 'Austin', state: 'TX', zip: '78701',
        job_type: 'Roof Replacement', status: 'Lead', value: 12_500,
        assigned_user_ids: [adapter.data.users[0]?.id ?? 'U0001'],
        start: null, completed: null, lead_source: 'Referral', tags: 'hail',
        created: now.toISOString(), modified: now.toISOString(),
      });
    }

    // --- Pass 2: final delta -------------------------------------------
    await harness.service.start(harness.principal, migration.id, {
      skipPreflight: true, pass: 'FINAL_DELTA',
    });

    // The 12 new jobs arrived...
    expect(await countTable('bl_jobs', harness.tenantId)).toBe(72);
    // ...and nothing was duplicated.
    expect(await countTable('bl_contacts', harness.tenantId)).toBe(300);

    const readiness = await harness.service.onboarding.goLiveReadiness(harness.principal, migration.id);
    expect(readiness.current_pass).toBe('FINAL_DELTA');
    expect(readiness.passes).toHaveLength(2);

    const delta = readiness.passes[1];
    expect(delta?.pass_type).toBe('FINAL_DELTA');
    // The delta reads from where the historical pass stopped, never from zero.
    expect(delta?.extracted_since).not.toBeNull();
    expect(readiness.tasks.find((t) => t.task_key === 'final_delta_complete')?.status).toBe('DONE');
  });

  it('refuses a delta pass before any historical pass has run', async () => {
    const harness = createHarness({ contacts: 10, jobs: 0, seed: 'no-historical' });
    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });

    await expect(
      harness.service.onboarding.beginPass(harness.principal, migration.id, 'FINAL_DELTA'),
    ).rejects.toThrow(/historical pass/i);
  });
});

describe('partial entity selection', () => {
  it('completes when the customer selected only some of the available entities', async () => {
    // Discovery scans the whole source, but the customer picked a subset. The
    // unselected entities are a deliberate choice, not data loss -- treating
    // them as missing would block completion for every partial migration,
    // which is the normal case rather than the exception.
    const harness = createHarness({ contacts: 40, jobs: 10, seed: 'partial', duplicateRate: 0 });

    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock',
      configuration: { selectedEntities: ['user', 'contact', 'job'] },
    });
    await harness.service.discover(harness.principal, migration.id);
    await harness.service.start(harness.principal, migration.id, { skipPreflight: true });

    const report = await harness.service.validate(harness.principal, migration.id);

    expect(report.blockingReasons).toEqual([]);
    expect(report.overallPassed).toBe(true);

    // Tags and pipelines exist at the source and were not selected. They are
    // still reported, so nothing is hidden -- just not counted as a defect.
    const notSelected = report.discovery.filter((d) => d.status === 'not_selected');
    expect(notSelected.map((d) => d.entity)).toContain('tag');
    for (const row of notSelected) {
      expect(row.passed).toBe(true);
      expect(row.note).toMatch(/not selected/i);
    }

    // The entities that WERE selected are still strictly reconciled.
    const reconciled = report.discovery.filter((d) => d.status === 'reconciled');
    expect(reconciled.map((d) => d.entity)).toContain('contact');
    for (const row of reconciled) expect(row.passed).toBe(true);

    const status = await harness.service.get(harness.principal, migration.id);
    expect(['COMPLETED', 'COMPLETED_WITH_WARNINGS']).toContain(status.status);
  });

  it('still catches a genuinely truncated extraction for a selected entity', async () => {
    const harness = createHarness({ contacts: 30, jobs: 0, seed: 'truncated' });
    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await harness.service.discover(harness.principal, migration.id);
    await harness.service.start(harness.principal, migration.id, { skipPreflight: true });

    // Inflate the recorded discovery count to simulate a page that was
    // silently dropped during extraction.
    await getPool().query(
      `UPDATE migration_discovery SET discovered_count = discovered_count + 5
        WHERE migration_id = $1 AND entity_type = 'contact'`,
      [migration.id],
    );

    const report = await harness.service.validate(harness.principal, migration.id);
    expect(report.overallPassed).toBe(false);
    expect(report.blockingReasons.join(' ')).toMatch(/contact.*never extracted|discovery found/i);
  });
});

describe('go-live readiness', () => {
  it('is not ready before the checklist exists', async () => {
    const harness = createHarness({ contacts: 5, jobs: 0, seed: 'uninitialized' });
    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });

    // No checklist yet means zero blockers. Reporting "ready" on that basis
    // would clear a client for go-live before anyone had looked at them.
    const readiness = await harness.service.onboarding.goLiveReadiness(harness.principal, migration.id);
    expect(readiness.checklist_initialized).toBe(false);
    expect(readiness.blockers).toHaveLength(0);
    expect(readiness.ready).toBe(false);
    expect(readiness.sla.breached).toBe(false);
  });

  it('names what is blocking go-live instead of just saying "not ready"', async () => {
    const harness = createHarness({ contacts: 50, jobs: 10, seed: 'readiness' });
    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['user', 'contact', 'job'] },
    });
    await harness.service.discover(harness.principal, migration.id);
    await harness.service.start(harness.principal, migration.id, { skipPreflight: true });

    const readiness = await harness.service.onboarding.goLiveReadiness(harness.principal, migration.id);

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.length).toBeGreaterThan(0);
    // Every blocker must be actionable: a key, a human label and a category.
    for (const blocker of readiness.blockers) {
      expect(blocker.label.length).toBeGreaterThan(0);
      expect(['data', 'configuration', 'training', 'signoff']).toContain(blocker.category);
    }
    // Work already proven by the system is not asked of a human again.
    expect(readiness.blockers.map((b) => b.task_key)).not.toContain('historical_pass_complete');
  });

  it('becomes ready once every blocking task is done', async () => {
    const harness = createHarness({ contacts: 20, jobs: 5, seed: 'ready' });
    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['user', 'contact', 'job'] },
    });
    await harness.service.discover(harness.principal, migration.id);
    await harness.service.start(harness.principal, migration.id, { skipPreflight: true });

    let readiness = await harness.service.onboarding.goLiveReadiness(harness.principal, migration.id);
    for (const blocker of readiness.blockers) {
      await harness.service.onboarding.updateTask(harness.principal, migration.id, blocker.task_key, {
        status: 'DONE',
      });
    }

    readiness = await harness.service.onboarding.goLiveReadiness(harness.principal, migration.id);
    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toHaveLength(0);
    expect(readiness.progress.percent).toBeGreaterThan(0);
  });

  it('tracks the 30-day onboarding SLA', async () => {
    const harness = createHarness({ contacts: 10, jobs: 0, seed: 'sla' });
    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await harness.service.discover(harness.principal, migration.id);
    await harness.service.start(harness.principal, migration.id, { skipPreflight: true });

    const readiness = await harness.service.onboarding.goLiveReadiness(harness.principal, migration.id);

    expect(readiness.sla.days).toBe(30);
    expect(readiness.sla.due_at).not.toBeNull();
    expect(readiness.sla.days_remaining).toBeGreaterThan(25);
    // A migration started today has not breached a 30-day window.
    expect(readiness.sla.breached).toBe(false);
  });

  it('excludes not-applicable tasks from both blockers and progress', async () => {
    const harness = createHarness({ contacts: 10, jobs: 0, seed: 'na' });
    const migration = await harness.service.create(harness.principal, {
      sourcePlatform: 'mock', configuration: { selectedEntities: ['contact'] },
    });
    await harness.service.discover(harness.principal, migration.id);
    await harness.service.start(harness.principal, migration.id, { skipPreflight: true });

    const before = await harness.service.onboarding.goLiveReadiness(harness.principal, migration.id);

    // A client with no proposal module should not be held up by its checklist
    // item, nor counted against their completion percentage.
    await harness.service.onboarding.updateTask(harness.principal, migration.id, 'training_scheduled', {
      status: 'NOT_APPLICABLE',
    });

    const after = await harness.service.onboarding.goLiveReadiness(harness.principal, migration.id);
    expect(after.blockers.map((b) => b.task_key)).not.toContain('training_scheduled');
    expect(after.progress.total).toBe(before.progress.total - 1);
  });
});
