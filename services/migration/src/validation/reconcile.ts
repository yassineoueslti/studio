import { withTransaction } from '../db/pool.js';
import * as errorsRepo from '../db/repositories/errors.js';
import * as recordsRepo from '../db/repositories/records.js';
import type { DestinationClient, RelationshipIntegrityReport } from '../destination/types.js';
import type { EntityType } from '../domain/entities.js';
import { fileCounts } from '../files/transfer.js';
import { getPool } from '../db/pool.js';
import * as migrationsRepo from '../db/repositories/migrations.js';

/**
 * Validation and reconciliation (Guide §17, Scope §37-39).
 *
 * The single rule this module enforces:
 *
 *     Discovered = Created + Updated + Merged + Skipped + Unsupported + Failed
 *
 * Guide §17 states the consequence plainly: no migration may show Completed
 * unless every discovered record is accounted for. That is implemented here as
 * a hard gate, not as a warning -- `overallPassed` is what the API consults
 * before allowing a COMPLETED transition.
 */

export interface CountReconciliation {
  entity: EntityType;
  discovered: number;
  created: number;
  updated: number;
  merged: number;
  skipped: number;
  unsupported: number;
  failed: number;
  inFlight: number;
  accountedFor: number;
  /** discovered - accountedFor. Non-zero means records are unexplained. */
  variance: number;
  passed: boolean;
}

export interface DiscoveryReconciliation {
  entity: EntityType;
  /** What the source said it had, at discovery time (Scope §15). */
  sourceDiscovered: number;
  /** What the ledger actually registered during extraction. */
  ledgerDiscovered: number;
  variance: number;
  passed: boolean;
  /**
   * 'reconciled'   the customer selected this entity, so the counts must agree
   * 'not_selected' discovered at the source but deliberately excluded from the
   *                migration; reported for transparency, never a defect
   */
  status: 'reconciled' | 'not_selected';
  note?: string;
}

export interface FileReconciliation {
  discovered: number;
  uploaded: number;
  failed: number;
  unsupported: number;
  pending: number;
  variance: number;
  passed: boolean;
}

export interface RelationshipAnalysis {
  /** Jobs in the destination with no contact, for any reason. */
  jobsWithoutContact: number;
  /** Of those, jobs the source itself recorded with no customer. */
  jobsContactlessAtSource: number;
  /**
   * Jobs that HAD a customer at the source but lost it in transit. This is the
   * number that indicates a migration defect; the other two do not.
   */
  jobsOrphanedByMigration: number;
}

export interface ReconciliationReport {
  migrationId: string;
  tenantId: string;
  generatedAt: Date;
  counts: CountReconciliation[];
  discovery: DiscoveryReconciliation[];
  files: FileReconciliation;
  relationships: RelationshipIntegrityReport;
  relationshipAnalysis: RelationshipAnalysis;
  relationshipsPassed: boolean;
  duplicatesPendingReview: number;
  openErrors: number;
  openWarnings: number;
  overallPassed: boolean;
  blockingReasons: string[];
}

export async function reconcile(
  destination: DestinationClient,
  tenantId: string,
  migrationId: string,
): Promise<ReconciliationReport> {
  const [ledgerCounts, discoveryRows, files, relationships, duplicates, errorSummary, warningSummary, contactlessAtSource] =
    await Promise.all([
      recordsRepo.countsByEntity(tenantId, migrationId),
      errorsRepo.getDiscovery(tenantId, migrationId),
      fileCounts(tenantId, migrationId),
      destination.relationshipIntegrity(tenantId, migrationId),
      errorsRepo.listDuplicateCandidates(tenantId, migrationId, 'PENDING'),
      errorsRepo.summarizeErrors(tenantId, migrationId),
      errorsRepo.summarizeWarnings(tenantId, migrationId),
      countJobsContactlessAtSource(tenantId, migrationId),
    ]);

  const migration = await migrationsRepo.getMigration(getPool(), tenantId, migrationId);
  const selectedEntities = (migration?.configuration_json?.selectedEntities as EntityType[] | undefined) ?? [];
  const selection = new Set(selectedEntities);

  // --- Step 17.1: count reconciliation ------------------------------------
  const counts: CountReconciliation[] = ledgerCounts.map((row) => {
    const accountedFor = row.created + row.updated + row.merged + row.skipped + row.unsupported + row.failed;
    const variance = row.discovered - accountedFor;
    return {
      entity: row.entity_type,
      discovered: row.discovered,
      created: row.created,
      updated: row.updated,
      merged: row.merged,
      skipped: row.skipped,
      unsupported: row.unsupported,
      failed: row.failed,
      inFlight: row.in_flight,
      accountedFor,
      variance,
      passed: variance === 0,
    };
  });

  // --- discovery vs ledger ------------------------------------------------
  // A source that reported 5,000 contacts but from which only 4,900 were
  // extracted is a real defect (a silently truncated page), and it is invisible
  // to the equation above -- which balances perfectly over whatever was
  // extracted. Comparing against the discovery scan is what catches it.
  //
  // Only entities the customer SELECTED are reconciled. Discovery deliberately
  // scans the whole source so the customer can see everything available
  // (Scope §15), and the wizard then lets them choose a subset (Scope §32
  // step 4). Counting an unselected entity as missing would treat that choice
  // as data loss and permanently block completion for every partial migration
  // -- which is the normal case, not the exception.
  const ledgerByEntity = new Map(ledgerCounts.map((r) => [r.entity_type, r.discovered]));
  const discovery: DiscoveryReconciliation[] = discoveryRows
    .filter((row) => row.supported && row.discovered_count > 0)
    .map((row) => {
      const ledgerDiscovered = ledgerByEntity.get(row.entity_type) ?? 0;
      const variance = row.discovered_count - ledgerDiscovered;

      // An empty selection means "everything the adapter supports".
      const wasSelected = selection.size === 0 || selection.has(row.entity_type);

      if (!wasSelected) {
        return {
          entity: row.entity_type,
          sourceDiscovered: row.discovered_count,
          ledgerDiscovered,
          variance,
          passed: true,
          status: 'not_selected' as const,
          note: `${row.discovered_count} record(s) exist at the source but this entity was not selected for migration.`,
        };
      }

      return {
        entity: row.entity_type,
        sourceDiscovered: row.discovered_count,
        ledgerDiscovered,
        variance,
        // Extracting *more* than discovery predicted is normal (records added
        // at the source mid-migration). Extracting fewer is not.
        passed: variance <= 0,
        status: 'reconciled' as const,
        ...(variance > 0
          ? { note: `${variance} record(s) reported by discovery were never extracted.` }
          : {}),
      };
    });

  // --- Step 17.3: file reconciliation -------------------------------------
  const fileVariance = files.discovered - (files.uploaded + files.failed + files.unsupported);
  const fileReconciliation: FileReconciliation = {
    ...files,
    variance: fileVariance,
    passed: fileVariance === 0 && files.pending === 0,
  };

  // --- Step 17.2: relationship validation ---------------------------------
  // Scope §39 lists these as checks to *report*, not as automatic failures.
  // A contractor legitimately has customers with no jobs, and legitimately has
  // jobs entered with no customer -- Scope §60 names "jobs without customers"
  // as an edge case to carry across, not to reject. Faithfully reproducing a
  // gap the source already had is correct migration behaviour.
  //
  // What is NOT acceptable is a job that HAD a customer and lost it in transit.
  // Only that number blocks completion.
  const relationshipAnalysis: RelationshipAnalysis = {
    jobsWithoutContact: relationships.jobs_without_contact,
    jobsContactlessAtSource: contactlessAtSource,
    jobsOrphanedByMigration: Math.max(0, relationships.jobs_without_contact - contactlessAtSource),
  };

  const relationshipsPassed =
    relationshipAnalysis.jobsOrphanedByMigration === 0 &&
    relationships.files_without_parent === 0 &&
    relationships.records_referencing_missing_user === 0;

  const openErrors = errorSummary.reduce((sum, e) => sum + e.count, 0);
  const openWarnings = warningSummary.reduce((sum, w) => sum + w.count, 0);

  const blockingReasons: string[] = [];
  for (const count of counts) {
    if (!count.passed) {
      blockingReasons.push(
        `${count.entity}: ${count.discovered} discovered but only ${count.accountedFor} accounted for ` +
          `(${count.inFlight} still in flight, variance ${count.variance}).`,
      );
    }
  }
  for (const row of discovery) {
    if (!row.passed) {
      blockingReasons.push(
        `${row.entity}: discovery found ${row.sourceDiscovered} records but only ${row.ledgerDiscovered} were extracted.`,
      );
    }
  }
  if (!fileReconciliation.passed) {
    blockingReasons.push(
      `files: ${files.discovered} discovered, ${files.uploaded} uploaded, ${files.failed} failed, ` +
        `${files.unsupported} unsupported, ${files.pending} still pending.`,
    );
  }
  if (!relationshipsPassed) {
    blockingReasons.push(
      `relationships: ${relationshipAnalysis.jobsOrphanedByMigration} job(s) lost their customer during migration ` +
        `(${relationshipAnalysis.jobsWithoutContact} total without a contact, of which ` +
        `${relationshipAnalysis.jobsContactlessAtSource} had none at the source), ` +
        `${relationships.files_without_parent} file(s) without a parent, ` +
        `${relationships.records_referencing_missing_user} record(s) pointing at a missing user.`,
    );
  }

  const report: ReconciliationReport = {
    migrationId,
    tenantId,
    generatedAt: new Date(),
    counts,
    discovery,
    files: fileReconciliation,
    relationships,
    relationshipAnalysis,
    relationshipsPassed,
    duplicatesPendingReview: duplicates.length,
    openErrors,
    openWarnings,
    overallPassed: blockingReasons.length === 0,
    blockingReasons,
  };

  await persist(tenantId, migrationId, report);
  return report;
}

async function persist(tenantId: string, migrationId: string, report: ReconciliationReport): Promise<void> {
  await withTransaction(async (client) => {
    await errorsRepo.clearValidationResults(client, tenantId, migrationId);

    for (const count of report.counts) {
      await errorsRepo.saveValidationResult(client, {
        migrationId, tenantId, step: 'object_count_reconciliation',
        entity: count.entity, passed: count.passed, detail: { ...count },
      });
    }
    for (const row of report.discovery) {
      await errorsRepo.saveValidationResult(client, {
        migrationId, tenantId, step: 'discovery_reconciliation',
        entity: row.entity, passed: row.passed, detail: { ...row },
      });
    }
    await errorsRepo.saveValidationResult(client, {
      migrationId, tenantId, step: 'file_reconciliation',
      passed: report.files.passed, detail: { ...report.files },
    });
    await errorsRepo.saveValidationResult(client, {
      migrationId, tenantId, step: 'relationship_reconciliation',
      passed: report.relationshipsPassed,
      detail: { ...report.relationships, ...report.relationshipAnalysis },
    });
    await errorsRepo.saveValidationResult(client, {
      migrationId, tenantId, step: 'duplicate_detection',
      passed: true, detail: { pending_review: report.duplicatesPendingReview },
    });
    await errorsRepo.saveValidationResult(client, {
      migrationId, tenantId, step: 'error_review',
      passed: report.openErrors === 0,
      detail: { open_errors: report.openErrors, open_warnings: report.openWarnings },
    });
  });
}

/**
 * Jobs the source itself recorded without a customer.
 *
 * The adapter raises a JOB_WITHOUT_CONTACT warning during normalization when a
 * source job carries no customer reference, so the warning ledger already knows
 * which gaps pre-existed the migration. Counting distinct source ids (rather
 * than warning rows) keeps the number stable across retries, which each write a
 * fresh warning for the same record.
 */
async function countJobsContactlessAtSource(tenantId: string, migrationId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(DISTINCT source_id)::int AS n
       FROM migration_warnings
      WHERE tenant_id = $1 AND migration_id = $2 AND warning_code = 'JOB_WITHOUT_CONTACT'`,
    [tenantId, migrationId],
  );
  return rows[0]?.n ?? 0;
}
