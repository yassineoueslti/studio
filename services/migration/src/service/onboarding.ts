import { getPool, withTransaction, type Sql } from '../db/pool.js';
import * as migrationsRepo from '../db/repositories/migrations.js';
import * as recordsRepo from '../db/repositories/records.js';
import { MigrationError } from '../domain/errors.js';
import type { Principal } from '../domain/permissions.js';

/**
 * Onboarding workflow: migration passes, the go-live checklist and the SLA.
 *
 * This models how BuilderLync migrations are actually delivered, which the
 * Aug 21 delivery meeting settled:
 *
 *   1. HISTORICAL  — bulk load everything up to a cutoff. Client training runs
 *                    *alongside* this, not after, so mapping and custom-field
 *                    feedback arrives while there is still time to act on it.
 *   2. DELTA       — optional catch-up passes for records changed since the
 *                    historical cutoff, run as often as useful during training.
 *   3. FINAL_DELTA — the last pass, run against a quiet source immediately
 *                    before go-live.
 *
 * The engine could already do delta runs. What was missing was *naming the
 * passes*, so an operator can answer "which pass is this, and what still has to
 * happen before go-live" without reading batch tables.
 */

export const PASS_TYPES = ['HISTORICAL', 'DELTA', 'FINAL_DELTA'] as const;
export type PassType = (typeof PASS_TYPES)[number];

export interface PassRow {
  id: string;
  migration_id: string;
  pass_type: PassType;
  pass_number: number;
  extracted_since: Date | null;
  watermark_at: Date | null;
  records_created: number;
  records_updated: number;
  records_skipped: number;
  records_failed: number;
  started_at: Date;
  completed_at: Date | null;
  status: string;
}

/**
 * The standard onboarding checklist.
 *
 * Data tasks belong to whoever runs the migration; configuration tasks belong
 * to whoever sets up the customer's account. Both must be done before go-live,
 * and they proceed in parallel — which is exactly why they need to be tracked
 * in one place rather than in two people's heads.
 */
export const DEFAULT_CHECKLIST: ReadonlyArray<{
  task_key: string;
  label: string;
  category: 'data' | 'configuration' | 'training' | 'signoff';
  blocks_go_live: boolean;
}> = Object.freeze([
  // --- data -------------------------------------------------------------
  { task_key: 'source_connected', label: 'Source CRM connected and connection tested', category: 'data', blocks_go_live: true },
  { task_key: 'discovery_reviewed', label: 'Discovery counts reviewed with the client', category: 'data', blocks_go_live: true },
  { task_key: 'field_mapping_agreed', label: 'Field and custom-field mapping agreed with the client', category: 'data', blocks_go_live: true },
  { task_key: 'stage_mapping_agreed', label: 'Pipeline, stage and status mapping agreed', category: 'data', blocks_go_live: true },
  { task_key: 'user_mapping_agreed', label: 'User mapping agreed, including historical employees', category: 'data', blocks_go_live: true },
  { task_key: 'historical_pass_complete', label: 'Historical migration pass complete', category: 'data', blocks_go_live: true },
  { task_key: 'qa_performed', label: 'QA performed on migrated data', category: 'data', blocks_go_live: true },
  { task_key: 'duplicates_resolved', label: 'Duplicate candidates reviewed and resolved', category: 'data', blocks_go_live: true },
  { task_key: 'files_verified', label: 'Documents and photos verified against the source', category: 'data', blocks_go_live: false },
  { task_key: 'final_delta_complete', label: 'Final delta pass complete', category: 'data', blocks_go_live: true },

  // --- account configuration --------------------------------------------
  { task_key: 'onboarding_form_received', label: 'Client onboarding form and checklist received', category: 'configuration', blocks_go_live: true },
  { task_key: 'users_created', label: 'BuilderLync users created and roles assigned', category: 'configuration', blocks_go_live: true },
  { task_key: 'instant_estimator_configured', label: 'Instant estimator configured', category: 'configuration', blocks_go_live: false },
  { task_key: 'proposal_module_configured', label: 'Proposal module configured', category: 'configuration', blocks_go_live: false },
  { task_key: 'integrations_configured', label: 'Third-party integrations configured', category: 'configuration', blocks_go_live: false },

  // --- training ----------------------------------------------------------
  { task_key: 'training_scheduled', label: 'Client training scheduled (runs alongside migration)', category: 'training', blocks_go_live: true },
  { task_key: 'training_delivered', label: 'Client training delivered', category: 'training', blocks_go_live: true },
  { task_key: 'mapping_feedback_applied', label: 'Mapping feedback from training applied', category: 'training', blocks_go_live: false },

  // --- sign-off ----------------------------------------------------------
  { task_key: 'client_accepted', label: 'Client reviewed and accepted the migration report', category: 'signoff', blocks_go_live: true },
  { task_key: 'go_live_scheduled', label: 'Go-live date agreed with the client', category: 'signoff', blocks_go_live: true },
]);

export interface OnboardingTask {
  id: string;
  task_key: string;
  label: string;
  category: string;
  blocks_go_live: boolean;
  status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'NOT_APPLICABLE';
  owner: string | null;
  notes: string | null;
  completed_at: Date | null;
}

export interface GoLiveReadiness {
  migration_id: string;
  ready: boolean;
  /** False before the checklist exists. Distinguishes "not started" from "done". */
  checklist_initialized: boolean;
  current_pass: PassType;
  /** Outstanding items that block go-live, in checklist order. */
  blockers: Array<{ task_key: string; label: string; category: string; status: string }>;
  tasks: OnboardingTask[];
  progress: { done: number; total: number; percent: number };
  sla: {
    days: number;
    started_at: Date | null;
    due_at: Date | null;
    days_remaining: number | null;
    breached: boolean;
  };
  passes: PassRow[];
}

export class OnboardingService {
  /**
   * Create the checklist for a migration. Idempotent, so calling it again after
   * the checklist has been worked on adds any newly-introduced tasks without
   * resetting existing ones.
   */
  async initializeChecklist(principal: Principal, migrationId: string): Promise<OnboardingTask[]> {
    await this.requireMigration(principal, migrationId);

    await withTransaction(async (client) => {
      for (const task of DEFAULT_CHECKLIST) {
        await client.query(
          `INSERT INTO migration_onboarding_tasks
             (migration_id, tenant_id, task_key, label, category, blocks_go_live)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (migration_id, task_key) DO NOTHING`,
          [migrationId, principal.tenantId, task.task_key, task.label, task.category, task.blocks_go_live],
        );
      }
    });

    return this.listTasks(principal, migrationId);
  }

  async listTasks(principal: Principal, migrationId: string): Promise<OnboardingTask[]> {
    const { rows } = await getPool().query<OnboardingTask>(
      `SELECT id, task_key, label, category, blocks_go_live, status, owner, notes, completed_at
         FROM migration_onboarding_tasks
        WHERE tenant_id = $1 AND migration_id = $2
        ORDER BY category, task_key`,
      [principal.tenantId, migrationId],
    );
    return rows;
  }

  async updateTask(
    principal: Principal,
    migrationId: string,
    taskKey: string,
    update: { status?: OnboardingTask['status']; owner?: string | null; notes?: string | null },
  ): Promise<OnboardingTask> {
    await this.requireMigration(principal, migrationId);

    const { rows } = await getPool().query<OnboardingTask>(
      `UPDATE migration_onboarding_tasks
          SET status = coalesce($4, status),
              owner = coalesce($5, owner),
              notes = coalesce($6, notes),
              completed_at = CASE WHEN $4 = 'DONE' THEN now()
                                  WHEN $4 IS NOT NULL THEN NULL
                                  ELSE completed_at END,
              completed_by = CASE WHEN $4 = 'DONE' THEN $7 ELSE completed_by END,
              updated_at = now()
        WHERE tenant_id = $1 AND migration_id = $2 AND task_key = $3
        RETURNING id, task_key, label, category, blocks_go_live, status, owner, notes, completed_at`,
      [
        principal.tenantId, migrationId, taskKey,
        update.status ?? null, update.owner ?? null, update.notes ?? null, principal.userId,
      ],
    );

    const task = rows[0];
    if (!task) {
      throw new MigrationError('SOURCE_NOT_FOUND', `Onboarding task "${taskKey}" was not found on this migration.`, {
        migrationId,
      });
    }
    return task;
  }

  /**
   * Can this client go live?
   *
   * Deliberately answers with the *list of blockers*, not just a boolean. "Not
   * ready" is useless to an onboarding specialist; "not ready because QA has
   * not been performed and the final delta has not run" is actionable.
   */
  async goLiveReadiness(principal: Principal, migrationId: string): Promise<GoLiveReadiness> {
    const migration = await this.requireMigration(principal, migrationId);
    const tasks = await this.listTasks(principal, migrationId);
    const passes = await this.listPasses(principal, migrationId);

    const relevant = tasks.filter((t) => t.status !== 'NOT_APPLICABLE');
    const done = relevant.filter((t) => t.status === 'DONE').length;

    const blockers = tasks
      .filter((t) => t.blocks_go_live && t.status !== 'DONE' && t.status !== 'NOT_APPLICABLE')
      .map((t) => ({ task_key: t.task_key, label: t.label, category: t.category, status: t.status }));

    // A migration with no checklist has not been through onboarding at all, so
    // it has zero blockers -- and reporting "ready" on that basis would tell an
    // onboarding specialist a client is clear to go live before anyone has
    // looked at them. An empty checklist means uninitialized, not finished.
    const checklistInitialized = tasks.length > 0;

    const slaDays = migration.onboarding_sla_days ?? 30;
    const startedAt = migration.started_at ?? migration.created_at ?? null;
    const dueAt = startedAt ? new Date(startedAt.getTime() + slaDays * 86_400_000) : null;
    const daysRemaining = dueAt ? Math.ceil((dueAt.getTime() - Date.now()) / 86_400_000) : null;

    return {
      migration_id: migrationId,
      ready: checklistInitialized && blockers.length === 0,
      checklist_initialized: checklistInitialized,
      current_pass: (migration.current_pass as PassType) ?? 'HISTORICAL',
      blockers,
      tasks,
      progress: {
        done,
        total: relevant.length,
        percent: relevant.length > 0 ? Math.round((done / relevant.length) * 100) : 0,
      },
      sla: {
        days: slaDays,
        started_at: startedAt,
        due_at: dueAt,
        days_remaining: daysRemaining,
        // Only an unfinished migration can breach: one that shipped inside the
        // window does not retroactively breach as the calendar moves on.
        breached: dueAt !== null && Date.now() > dueAt.getTime() && !(checklistInitialized && blockers.length === 0),
      },
      passes,
    };
  }

  // -------------------------------------------------------------------------
  // Passes
  // -------------------------------------------------------------------------

  async listPasses(principal: Principal, migrationId: string): Promise<PassRow[]> {
    const { rows } = await getPool().query<PassRow>(
      `SELECT * FROM migration_passes
        WHERE tenant_id = $1 AND migration_id = $2 ORDER BY pass_number`,
      [principal.tenantId, migrationId],
    );
    return rows;
  }

  /**
   * Open a new pass and return the instant the extraction should read from.
   *
   * The returned `extractedSince` is what the orchestrator uses as
   * `updatedSince`. For a historical pass it is null (take everything). For a
   * delta pass it is the previous pass's watermark, so no window is ever
   * skipped between passes.
   */
  async beginPass(
    principal: Principal,
    migrationId: string,
    passType: PassType,
  ): Promise<{ pass: PassRow; extractedSince: Date | null }> {
    const migration = await this.requireMigration(principal, migrationId);

    if (passType !== 'HISTORICAL') {
      const previous = await this.listPasses(principal, migrationId);
      if (previous.length === 0) {
        throw new MigrationError(
          'VALIDATION_ERROR',
          'A delta pass cannot run before the historical pass. Run the historical pass first.',
          { migrationId },
        );
      }
    }

    // The watermark is captured *before* extraction starts, not after. A record
    // changed while this pass runs must be picked up by the NEXT pass; taking
    // the watermark at the end would skip it forever.
    const watermarkAt = new Date();
    const extractedSince = passType === 'HISTORICAL' ? null : migration.delta_watermark ?? null;

    return withTransaction(async (client) => {
      const { rows: numbering } = await client.query<{ next: number }>(
        'SELECT coalesce(max(pass_number), 0) + 1 AS next FROM migration_passes WHERE migration_id = $1',
        [migrationId],
      );
      const passNumber = numbering[0]?.next ?? 1;

      const { rows } = await client.query<PassRow>(
        `INSERT INTO migration_passes
           (migration_id, tenant_id, pass_type, pass_number, extracted_since, watermark_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,'RUNNING')
         RETURNING *`,
        [migrationId, principal.tenantId, passType, passNumber, extractedSince, watermarkAt],
      );

      await client.query(
        'UPDATE migrations SET current_pass = $2, updated_at = now() WHERE id = $1',
        [migrationId, passType],
      );

      // A delta pass opens a NEW extraction window, so the checkpoints left by
      // the previous pass must be cleared. `extraction_complete` means "this
      // entity is finished *for that pass*", not "finished forever" -- leaving
      // it set makes a delta pass skip every entity and silently import
      // nothing.
      //
      // Clearing them is safe precisely because idempotency does not depend on
      // checkpoints: migration_object_map still holds every source-to-
      // destination mapping, so records the previous pass already loaded are
      // skipped on their content hash rather than re-created.
      //
      // A HISTORICAL pass is left alone: it may be a resume of an interrupted
      // first run, which must continue from where it stopped.
      if (passType !== 'HISTORICAL') {
        await client.query(
          `UPDATE migration_checkpoints
              SET cursor_json = NULL, batch_number = 0, records_processed = 0,
                  extraction_complete = FALSE, updated_at = now()
            WHERE migration_id = $1`,
          [migrationId],
        );
      }

      await migrationsRepo.recordAudit(client, {
        migrationId, tenantId: principal.tenantId, actorId: principal.userId,
        action: 'migration.started',
        detail: { pass_type: passType, pass_number: passNumber, extracted_since: extractedSince },
      });

      return { pass: rows[0] as PassRow, extractedSince };
    });
  }

  /** Close the open pass, record its totals, and advance the delta watermark. */
  async completePass(principal: Principal, migrationId: string): Promise<PassRow | null> {
    await this.requireMigration(principal, migrationId);
    const passes = await this.listPasses(principal, migrationId);
    const open = passes.find((p) => p.status === 'RUNNING');
    if (!open) return null;

    const counts = await recordsRepo.countsByEntity(principal.tenantId, migrationId);
    const totals = counts.reduce(
      (acc, c) => ({
        created: acc.created + c.created,
        updated: acc.updated + c.updated,
        skipped: acc.skipped + c.skipped,
        failed: acc.failed + c.failed,
      }),
      { created: 0, updated: 0, skipped: 0, failed: 0 },
    );

    return withTransaction(async (client) => {
      const { rows } = await client.query<PassRow>(
        `UPDATE migration_passes
            SET status = 'COMPLETED', completed_at = now(),
                records_created = $2, records_updated = $3,
                records_skipped = $4, records_failed = $5
          WHERE id = $1 RETURNING *`,
        [open.id, totals.created, totals.updated, totals.skipped, totals.failed],
      );

      // The next delta reads from this pass's watermark.
      await client.query(
        'UPDATE migrations SET delta_watermark = $2, updated_at = now() WHERE id = $1',
        [migrationId, open.watermark_at],
      );

      // Keep the checklist honest without making someone tick a box the system
      // already knows the answer to.
      const taskKey = open.pass_type === 'HISTORICAL' ? 'historical_pass_complete'
        : open.pass_type === 'FINAL_DELTA' ? 'final_delta_complete'
        : null;
      if (taskKey) {
        await client.query(
          `UPDATE migration_onboarding_tasks
              SET status = 'DONE', completed_at = now(), completed_by = $3, updated_at = now()
            WHERE migration_id = $1 AND task_key = $2 AND status <> 'DONE'`,
          [migrationId, taskKey, principal.userId],
        );
      }

      return rows[0] ?? null;
    });
  }

  private async requireMigration(principal: Principal, migrationId: string) {
    const migration = await migrationsRepo.getMigration(getPool(), principal.tenantId, migrationId);
    if (!migration) {
      throw new MigrationError('SOURCE_NOT_FOUND', `Migration ${migrationId} was not found.`, { migrationId });
    }
    return migration as migrationsRepo.MigrationRow & {
      current_pass?: string;
      delta_watermark?: Date | null;
      onboarding_sla_days?: number;
    };
  }
}

export type { Sql };
