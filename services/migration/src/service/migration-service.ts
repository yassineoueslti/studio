import { CANONICAL_SCHEMA_VERSION, type SourcePlatform } from '../canonical/common.js';
import { getPool, withTransaction } from '../db/pool.js';
import * as errorsRepo from '../db/repositories/errors.js';
import * as migrationsRepo from '../db/repositories/migrations.js';
import * as recordsRepo from '../db/repositories/records.js';
import { getDestination } from '../destination/index.js';
import type { DestinationClient } from '../destination/types.js';
import { ACTIVE_MIGRATION_STATES, COMPLETED_MIGRATION_STATES, type MigrationState } from '../domain/states.js';
import { missingDependencies, sequence, type EntityType } from '../domain/entities.js';
import { MigrationError } from '../domain/errors.js';
import * as permissions from '../domain/permissions.js';
import type { Principal } from '../domain/permissions.js';
import { fileCounts } from '../files/transfer.js';
import { silentLogger, type Logger } from '../observability/logger.js';
import { buildManifest, MIGRATION_REPORT_VERSION, type MigrationManifest } from '../reporting/report.js';
import { reconcile, type ReconciliationReport } from '../validation/reconcile.js';
import { supports, supportedEntities, type AdapterContext, type SourceAdapter } from '../adapters/types.js';
import { Orchestrator, type OrchestratorOptions } from '../pipeline/orchestrator.js';
import { OnboardingService, type PassType } from './onboarding.js';

/**
 * The migration service: the control plane behind the API (Guide §4).
 *
 * Everything a customer or n8n can trigger goes through here, and every entry
 * point does three things before touching data: resolve the principal's
 * permission (Scope §48), scope the query to the principal's tenant
 * (Scope §47), and write an audit entry (Scope §49).
 */

export interface ServiceDeps {
  destination?: DestinationClient;
  logger?: Logger;
  /**
   * Adapters are supplied by the caller rather than resolved by name, because
   * the mock adapter carries a generated dataset and a real adapter carries
   * decrypted credentials -- neither belongs in a global lookup table.
   */
  adapterFor: (platform: SourcePlatform, migrationId: string) => Promise<SourceAdapter> | SourceAdapter;
}

export class MigrationService {
  private readonly destination: DestinationClient;
  private readonly logger: Logger;
  private readonly adapterFor: ServiceDeps['adapterFor'];
  /**
   * In-flight run controls, so pause/cancel can interrupt a running worker.
   * Keyed by tenant *and* migration so the presence of a key can never reveal
   * another tenant's activity.
   */
  private readonly running = new Map<string, AbortController>();

  /**
   * Migrations an operator deliberately stopped. The orchestrator reports a
   * deliberate stop the same way it reports a crash -- by throwing -- so
   * without this the run's error path would overwrite the operator's chosen
   * state with FAILED.
   */
  private readonly interrupted = new Map<string, 'paused' | 'cancelled'>();

  /** Migration passes, the go-live checklist and the onboarding SLA. */
  readonly onboarding = new OnboardingService();

  constructor(deps: ServiceDeps) {
    this.destination = deps.destination ?? getDestination();
    this.logger = deps.logger ?? silentLogger;
    this.adapterFor = deps.adapterFor;
  }

  // --- POST /api/migrations ----------------------------------------------
  async create(
    principal: Principal,
    input: { sourcePlatform: SourcePlatform; sourceTenantId?: string | null; configuration?: Record<string, unknown> },
  ): Promise<migrationsRepo.MigrationRow> {
    permissions.require(principal, 'migration.create');

    const adapter = await this.adapterFor(input.sourcePlatform, 'pending');
    const migration = await migrationsRepo.createMigration({
      tenantId: principal.tenantId,
      sourcePlatform: input.sourcePlatform,
      sourceTenantId: input.sourceTenantId ?? null,
      createdBy: principal.userId,
      configuration: input.configuration ?? {},
      connectorVersion: adapter.connectorVersion,
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      destinationApiVersion: this.destination.apiVersion,
    });

    await migrationsRepo.recordAudit(getPool(), {
      migrationId: migration.id, tenantId: principal.tenantId, actorId: principal.userId,
      action: 'migration.created', detail: { source_platform: input.sourcePlatform },
    });

    return migration;
  }

  // --- GET /api/migrations/{id} ------------------------------------------
  async get(principal: Principal, migrationId: string): Promise<migrationsRepo.MigrationRow> {
    permissions.require(principal, 'migration.view');
    return this.requireMigration(principal, migrationId);
  }

  async list(principal: Principal): Promise<migrationsRepo.MigrationRow[]> {
    permissions.require(principal, 'migration.view');
    return migrationsRepo.listMigrations(principal.tenantId);
  }

  // --- POST /api/migrations/{id}/test-connection -------------------------
  async testConnection(principal: Principal, migrationId: string) {
    permissions.require(principal, 'migration.configure');
    const migration = await this.requireMigration(principal, migrationId);
    const adapter = await this.adapterFor(migration.source_platform as SourcePlatform, migrationId);

    if (migration.status === 'DRAFT') {
      await migrationsRepo.transitionState(principal.tenantId, migrationId, 'CONNECTION_TEST');
    }

    const result = await adapter.testConnection(this.contextFor(migration));

    await migrationsRepo.recordAudit(getPool(), {
      migrationId, tenantId: principal.tenantId, actorId: principal.userId,
      action: 'migration.connection_tested',
      // The result may name resources but never a credential.
      detail: { ok: result.ok, resources: result.resourceAccess?.length ?? 0 },
    });

    return result;
  }

  // --- POST /api/migrations/{id}/discover --------------------------------
  async discover(principal: Principal, migrationId: string) {
    permissions.require(principal, 'migration.configure');
    const migration = await this.requireMigration(principal, migrationId);
    const adapter = await this.adapterFor(migration.source_platform as SourcePlatform, migrationId);

    await migrationsRepo.transitionState(principal.tenantId, migrationId, 'DISCOVERING');
    await migrationsRepo.recordAudit(getPool(), {
      migrationId, tenantId: principal.tenantId, actorId: principal.userId, action: 'migration.discovery_started',
    });

    try {
      // Guide §7.3: discovery reads and counts; it must not write CRM data.
      const discovery = await adapter.discover(this.contextFor(migration));

      await withTransaction((client) =>
        errorsRepo.saveDiscovery(client, {
          migrationId, tenantId: principal.tenantId, counts: discovery.counts,
        }),
      );

      if (discovery.sourceTenantId && !migration.source_tenant_id) {
        await getPool().query('UPDATE migrations SET source_tenant_id = $2 WHERE id = $1', [
          migrationId, discovery.sourceTenantId,
        ]);
      }

      await migrationsRepo.transitionState(principal.tenantId, migrationId, 'READY_FOR_MAPPING');
      await migrationsRepo.recordAudit(getPool(), {
        migrationId, tenantId: principal.tenantId, actorId: principal.userId,
        action: 'migration.discovery_completed',
        detail: { total_estimated_objects: discovery.totalEstimatedObjects },
      });

      return discovery;
    } catch (err) {
      await migrationsRepo.transitionState(principal.tenantId, migrationId, 'FAILED');
      throw err;
    }
  }

  async getDiscovery(principal: Principal, migrationId: string) {
    permissions.require(principal, 'migration.view');
    await this.requireMigration(principal, migrationId);
    return errorsRepo.getDiscovery(principal.tenantId, migrationId);
  }

  // --- GET/PUT /api/migrations/{id}/mappings -----------------------------
  async getMappings(principal: Principal, migrationId: string): Promise<Record<string, unknown>> {
    permissions.require(principal, 'migration.view');
    await this.requireMigration(principal, migrationId);

    const { rows } = await getPool().query<{ mapping_type: string; config_json: unknown }>(
      'SELECT mapping_type, config_json FROM migration_mappings WHERE tenant_id = $1 AND migration_id = $2',
      [principal.tenantId, migrationId],
    );
    return Object.fromEntries(rows.map((r) => [r.mapping_type, r.config_json]));
  }

  async putMappings(principal: Principal, migrationId: string, mappings: Record<string, unknown>): Promise<void> {
    permissions.require(principal, 'migration.configure');
    await this.requireMigration(principal, migrationId);

    await withTransaction(async (client) => {
      for (const [type, config] of Object.entries(mappings)) {
        await client.query(
          `INSERT INTO migration_mappings (migration_id, tenant_id, mapping_type, config_json)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (migration_id, mapping_type)
           DO UPDATE SET config_json = EXCLUDED.config_json, updated_at = now()`,
          [migrationId, principal.tenantId, type, JSON.stringify(config)],
        );
      }
      await migrationsRepo.recordAudit(client, {
        migrationId, tenantId: principal.tenantId, actorId: principal.userId,
        action: 'migration.mappings_changed', detail: { mapping_types: Object.keys(mappings) },
      });
    });
  }

  /**
   * Preflight (Scope §16, Guide §15.7). Everything that can be checked without
   * writing is checked here, so Start is blocked before it does damage rather
   * than failing at 40%.
   */
  async preflight(principal: Principal, migrationId: string): Promise<{
    passed: boolean;
    checks: Array<{ name: string; passed: boolean; detail: string }>;
  }> {
    permissions.require(principal, 'migration.view');
    const migration = await this.requireMigration(principal, migrationId);
    const adapter = await this.adapterFor(migration.source_platform as SourcePlatform, migrationId);
    const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

    const connection = await adapter.testConnection(this.contextFor(migration));
    checks.push({ name: 'authentication', passed: connection.ok, detail: connection.message });

    const inaccessible = (connection.resourceAccess ?? []).filter((r) => !r.accessible);
    checks.push({
      name: 'source_permissions',
      passed: inaccessible.length === 0,
      detail: inaccessible.length === 0
        ? 'The connected credential can read every supported object.'
        : `No access to: ${inaccessible.map((r) => r.entity).join(', ')}. ${inaccessible[0]?.reason ?? ''}`,
    });

    const selected = this.selectedEntities(migration, adapter);
    checks.push({
      name: 'entity_selection',
      passed: selected.length > 0,
      detail: selected.length > 0
        ? `${selected.length} entity type(s) selected: ${selected.join(', ')}.`
        : 'No supported entity types are selected for migration.',
    });

    // Selecting jobs without contacts silently orphans every job, so it is
    // named here rather than discovered in the relationship reconciliation.
    //
    // Only dependencies the *source can actually provide* are blocking. A job
    // depending on status_definition is not a customer error when the source
    // has no status_definition object to offer -- that is a known capability
    // limit, reported as context rather than as something to go fix.
    const gaps = missingDependencies(selected)
      .map((gap) => ({
        entity: gap.entity,
        actionable: gap.missing.filter((dep) => supports(adapter.capabilities, dep)),
        unavailable: gap.missing.filter((dep) => !supports(adapter.capabilities, dep)),
      }))
      .filter((gap) => gap.actionable.length > 0 || gap.unavailable.length > 0);

    const actionableGaps = gaps.filter((g) => g.actionable.length > 0);
    const unavailableNote = gaps
      .filter((g) => g.unavailable.length > 0)
      .map((g) => `${g.entity} normally links to ${g.unavailable.join(', ')}, which ${adapter.platform} does not expose`)
      .join('; ');

    checks.push({
      name: 'entity_dependencies',
      passed: actionableGaps.length === 0,
      detail: actionableGaps.length > 0
        ? actionableGaps.map((g) => `${g.entity} depends on unselected ${g.actionable.join(', ')}`).join('; ')
        : unavailableNote
          ? `All selectable dependencies are selected. Source capability limits: ${unavailableNote}.`
          : 'All selected entities have their dependencies selected.',
    });

    checks.push({
      name: 'destination_tenant',
      passed: Boolean(principal.tenantId) && migration.tenant_id === principal.tenantId,
      detail: `Destination tenant resolved server-side as "${migration.tenant_id}".`,
    });

    const conflicting = await migrationsRepo.findActiveMigrations(principal.tenantId, ACTIVE_MIGRATION_STATES, migrationId);
    checks.push({
      name: 'no_conflicting_migration',
      passed: conflicting.length === 0,
      detail: conflicting.length === 0
        ? 'No other migration is active for this account.'
        : `${conflicting.length} other migration(s) are currently active: ${conflicting.map((m) => m.id).join(', ')}.`,
    });

    const discovery = await errorsRepo.getDiscovery(principal.tenantId, migrationId);
    checks.push({
      name: 'discovery_complete',
      passed: discovery.length > 0,
      detail: discovery.length > 0
        ? `Discovery recorded ${discovery.length} entity type(s).`
        : 'Discovery has not been run for this migration.',
    });

    return { passed: checks.every((c) => c.passed), checks };
  }

  // --- POST /api/migrations/{id}/start -----------------------------------
  async start(
    principal: Principal,
    migrationId: string,
    options: {
      skipPreflight?: boolean;
      runnerOptions?: Partial<OrchestratorOptions>;
      /**
       * Which pass this run is (Aug 21 delivery model). Defaults to
       * HISTORICAL for a first run and DELTA for a re-run, which is what an
       * operator means in each case.
       */
      pass?: PassType;
    } = {},
  ): Promise<{ started: boolean; preflight?: Awaited<ReturnType<MigrationService['preflight']>> }> {
    permissions.require(principal, 'migration.start');
    const migration = await this.requireMigration(principal, migrationId);

    if (!options.skipPreflight) {
      const preflight = await this.preflight(principal, migrationId);
      if (!preflight.passed) return { started: false, preflight };
    }

    if (migration.status === 'READY_FOR_MAPPING') {
      await migrationsRepo.transitionState(principal.tenantId, migrationId, 'READY');
    }
    await migrationsRepo.transitionState(principal.tenantId, migrationId, 'QUEUED', { startedAt: true });
    await migrationsRepo.recordAudit(getPool(), {
      migrationId, tenantId: principal.tenantId, actorId: principal.userId, action: 'migration.started',
    });

    // The checklist exists from the first run, so training and configuration
    // can proceed alongside the data load rather than queueing behind it.
    await this.onboarding.initializeChecklist(principal, migrationId);

    const existingPasses = await this.onboarding.listPasses(principal, migrationId);
    const passType: PassType = options.pass ?? (existingPasses.length === 0 ? 'HISTORICAL' : 'DELTA');
    const { extractedSince } = await this.onboarding.beginPass(principal, migrationId, passType);

    await this.execute(principal, migrationId, {
      ...(options.runnerOptions ?? {}),
      // A delta pass extracts only what changed since the previous pass's
      // watermark. A historical pass takes everything.
      updatedSince: extractedSince,
    });

    await this.onboarding.completePass(principal, migrationId);
    return { started: true };
  }

  /**
   * Drive the transfer phases. Separated from start() so resume() and retry()
   * re-enter the same code path -- resume is not a special mode, it is the
   * ordinary run observing the checkpoints the previous attempt left behind.
   */
  async execute(
    principal: Principal,
    migrationId: string,
    runnerOptions: Partial<OrchestratorOptions> = {},
  ): Promise<void> {
    const key = this.runKey(principal.tenantId, migrationId);

    // Check-and-reserve with no await in between, so two concurrent callers
    // cannot both pass. Without this, both would drive the same migration:
    // same-state transitions are permitted, so the state machine does not stop
    // them, and every remaining page would be extracted and loaded twice.
    if (this.running.has(key)) {
      throw new MigrationError(
        'VALIDATION_ERROR',
        `Migration ${migrationId} is already running. Pause it before starting another run.`,
        { migrationId },
      );
    }
    const controller = new AbortController();
    this.running.set(key, controller);

    try {
      const migration = await this.requireMigration(principal, migrationId);
      const adapter = await this.adapterFor(migration.source_platform as SourcePlatform, migrationId);
      const context = this.contextFor(migration);
      const selected = this.selectedEntities(migration, adapter);

      await migrationsRepo.transitionState(principal.tenantId, migrationId, 'EXTRACTING');

      const orchestrator = new Orchestrator({
        adapter,
        destination: this.destination,
        logger: this.logger,
        signal: controller.signal,
        ...runnerOptions,
      });

      await migrationsRepo.transitionState(principal.tenantId, migrationId, 'IMPORTING');
      await orchestrator.run(context, selected);

      await migrationsRepo.transitionState(principal.tenantId, migrationId, 'VALIDATING');
      const reconciliation = await reconcile(this.destination, principal.tenantId, migrationId);

      // Scope §38 / Guide §17: COMPLETED requires every discovered record to be
      // accounted for. Anything less lands in WAITING_FOR_REVIEW, which is a
      // state a human must clear -- it is not silently reported as success.
      const next: MigrationState = reconciliation.overallPassed
        ? reconciliation.openErrors > 0 || reconciliation.duplicatesPendingReview > 0
          ? 'COMPLETED_WITH_WARNINGS'
          : 'COMPLETED'
        : 'WAITING_FOR_REVIEW';

      await migrationsRepo.transitionState(principal.tenantId, migrationId, next, {
        completedAt: COMPLETED_MIGRATION_STATES.includes(next),
      });
      await this.refreshStatistics(principal.tenantId, migrationId);

      await migrationsRepo.recordAudit(getPool(), {
        migrationId, tenantId: principal.tenantId, actorId: principal.userId,
        action: 'migration.completed',
        detail: { final_state: next, validation_passed: reconciliation.overallPassed },
      });
    } catch (err) {
      // A deliberate pause or cancel reaches here as a thrown MigrationAborted,
      // indistinguishable from a crash by type alone. Forcing FAILED here would
      // overwrite the state the operator just chose, so the operator's intent
      // wins and their state stands.
      if (!this.interrupted.has(key)) {
        // A genuine crash leaves the migration FAILED, not stuck mid-phase.
        // Checkpoints are durable, so resume() continues from the last safe
        // point.
        try {
          await migrationsRepo.transitionState(principal.tenantId, migrationId, 'FAILED');
        } catch (bookkeepingError) {
          // Recording the failure must never replace the reason for it. A
          // caller debugging a migration needs the original error, not an
          // error about writing down the original error.
          this.logger.error('Could not record FAILED state after a migration error', {
            migration_id: migrationId,
            tenant_id: principal.tenantId,
            error: (bookkeepingError as Error).message,
          });
        }
      }

      try {
        await this.refreshStatistics(principal.tenantId, migrationId);
      } catch {
        // Statistics are a convenience; losing them must not mask the error.
      }

      throw err;
    } finally {
      this.running.delete(key);
      this.interrupted.delete(key);
    }
  }

  /** Run-control key. Tenant-scoped so presence never leaks across tenants. */
  private runKey(tenantId: string, migrationId: string): string {
    return `${tenantId}:${migrationId}`;
  }

  // --- pause / resume / cancel (Scope §34) -------------------------------
  async pause(principal: Principal, migrationId: string): Promise<void> {
    permissions.require(principal, 'migration.pause');
    await this.requireMigration(principal, migrationId);
    // Intent is recorded BEFORE the abort, so the run's error path can already
    // see that this stop was deliberate by the time it unwinds.
    const key = this.runKey(principal.tenantId, migrationId);
    this.interrupted.set(key, 'paused');
    // Pause completes the current safe batch: the controller is checked between
    // batches, never mid-write, so state is always consistent on stop.
    this.running.get(key)?.abort();
    await migrationsRepo.transitionState(principal.tenantId, migrationId, 'PAUSED');
    await migrationsRepo.recordAudit(getPool(), {
      migrationId, tenantId: principal.tenantId, actorId: principal.userId, action: 'migration.paused',
    });
  }

  async resume(principal: Principal, migrationId: string, runnerOptions: Partial<OrchestratorOptions> = {}): Promise<void> {
    permissions.require(principal, 'migration.start');
    await this.requireMigration(principal, migrationId);
    await migrationsRepo.transitionState(principal.tenantId, migrationId, 'QUEUED');
    await migrationsRepo.recordAudit(getPool(), {
      migrationId, tenantId: principal.tenantId, actorId: principal.userId, action: 'migration.resumed',
    });
    await this.execute(principal, migrationId, runnerOptions);
  }

  async cancel(principal: Principal, migrationId: string): Promise<void> {
    permissions.require(principal, 'migration.cancel');
    await this.requireMigration(principal, migrationId);
    const key = this.runKey(principal.tenantId, migrationId);
    this.interrupted.set(key, 'cancelled');
    this.running.get(key)?.abort();
    await migrationsRepo.transitionState(principal.tenantId, migrationId, 'CANCELLED');
    await migrationsRepo.recordAudit(getPool(), {
      migrationId, tenantId: principal.tenantId, actorId: principal.userId, action: 'migration.cancelled',
    });
  }

  // --- GET /api/migrations/{id}/status -----------------------------------
  async status(principal: Principal, migrationId: string) {
    permissions.require(principal, 'migration.view');
    const migration = await this.requireMigration(principal, migrationId);

    const [counts, batches, checkpoints, files, errors, warnings] = await Promise.all([
      recordsRepo.countsByEntity(principal.tenantId, migrationId),
      recordsRepo.listBatches(principal.tenantId, migrationId),
      recordsRepo.listCheckpoints(principal.tenantId, migrationId),
      fileCounts(principal.tenantId, migrationId),
      errorsRepo.summarizeErrors(principal.tenantId, migrationId),
      errorsRepo.summarizeWarnings(principal.tenantId, migrationId),
    ]);

    const totals = counts.reduce(
      (acc, c) => ({
        discovered: acc.discovered + c.discovered,
        created: acc.created + c.created,
        updated: acc.updated + c.updated,
        merged: acc.merged + c.merged,
        skipped: acc.skipped + c.skipped,
        unsupported: acc.unsupported + c.unsupported,
        failed: acc.failed + c.failed,
        remaining: acc.remaining + c.in_flight,
      }),
      { discovered: 0, created: 0, updated: 0, merged: 0, skipped: 0, unsupported: 0, failed: 0, remaining: 0 },
    );

    const active = batches.find((b) => b.status === 'PROCESSING');
    const lastCheckpoint = checkpoints.slice().sort((a, b) => b.records_processed - a.records_processed)[0];

    // Scope §33: the live statistics panel.
    return {
      migration_id: migrationId,
      status: migration.status,
      source_platform: migration.source_platform,
      started_at: migration.started_at,
      completed_at: migration.completed_at,
      totals,
      warnings: warnings.reduce((s, w) => s + w.count, 0),
      by_entity: counts,
      files,
      current_entity: active?.entity_type ?? null,
      current_batch: active?.batch_label ?? null,
      last_successful_checkpoint: lastCheckpoint
        ? { entity: lastCheckpoint.entity_type, records_processed: lastCheckpoint.records_processed }
        : null,
      open_errors: errors.reduce((sum, e) => sum + e.count, 0),
      progress_percent: totals.discovered > 0
        ? Math.round(((totals.discovered - totals.remaining) / totals.discovered) * 100)
        : 0,
    };
  }

  // --- GET /api/migrations/{id}/errors -----------------------------------
  async errors(principal: Principal, migrationId: string, filter: errorsRepo.ErrorFilter = {}) {
    permissions.require(principal, 'migration.view');
    await this.requireMigration(principal, migrationId);
    return {
      summary: await errorsRepo.summarizeErrors(principal.tenantId, migrationId),
      errors: await errorsRepo.listErrors(principal.tenantId, migrationId, filter),
    };
  }

  // --- POST /api/migrations/{id}/retry -----------------------------------
  /**
   * Scope §29 retry levels 2 and 3. Retry re-runs the pipeline; because writes
   * are idempotent, records that already succeeded are skipped rather than
   * duplicated, so a retry is always safe to issue.
   */
  async retry(
    principal: Principal,
    migrationId: string,
    options: { entity?: EntityType; scope?: 'failed_records' | 'failed_batches' | 'all' } = {},
  ): Promise<{ requeued: number }> {
    permissions.require(principal, 'migration.retry');
    await this.requireMigration(principal, migrationId);

    const scope = options.scope ?? 'failed_records';
    const failed = await recordsRepo.findFailedRecords(principal.tenantId, migrationId, { entity: options.entity });

    // Reset the failed records to DISCOVERED so the next run picks them up,
    // and re-open their checkpoint so extraction revisits their pages.
    await withTransaction(async (client) => {
      if (failed.length > 0) {
        await client.query(
          `UPDATE migration_records SET state = 'DISCOVERED', disposition = NULL, updated_at = now()
            WHERE migration_id = $1 AND id = ANY($2::uuid[])`,
          [migrationId, failed.map((f) => f.id)],
        );
      }
      if (scope === 'all' || scope === 'failed_batches') {
        await client.query(
          `UPDATE migration_checkpoints SET extraction_complete = FALSE, cursor_json = NULL, batch_number = 0, updated_at = now()
            WHERE migration_id = $1 AND ($2::text IS NULL OR entity_type = $2::text)`,
          [migrationId, options.entity ?? null],
        );
      }
      await client.query(
        `UPDATE migration_files SET state = 'DISCOVERED', attempt_count = 0, next_retry_at = NULL, updated_at = now()
          WHERE migration_id = $1 AND state = 'FAILED'`,
        [migrationId],
      );
      await migrationsRepo.recordAudit(client, {
        migrationId, tenantId: principal.tenantId, actorId: principal.userId,
        action: 'migration.retried', detail: { scope, entity: options.entity ?? null, records: failed.length },
      });
    });

    return { requeued: failed.length };
  }

  // --- POST /api/migrations/{id}/validate --------------------------------
  async validate(principal: Principal, migrationId: string): Promise<ReconciliationReport> {
    permissions.require(principal, 'migration.view');
    await this.requireMigration(principal, migrationId);
    const report = await reconcile(this.destination, principal.tenantId, migrationId);
    await migrationsRepo.recordAudit(getPool(), {
      migrationId, tenantId: principal.tenantId, actorId: principal.userId,
      action: 'migration.validated', detail: { passed: report.overallPassed },
    });
    return report;
  }

  // --- GET /api/migrations/{id}/report -----------------------------------
  async report(principal: Principal, migrationId: string): Promise<MigrationManifest> {
    permissions.require(principal, 'migration.view');
    await this.requireMigration(principal, migrationId);
    return buildManifest(this.destination, principal.tenantId, migrationId);
  }

  // --- Scope §62: customer acceptance ------------------------------------
  async accept(principal: Principal, migrationId: string): Promise<void> {
    permissions.require(principal, 'migration.configure');
    const migration = await this.requireMigration(principal, migrationId);
    if (!COMPLETED_MIGRATION_STATES.includes(migration.status)) {
      throw new MigrationError(
        'VALIDATION_ERROR',
        `A migration can only be accepted once it has completed. Current status: ${migration.status}.`,
        { migrationId },
      );
    }
    await migrationsRepo.acceptMigration(principal.tenantId, migrationId, principal.userId, MIGRATION_REPORT_VERSION);
    await migrationsRepo.recordAudit(getPool(), {
      migrationId, tenantId: principal.tenantId, actorId: principal.userId, action: 'migration.accepted',
    });
  }

  // --- helpers -----------------------------------------------------------

  private async requireMigration(principal: Principal, migrationId: string): Promise<migrationsRepo.MigrationRow> {
    const migration = await migrationsRepo.getMigration(getPool(), principal.tenantId, migrationId);
    if (!migration) {
      // Scope §47: a cross-tenant id is reported as not-found rather than
      // "forbidden", so the API cannot be used to probe for other tenants' ids.
      throw new MigrationError('SOURCE_NOT_FOUND', `Migration ${migrationId} was not found.`, { migrationId });
    }
    return migration;
  }

  private contextFor(migration: migrationsRepo.MigrationRow): AdapterContext {
    return {
      migrationId: migration.id,
      tenantId: migration.tenant_id,
      sourceTenantId: migration.source_tenant_id,
      // Real adapters receive decrypted credentials from the secrets layer;
      // the mock adapter needs none.
      credentials: { type: 'none' },
      options: migration.configuration_json,
    };
  }

  /** Customer selection, intersected with what the adapter actually supports. */
  private selectedEntities(migration: migrationsRepo.MigrationRow, adapter: SourceAdapter): EntityType[] {
    const configured = migration.configuration_json?.selectedEntities as EntityType[] | undefined;
    const candidates = configured?.length ? configured : supportedEntities(adapter.capabilities);
    return sequence(candidates.filter((e) => supports(adapter.capabilities, e))).map((p) => p.entity);
  }

  private async refreshStatistics(tenantId: string, migrationId: string): Promise<void> {
    const counts = await recordsRepo.countsByEntity(tenantId, migrationId);
    const files = await fileCounts(tenantId, migrationId);
    await migrationsRepo.updateStatistics(tenantId, migrationId, {
      by_entity: counts, files, updated_at: new Date().toISOString(),
    });
  }
}
