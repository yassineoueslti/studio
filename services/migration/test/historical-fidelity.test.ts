import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MockAdapter } from '../src/adapters/mock/index.js';
import {
  applyHistoricalFidelity, buildAttributionPrefix, DEFAULT_HISTORICAL_FIDELITY, isAlreadyStamped,
} from '../src/transformers/historical-fidelity.js';
import { SandboxDestination } from '../src/destination/sandbox.js';
import { FileTransferEngine, fileCounts } from '../src/files/transfer.js';
import { buildManifest, renderTextReport } from '../src/reporting/report.js';
import { silentLogger } from '../src/observability/logger.js';
import { countTable, createHarness, getPool, resetDatabase, runMigration, setupSchema, teardown } from './helpers.js';

/**
 * Historical fidelity and file integrity.
 *
 * Both exist because of a confirmed destination limitation and an unconfirmed
 * one:
 *
 *   * BuilderLync stamps created_at at write time and will not accept ours.
 *     Guide §9.4 forbids letting history read as new activity, so the original
 *     date and author must survive somewhere a human will see them.
 *   * Whether BuilderLync returns a file checksum is unknown. The engine must
 *     neither fail every upload nor claim integrity it did not verify.
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

describe('historical fidelity (Guide §9.4)', () => {
  it('prefixes a note body with its original date and author', () => {
    const payload: Record<string, unknown> = {
      body: 'Called the homeowner about the deposit.',
      authored_at: new Date('2021-03-14T15:00:00Z'),
      author_source_name: 'Mike Reynolds',
      source_created_at: new Date('2021-03-14T15:00:00Z'),
    };

    const outcome = applyHistoricalFidelity('note', payload, DEFAULT_HISTORICAL_FIDELITY);

    expect(outcome.changed).toBe(true);
    expect(payload['body']).toBe(
      '[2021-03-14 · Mike Reynolds] Called the homeowner about the deposit.',
    );
  });

  it('is idempotent, so a delta pass or retry cannot double-stamp', () => {
    const payload: Record<string, unknown> = {
      body: 'Follow up next week.',
      authored_at: new Date('2022-06-01T09:00:00Z'),
      author_source_name: 'Dana Cole',
      source_created_at: new Date('2022-06-01T09:00:00Z'),
    };

    applyHistoricalFidelity('note', payload, DEFAULT_HISTORICAL_FIDELITY);
    const once = payload['body'];
    applyHistoricalFidelity('note', payload, DEFAULT_HISTORICAL_FIDELITY);

    expect(payload['body']).toBe(once);
    expect(String(payload['body']).match(/\[2022-06-01/g)).toHaveLength(1);
  });

  it('omits the author when the source did not record one', () => {
    const payload: Record<string, unknown> = {
      body: 'Imported note.',
      authored_at: new Date('2020-01-02T00:00:00Z'),
      author_source_name: null,
    };
    applyHistoricalFidelity('note', payload, DEFAULT_HISTORICAL_FIDELITY);
    expect(payload['body']).toBe('[2020-01-02] Imported note.');
  });

  it('never fabricates a date, and says so when one is missing', () => {
    const payload: Record<string, unknown> = {
      body: 'Undated note from the source.',
      authored_at: null,
      occurred_at: null,
      source_created_at: null,
    };

    const outcome = applyHistoricalFidelity('note', payload, DEFAULT_HISTORICAL_FIDELITY);

    // Unchanged rather than stamped with today, which would be a lie.
    expect(payload['body']).toBe('Undated note from the source.');
    expect(outcome.warnings.map((w) => w.code)).toContain('HISTORY_UNDATED');
    expect(buildAttributionPrefix(null, 'Someone', DEFAULT_HISTORICAL_FIDELITY)).toBeNull();
  });

  it('mirrors the original date into a custom field without clobbering source data', () => {
    const payload: Record<string, unknown> = {
      source_created_at: new Date('2019-11-05T12:00:00Z'),
      custom_fields: { insurance_claim: 'yes' },
    };
    applyHistoricalFidelity('contact', payload, DEFAULT_HISTORICAL_FIDELITY);

    const fields = payload['custom_fields'] as Record<string, unknown>;
    expect(fields['migrated_original_date']).toBe('2019-11-05');
    expect(fields['insurance_claim']).toBe('yes');
  });

  it('does not overwrite a source custom field that collides with the mirror key', () => {
    const payload: Record<string, unknown> = {
      source_created_at: new Date('2019-11-05T12:00:00Z'),
      custom_fields: { migrated_original_date: 'do not touch' },
    };
    applyHistoricalFidelity('contact', payload, DEFAULT_HISTORICAL_FIDELITY);
    expect((payload['custom_fields'] as Record<string, unknown>)['migrated_original_date'])
      .toBe('do not touch');
  });

  it('leaves bodies alone when the policy disables stamping', () => {
    const payload: Record<string, unknown> = {
      body: 'Raw body.',
      authored_at: new Date('2021-01-01T00:00:00Z'),
      source_created_at: new Date('2021-01-01T00:00:00Z'),
    };
    applyHistoricalFidelity('note', payload, {
      ...DEFAULT_HISTORICAL_FIDELITY, stampBodies: false, mirrorDatesToCustomFields: false,
    });
    expect(payload['body']).toBe('Raw body.');
  });

  it('recognises its own stamp format', () => {
    expect(isAlreadyStamped('[2021-03-14 · Mike] Hello')).toBe(true);
    expect(isAlreadyStamped('[2021-03-14] Hello')).toBe(true);
    expect(isAlreadyStamped('Hello [2021-03-14]')).toBe(false);
    expect(isAlreadyStamped('No stamp here')).toBe(false);
  });

  it('carries original dates through a real migration into the destination', async () => {
    const harness = createHarness({ contacts: 25, jobs: 8, notesPerJob: 2, seed: 'fidelity' });
    const migrationId = await runMigration(harness, {
      entities: ['user', 'contact', 'job', 'note'],
    });

    // Notes reached the destination carrying a visible original date.
    const { rows } = await getPool().query<{ body: string; authored_at: Date | null }>(
      `SELECT body, authored_at FROM bl_notes WHERE tenant_id = $1 LIMIT 20`,
      [harness.tenantId],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const note of rows) {
      expect(note.authored_at).not.toBeNull();
      expect(note.body).toMatch(/^\[\d{4}-\d{2}-\d{2}/);
    }

    // And contacts kept their machine-readable source timestamps.
    const { rows: contacts } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bl_contacts
        WHERE tenant_id = $1 AND source_created_at IS NOT NULL`,
      [harness.tenantId],
    );
    expect(contacts[0]?.n).toBeGreaterThan(0);

    // The report states the limitation plainly instead of hiding it.
    const manifest = await buildManifest(harness.destination, harness.tenantId, migrationId);
    const disclosure = manifest.disclosures.find((d) => d.code === 'CREATED_DATE_IS_MIGRATION_DATE');
    expect(disclosure).toBeDefined();
    expect(disclosure?.detail).toMatch(/source_created_at/);
    expect(renderTextReport(manifest)).toContain('PLEASE NOTE');
  });

  it('still discloses the limitation on a replay where every record is skipped', async () => {
    const harness = createHarness({ contacts: 30, jobs: 0, seed: 'replay-disclosure' });
    const migrationId = await runMigration(harness, { entities: ['contact'] });

    // Replay: nothing is written because nothing changed. This is the shape of
    // the final pre-go-live run, and the report the customer actually reads.
    await harness.service.retry(harness.principal, migrationId, { scope: 'all' });
    await harness.service.resume(harness.principal, migrationId);

    const manifest = await buildManifest(harness.destination, harness.tenantId, migrationId);
    expect(manifest.totals.created).toBe(0);
    expect(manifest.totals.skipped).toBeGreaterThan(0);

    // The records still sit in BuilderLync stamped with the migration date, so
    // the disclosure must survive a run that wrote nothing.
    const disclosure = manifest.disclosures.find((d) => d.code === 'CREATED_DATE_IS_MIGRATION_DATE');
    expect(disclosure).toBeDefined();
    expect(disclosure?.affected_records).toBeGreaterThan(0);
  });

  it('does not write one warning per record for the universal limitation', async () => {
    const harness = createHarness({ contacts: 200, jobs: 0, seed: 'no-warning-spam' });
    const migrationId = await runMigration(harness, { entities: ['contact'] });

    // 200 contacts all carry source dates. If the platform limitation were
    // warned per record it would produce 200 rows and bury everything else.
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM migration_warnings
        WHERE migration_id = $1 AND warning_code = 'CREATED_DATE_NOT_PRESERVED'`,
      [migrationId],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('file integrity when the destination returns no checksum (Scope §23)', () => {
  function metadataFor(file: {
    id: string; name: string; mime: string; size: number; url: string | null;
    kind: 'document' | 'image'; parent_type: string; parent_id: string;
  }) {
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

  it('records hash_verified when the destination does return one', async () => {
    const harness = createHarness({ contacts: 10, jobs: 4, filesPerJob: 2, seed: 'hash-yes' });
    const migrationId = await runMigration(harness, { entities: ['user', 'contact', 'job'] });

    const context = {
      migrationId, tenantId: harness.tenantId, sourceTenantId: 'mock-tenant-001',
      credentials: { type: 'none' as const },
    };
    const engine = new FileTransferEngine({
      adapter: harness.adapter, destination: harness.destination, logger: silentLogger,
    });
    const all = harness.adapter.data.files;
    await engine.registerMetadata(context, 'document', all.filter((f) => f.kind === 'document').map(metadataFor));
    await engine.registerMetadata(context, 'image', all.filter((f) => f.kind === 'image').map(metadataFor));
    await engine.transferPending(context);

    const counts = await fileCounts(harness.tenantId, migrationId);
    expect(counts.uploaded).toBeGreaterThan(0);
    expect(counts.hash_verified).toBe(counts.uploaded);
    expect(counts.unverified).toBe(0);
  });

  it('degrades to size verification rather than failing every upload', async () => {
    const harness = createHarness({ contacts: 10, jobs: 4, filesPerJob: 2, seed: 'hash-no' });
    const migrationId = await runMigration(harness, { entities: ['user', 'contact', 'job'] });

    // A destination that stores the bytes but reports no checksum -- the
    // behaviour we could not confirm for the real BuilderLync API.
    const real = harness.destination;
    const hashless = Object.create(real) as SandboxDestination;
    hashless.uploadFile = async (request) => {
      const result = await real.uploadFile(request);
      return { ...result, destination_hash: null };
    };

    const context = {
      migrationId, tenantId: harness.tenantId, sourceTenantId: 'mock-tenant-001',
      credentials: { type: 'none' as const },
    };
    const engine = new FileTransferEngine({
      adapter: harness.adapter, destination: hashless, logger: silentLogger,
    });
    const all = harness.adapter.data.files;
    await engine.registerMetadata(context, 'document', all.filter((f) => f.kind === 'document').map(metadataFor));
    await engine.registerMetadata(context, 'image', all.filter((f) => f.kind === 'image').map(metadataFor));
    const summary = await engine.transferPending(context);

    // The uploads succeeded rather than failing closed on a missing hash...
    expect(summary.failed).toBe(0);
    expect(summary.uploaded).toBeGreaterThan(0);

    // ...but the report does not claim they were checksum-verified.
    const counts = await fileCounts(harness.tenantId, migrationId);
    expect(counts.hash_verified).toBe(0);
    expect(counts.size_verified).toBe(counts.uploaded);

    const manifest = await buildManifest(hashless, harness.tenantId, migrationId);
    const disclosure = manifest.disclosures.find((d) => d.code === 'FILE_INTEGRITY_PARTIAL');
    expect(disclosure).toBeDefined();
    expect(disclosure?.affected_records).toBe(counts.uploaded);
  });

  it('still fails an upload whose stored byte count does not match', async () => {
    const harness = createHarness({ contacts: 5, jobs: 6, filesPerJob: 2, seed: 'truncated-upload' });
    const migrationId = await runMigration(harness, { entities: ['user', 'contact', 'job'] });

    const real = harness.destination;
    const truncating = Object.create(real) as SandboxDestination;
    truncating.uploadFile = async (request) => {
      const result = await real.uploadFile(request);
      // No checksum AND a short byte count: the signature of a truncated
      // upload, which the size check exists to catch.
      return { ...result, destination_hash: null, size_bytes: result.size_bytes - 10 };
    };

    const context = {
      migrationId, tenantId: harness.tenantId, sourceTenantId: 'mock-tenant-001',
      credentials: { type: 'none' as const },
    };
    const engine = new FileTransferEngine({
      adapter: harness.adapter, destination: truncating, logger: silentLogger,
    });
    const all = harness.adapter.data.files;
    await engine.registerMetadata(context, 'document', all.filter((f) => f.kind === 'document').map(metadataFor));
    await engine.registerMetadata(context, 'image', all.filter((f) => f.kind === 'image').map(metadataFor));
    const summary = await engine.transferPending(context);

    // Guard against the assertion passing vacuously on an empty file set.
    expect(all.length).toBeGreaterThan(0);
    expect(summary.discovered).toBeGreaterThan(0);
    expect(summary.uploaded).toBe(0);
    expect(summary.failed).toBeGreaterThan(0);

    const { errors } = await harness.service.errors(harness.principal, migrationId, {});
    expect(errors.some((e) => /byte|integrity/i.test(e.message))).toBe(true);

    expect(await countTable('bl_contacts', harness.tenantId)).toBe(5);
  });
});
