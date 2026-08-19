import { CANONICAL_SCHEMA_VERSION } from '../canonical/common.js';
import * as errorsRepo from '../db/repositories/errors.js';
import * as migrationsRepo from '../db/repositories/migrations.js';
import * as recordsRepo from '../db/repositories/records.js';
import type { DestinationClient } from '../destination/types.js';
import { reconcile, type ReconciliationReport } from '../validation/reconcile.js';

/**
 * Migration manifest and customer-facing accuracy report (Scope §40, §61,
 * Guide §17.4).
 *
 * Two audiences, one source of truth:
 *   * `MigrationManifest` is machine-readable, versioned, and archived. It is
 *     what a support engineer diffs when a customer asks "where did record X
 *     go" eighteen months later.
 *   * `renderTextReport` is what a human reads. It never contains a credential
 *     or a raw source payload, so it is safe to attach to a support ticket.
 */

export const MIGRATION_REPORT_VERSION = '1.0.0';

export interface EntityManifestLine {
  entity: string;
  discovered: number;
  created: number;
  updated: number;
  merged: number;
  skipped: number;
  unsupported: number;
  failed: number;
  accounted_for: number;
  variance: number;
}

export interface MigrationManifest {
  report_version: string;
  generated_at: string;
  migration_id: string;
  tenant_id: string;
  source_platform: string;
  source_tenant_id: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  versions: {
    source_connector_version: string;
    canonical_schema_version: string;
    destination_api_version: string;
  };
  entities: EntityManifestLine[];
  files: {
    discovered: number;
    uploaded: number;
    failed: number;
    unsupported: number;
    pending: number;
  };
  relationships: Record<string, number>;
  relationship_analysis: {
    jobsWithoutContact: number;
    jobsContactlessAtSource: number;
    jobsOrphanedByMigration: number;
  };
  errors: Array<{ error_code: string; entity: string | null; count: number; retryable: boolean; summary: string }>;
  warnings: Array<{ warning_code: string; entity: string | null; count: number }>;
  duplicates_pending_review: number;
  totals: {
    discovered: number;
    accounted_for: number;
    created: number;
    updated: number;
    merged: number;
    skipped: number;
    unsupported: number;
    failed: number;
  };
  validation_passed: boolean;
  outstanding_actions: string[];
  accepted_by: string | null;
  accepted_at: string | null;
}

export async function buildManifest(
  destination: DestinationClient,
  tenantId: string,
  migrationId: string,
  precomputed?: ReconciliationReport,
): Promise<MigrationManifest> {
  const migration = await migrationsRepo.getMigration(
    (await import('../db/pool.js')).getPool(),
    tenantId,
    migrationId,
  );
  if (!migration) throw new Error(`Migration ${migrationId} not found for tenant ${tenantId}`);

  const reconciliation = precomputed ?? (await reconcile(destination, tenantId, migrationId));
  const [errors, warnings] = await Promise.all([
    errorsRepo.summarizeErrors(tenantId, migrationId),
    errorsRepo.summarizeWarnings(tenantId, migrationId),
  ]);

  const entities: EntityManifestLine[] = reconciliation.counts.map((c) => ({
    entity: c.entity,
    discovered: c.discovered,
    created: c.created,
    updated: c.updated,
    merged: c.merged,
    skipped: c.skipped,
    unsupported: c.unsupported,
    failed: c.failed,
    accounted_for: c.accountedFor,
    variance: c.variance,
  }));

  const totals = entities.reduce(
    (acc, e) => ({
      discovered: acc.discovered + e.discovered,
      accounted_for: acc.accounted_for + e.accounted_for,
      created: acc.created + e.created,
      updated: acc.updated + e.updated,
      merged: acc.merged + e.merged,
      skipped: acc.skipped + e.skipped,
      unsupported: acc.unsupported + e.unsupported,
      failed: acc.failed + e.failed,
    }),
    { discovered: 0, accounted_for: 0, created: 0, updated: 0, merged: 0, skipped: 0, unsupported: 0, failed: 0 },
  );

  const outstanding: string[] = [...reconciliation.blockingReasons];
  if (reconciliation.duplicatesPendingReview > 0) {
    outstanding.push(
      `${reconciliation.duplicatesPendingReview} possible duplicate(s) are held for review and were not merged automatically.`,
    );
  }
  if (totals.failed > 0) {
    outstanding.push(`${totals.failed} record(s) failed and can be retried from the migration error dashboard.`);
  }
  if (reconciliation.files.failed > 0) {
    outstanding.push(`${reconciliation.files.failed} file(s) failed to transfer and can be retried independently.`);
  }

  return {
    report_version: MIGRATION_REPORT_VERSION,
    generated_at: new Date().toISOString(),
    migration_id: migrationId,
    tenant_id: tenantId,
    source_platform: migration.source_platform,
    source_tenant_id: migration.source_tenant_id,
    status: migration.status,
    started_at: migration.started_at?.toISOString() ?? null,
    completed_at: migration.completed_at?.toISOString() ?? null,
    versions: {
      source_connector_version: migration.connector_version,
      canonical_schema_version: CANONICAL_SCHEMA_VERSION,
      destination_api_version: migration.destination_api_version,
    },
    entities,
    files: {
      discovered: reconciliation.files.discovered,
      uploaded: reconciliation.files.uploaded,
      failed: reconciliation.files.failed,
      unsupported: reconciliation.files.unsupported,
      pending: reconciliation.files.pending,
    },
    relationships: { ...reconciliation.relationships },
    relationship_analysis: { ...reconciliation.relationshipAnalysis },
    errors,
    warnings,
    duplicates_pending_review: reconciliation.duplicatesPendingReview,
    totals,
    validation_passed: reconciliation.overallPassed,
    outstanding_actions: outstanding,
    accepted_by: migration.accepted_by,
    accepted_at: migration.accepted_at?.toISOString() ?? null,
  };
}

/** Fixed-width text rendering, for the CLI, support tickets and the demo. */
export function renderTextReport(manifest: MigrationManifest): string {
  const lines: string[] = [];
  const rule = '='.repeat(78);

  lines.push(rule);
  lines.push('BUILDERLYNC MIGRATION REPORT');
  lines.push(rule);
  lines.push(`Migration ID     : ${manifest.migration_id}`);
  lines.push(`Source platform  : ${manifest.source_platform}`);
  lines.push(`Source tenant    : ${manifest.source_tenant_id ?? '(not reported)'}`);
  lines.push(`Status           : ${manifest.status}`);
  lines.push(`Started          : ${manifest.started_at ?? '-'}`);
  lines.push(`Completed        : ${manifest.completed_at ?? '-'}`);
  lines.push(
    `Versions         : connector=${manifest.versions.source_connector_version} ` +
      `schema=${manifest.versions.canonical_schema_version} ` +
      `destination=${manifest.versions.destination_api_version}`,
  );
  lines.push('');

  lines.push('RECORD RECONCILIATION');
  lines.push('-'.repeat(78));
  lines.push(pad('Entity', 20) + cols(['Found', 'New', 'Upd', 'Merge', 'Skip', 'Unsup', 'Fail', 'Var']));
  lines.push('-'.repeat(78));
  for (const e of manifest.entities) {
    lines.push(
      pad(e.entity, 20) +
        cols([e.discovered, e.created, e.updated, e.merged, e.skipped, e.unsupported, e.failed, e.variance]),
    );
  }
  lines.push('-'.repeat(78));
  const t = manifest.totals;
  lines.push(
    pad('TOTAL', 20) +
      cols([t.discovered, t.created, t.updated, t.merged, t.skipped, t.unsupported, t.failed, t.discovered - t.accounted_for]),
  );
  lines.push('');
  lines.push(`Accounted for    : ${t.accounted_for} of ${t.discovered} discovered records`);
  lines.push(
    'Equation         : Discovered = Created + Updated + Merged + Skipped + Unsupported + Failed  ' +
      (t.discovered === t.accounted_for ? '[BALANCED]' : '[UNBALANCED]'),
  );
  lines.push('');

  if (manifest.files.discovered > 0) {
    lines.push('FILE RECONCILIATION');
    lines.push('-'.repeat(78));
    lines.push(`Discovered ${manifest.files.discovered}  Uploaded ${manifest.files.uploaded}  ` +
      `Failed ${manifest.files.failed}  Unsupported ${manifest.files.unsupported}  Pending ${manifest.files.pending}`);
    lines.push('');
  }

  lines.push('RELATIONSHIP INTEGRITY');
  lines.push('-'.repeat(78));
  for (const [key, value] of Object.entries(manifest.relationships)) {
    lines.push(`${pad(key.replace(/_/g, ' '), 40)} ${value}`);
  }
  // Stated explicitly so a reader is never left guessing whether a gap came
  // from the source or from the migration.
  lines.push(`${pad('  ...of which had no customer at source', 40)} ${manifest.relationship_analysis.jobsContactlessAtSource}`);
  lines.push(`${pad('  ...lost their customer in migration', 40)} ${manifest.relationship_analysis.jobsOrphanedByMigration}`);
  lines.push('');

  if (manifest.errors.length > 0) {
    lines.push('OPEN ERRORS');
    lines.push('-'.repeat(78));
    for (const e of manifest.errors) {
      lines.push(`${pad(e.error_code, 26)}${pad(e.entity ?? '-', 16)}${String(e.count).padStart(6)}  ${e.retryable ? 'retryable' : 'not retryable'}`);
      lines.push(`  ${e.summary}`);
    }
    lines.push('');
  }

  if (manifest.warnings.length > 0) {
    lines.push('WARNINGS');
    lines.push('-'.repeat(78));
    for (const w of manifest.warnings) {
      lines.push(`${pad(w.warning_code, 32)}${pad(w.entity ?? '-', 16)}${String(w.count).padStart(6)}`);
    }
    lines.push('');
  }

  lines.push('VALIDATION');
  lines.push('-'.repeat(78));
  lines.push(`Result: ${manifest.validation_passed ? 'PASSED' : 'FAILED'}`);
  if (manifest.outstanding_actions.length > 0) {
    lines.push('');
    lines.push('Outstanding actions:');
    for (const action of manifest.outstanding_actions) lines.push(`  - ${action}`);
  }
  lines.push(rule);

  return lines.join('\n');
}

function pad(value: string, width: number): string {
  return value.length >= width ? `${value.slice(0, width - 1)} ` : value.padEnd(width);
}

function cols(values: Array<string | number>): string {
  return values.map((v) => String(v).padStart(7)).join('');
}

export { recordsRepo };
