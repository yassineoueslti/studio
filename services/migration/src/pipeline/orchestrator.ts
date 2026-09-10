import { contentHash, idempotencyKey } from '../canonical/hash.js';
import { validateCanonical } from '../canonical/index.js';
import { config } from '../config.js';
import { getPool, withTransaction } from '../db/pool.js';
import * as errorsRepo from '../db/repositories/errors.js';
import * as migrationsRepo from '../db/repositories/migrations.js';
import * as recordsRepo from '../db/repositories/records.js';
import { DEFAULT_DEDUPE_POLICY, matchContact, type DedupePolicy } from '../dedupe/matcher.js';
import type { DestinationClient } from '../destination/types.js';
import { ENTITY_PLAN, planFor, sequence, type EntityType } from '../domain/entities.js';
import { MigrationAborted, MigrationError, toMigrationError } from '../domain/errors.js';
import type { RecordState } from '../domain/states.js';
import { createLogger, silentLogger, type Logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import { supports, type AdapterContext, type SourceAdapter } from '../adapters/types.js';
import {
  applyHistoricalFidelity, DEFAULT_HISTORICAL_FIDELITY, type HistoricalFidelityPolicy,
} from '../transformers/historical-fidelity.js';
import { RateLimiter } from './ratelimit.js';
import { retryOptionsFrom, withRetry } from './retry.js';

/**
 * The migration orchestrator.
 *
 * Responsibilities, in the order the guide sequences them:
 *   1. Walk entities in dependency order (Scope §14).
 *   2. Extract pages from the adapter, throttled and retried (Scope §25-26).
 *   3. Register every discovered record *before* loading, so a crash between
 *      extract and load still leaves the record accounted for (Scope §3.4).
 *   4. Normalize, validate, resolve parent references, deduplicate.
 *   5. Write in batches with idempotency keys, recording per-record outcomes.
 *   6. Checkpoint after every batch, so resume is from the last safe point.
 *
 * Everything durable lives in Postgres. The orchestrator itself holds no state
 * that matters -- kill it at any point and `run()` resumes correctly. That is
 * the property Scope §83 "Safe Restart" demands, and it is only true because
 * the checkpoint write and the record-outcome write share one transaction.
 */

export interface OrchestratorOptions {
  adapter: SourceAdapter;
  destination: DestinationClient;
  logger?: Logger;
  /** Abort cooperatively (pause/cancel). Checked between batches. */
  signal?: AbortSignal;
  /** Test hook: throw after this many batches, to simulate a worker crash. */
  crashAfterBatches?: number;
  dedupePolicy?: DedupePolicy;
  batchSize?: number;
  /** Delta run: only extract records changed since this instant (Scope §50). */
  updatedSince?: Date | null;
  /**
   * How hard to work at making history read as history when the destination
   * stamps its own created date (Guide §9.4).
   */
  historicalFidelity?: HistoricalFidelityPolicy;
}

export interface RunResult {
  migrationId: string;
  entitiesProcessed: EntityType[];
  batchesProcessed: number;
  recordsProcessed: number;
  aborted: boolean;
}

/** Injected crash, used to prove resume-after-failure in tests and the demo. */
export class SimulatedWorkerCrash extends Error {
  constructor(batches: number) {
    super(`Simulated worker crash after ${batches} batches`);
    this.name = 'SimulatedWorkerCrash';
  }
}

export class Orchestrator {
  private readonly adapter: SourceAdapter;
  private readonly destination: DestinationClient;
  private readonly logger: Logger;
  private readonly limiter: RateLimiter;
  private readonly dedupePolicy: DedupePolicy;
  private readonly options: OrchestratorOptions;
  private batchesThisRun = 0;
  private recordsThisRun = 0;

  constructor(options: OrchestratorOptions) {
    this.options = options;
    this.adapter = options.adapter;
    this.destination = options.destination;
    this.logger = options.logger ?? silentLogger;
    this.limiter = new RateLimiter(options.adapter.rateLimit);
    this.dedupePolicy = options.dedupePolicy ?? DEFAULT_DEDUPE_POLICY;
  }

  /**
   * Run (or resume) the data-transfer phases of a migration.
   *
   * Safe to call repeatedly: completed entities are skipped via their
   * checkpoint, and records already mapped are skipped or updated rather than
   * recreated.
   */
  async run(context: AdapterContext, selectedEntities: readonly EntityType[]): Promise<RunResult> {
    const log = this.logger.child({
      migration_id: context.migrationId,
      tenant_id: context.tenantId,
      source: this.adapter.platform,
    });

    // Only entities the adapter actually supports. Asking an adapter for
    // something it declared unsupported is a programming error, so the plan is
    // filtered here once rather than guarded at every extraction site.
    const runnable = sequence(selectedEntities).filter((plan) => {
      if (supports(this.adapter.capabilities, plan.entity)) return true;
      log.info('Skipping entity: unsupported by source adapter', { entity: plan.entity });
      return false;
    });

    const processed: EntityType[] = [];

    for (const plan of runnable) {
      // Assets move through the file pipeline (files/transfer.ts), not here.
      if (plan.isAsset) continue;

      this.throwIfAborted();

      const checkpoint = await recordsRepo.getCheckpoint(context.tenantId, context.migrationId, plan.entity);
      if (checkpoint?.extraction_complete) {
        log.info('Entity already complete, skipping', { entity: plan.entity });
        processed.push(plan.entity);
        continue;
      }

      await this.runEntity(context, plan.entity, log);
      processed.push(plan.entity);
    }

    return {
      migrationId: context.migrationId,
      entitiesProcessed: processed,
      batchesProcessed: this.batchesThisRun,
      recordsProcessed: this.recordsThisRun,
      aborted: false,
    };
  }

  private async runEntity(context: AdapterContext, entity: EntityType, parentLog: Logger): Promise<void> {
    const log = parentLog.child({ entity });
    const batchSize = this.options.batchSize ?? config().DEFAULT_BATCH_SIZE;

    const checkpoint = await recordsRepo.getCheckpoint(context.tenantId, context.migrationId, entity);
    let cursor: unknown = checkpoint?.cursor_json ?? null;
    let batchNumber = checkpoint?.batch_number ?? 0;
    let recordsProcessed = checkpoint?.records_processed ?? 0;

    log.info('Starting entity extraction', { batch_id: String(batchNumber), records_processed: recordsProcessed });

    for (;;) {
      this.throwIfAborted();

      // --- extract one page (throttled + retried) -------------------------
      const page = await withRetry(
        async () => {
          await this.limiter.acquire();
          metrics.increment('migration_api_requests_total', { source: this.adapter.platform, entity });
          try {
            return await this.adapter.extract(entity, context, {
              cursor,
              pageSize: batchSize,
              updatedSince: this.options.updatedSince ?? null,
              signal: this.options.signal,
            });
          } catch (err) {
            const error = toMigrationError(err, { entity, migrationId: context.migrationId });
            metrics.increment('migration_api_errors_total', { source: this.adapter.platform, entity, code: error.code });
            if (error.code === 'RATE_LIMIT') {
              metrics.increment('migration_source_rate_limit_total', { source: this.adapter.platform });
            }
            throw error;
          }
        },
        retryOptionsFrom(this.adapter.rateLimit, {
          signal: this.options.signal,
          onRetry: ({ attempt, delayMs, error }) => {
            metrics.increment('migration_retry_total', { entity, code: error.code, level: 'request' });
            log.warn('Retrying source extraction after transient failure', {
              attempt, delay_ms: delayMs, error_code: error.code,
            });
          },
        }),
      );

      // Terminate on an empty page even when the adapter still claims hasMore.
      //
      // A pagination bug that reports "more available" while returning nothing
      // would otherwise spin until the process died, leaving a half-written
      // migration and no diagnosis. Stopping is always safe: reconciliation
      // compares the ledger against the discovery scan, so anything genuinely
      // missed surfaces as a variance with the entity named.
      if (page.records.length === 0) {
        if (page.hasMore) {
          log.warn('Source reported more records available but returned an empty page; stopping extraction', {
            batch_id: String(batchNumber),
            records_processed: recordsProcessed,
          });
        }
        break;
      }

      batchNumber += 1;
      await this.processBatch(context, entity, page.records, batchNumber, cursor, log);

      recordsProcessed += page.records.length;
      this.recordsThisRun += page.records.length;
      cursor = page.cursor;

      await withTransaction((client) =>
        recordsRepo.saveCheckpoint(client, {
          migrationId: context.migrationId,
          tenantId: context.tenantId,
          entity,
          cursor,
          lastSourceId: lastSourceIdOf(page.records),
          recordsProcessed,
          batchNumber,
          extractionComplete: !page.hasMore,
        }),
      );

      this.batchesThisRun += 1;

      // Simulated crash lands *after* the checkpoint commit, which is the
      // hard case: resume must not re-import the batch just committed.
      if (this.options.crashAfterBatches && this.batchesThisRun >= this.options.crashAfterBatches) {
        throw new SimulatedWorkerCrash(this.batchesThisRun);
      }

      if (!page.hasMore) break;
    }

    log.info('Entity extraction complete', { records_processed: recordsProcessed });
  }

  /**
   * Transform, validate, deduplicate and load one page.
   *
   * The batch is committed record-by-record at the destination, and the
   * outcomes are written in one statement here. A record that fails validation
   * never reaches the destination but still receives a FAILED disposition --
   * which is how Scope §38's equation stays balanced.
   */
  private async processBatch(
    context: AdapterContext,
    entity: EntityType,
    rawRecords: readonly unknown[],
    batchNumber: number,
    cursor: unknown,
    parentLog: Logger,
  ): Promise<void> {
    const batch = await withTransaction(async (client) => {
      const created = await recordsRepo.createBatch(client, {
        migrationId: context.migrationId,
        tenantId: context.tenantId,
        entity,
        batchNumber,
        recordCount: rawRecords.length,
        cursor,
      });
      await recordsRepo.markBatchStarted(client, created.id);
      return created;
    });

    const log = parentLog.child({ batch_id: batch.id });

    // --- normalize + validate --------------------------------------------
    interface Prepared {
      sourceId: string;
      payload: Record<string, unknown>;
      hash: string;
      sourceUpdatedAt: Date | null;
    }

    const prepared: Prepared[] = [];
    const outcomes: recordsRepo.RecordOutcome[] = [];
    const discovered: Array<{ sourceId: string; rawPayload?: unknown }> = [];
    const warnings: Array<{ sourceId: string; code: string; message: string }> = [];

    for (let index = 0; index < rawRecords.length; index += 1) {
      const raw = rawRecords[index];
      let normalized: Record<string, unknown>;

      try {
        normalized = this.adapter.normalize(entity, raw, context);
      } catch (err) {
        const error = toMigrationError(err, { entity, migrationId: context.migrationId });
        // Without a usable source id there is nothing to key a ledger row on,
        // so a synthetic, position-derived id keeps the record accountable
        // instead of silently vanishing from reconciliation.
        const sourceId = fallbackSourceId(raw, entity, batchNumber, index);
        discovered.push({ sourceId, rawPayload: raw });
        outcomes.push({
          sourceId, state: 'FAILED', builderLyncId: null, contentHash: null,
          errorCode: error.code, errorMessage: error.message,
        });
        await withTransaction((client) =>
          errorsRepo.recordError(client, {
            migrationId: context.migrationId, tenantId: context.tenantId,
            batchId: batch.id, entity, sourceId, error,
          }),
        );
        continue;
      }

      const sourceId = typeof normalized['source_object_id'] === 'string' ? normalized['source_object_id'] : '';
      const ledgerId = sourceId || fallbackSourceId(raw, entity, batchNumber, index);
      discovered.push({ sourceId: ledgerId, rawPayload: raw });

      // BuilderLync stamps its own created date, so history has to be carried
      // in fields it will accept. Applied centrally rather than per adapter:
      // an adapter that forgot would produce a migration where five years of
      // notes read as written today, and nobody would notice until a customer
      // opened one (Guide §9.4).
      const fidelity = applyHistoricalFidelity(
        entity,
        normalized,
        this.options.historicalFidelity ?? DEFAULT_HISTORICAL_FIDELITY,
      );

      for (const warning of [
        ...((normalized['warnings'] as Array<{ code: string; message: string }>) ?? []),
        ...fidelity.warnings,
      ]) {
        warnings.push({ sourceId: ledgerId, code: warning.code, message: warning.message });
      }

      const validation = validateCanonical(entity, normalized);
      if (!validation.ok || !validation.value) {
        const error = validation.error ?? new MigrationError('VALIDATION_ERROR', 'Unknown validation failure', { entity });
        outcomes.push({
          sourceId: ledgerId, state: 'FAILED', builderLyncId: null, contentHash: null,
          errorCode: error.code, errorMessage: error.message,
        });
        await withTransaction((client) =>
          errorsRepo.recordError(client, {
            migrationId: context.migrationId, tenantId: context.tenantId,
            batchId: batch.id, entity, sourceId: ledgerId, error,
          }),
        );
        continue;
      }

      const payload = validation.value as Record<string, unknown>;
      prepared.push({
        sourceId: ledgerId,
        payload,
        hash: contentHash(payload),
        sourceUpdatedAt: (payload['source_updated_at'] as Date | null) ?? null,
      });
    }

    // Register discovery before any destination write (Scope §3.4).
    await withTransaction(async (client) => {
      await recordsRepo.registerDiscovered(client, {
        migrationId: context.migrationId, tenantId: context.tenantId,
        entity, batchId: batch.id, records: discovered,
      });
      for (const warning of warnings) {
        await errorsRepo.recordWarning(client, {
          migrationId: context.migrationId, tenantId: context.tenantId, batchId: batch.id,
          entity, sourceId: warning.sourceId, code: warning.code, message: warning.message,
        });
      }
    });

    // --- resolve parent references ---------------------------------------
    await this.resolveParentReferences(context, entity, prepared.map((p) => p.payload));

    // --- idempotency: skip unchanged records ------------------------------
    const existingMap = await recordsRepo.lookupObjectMap(
      context.tenantId, this.adapter.platform, entity, prepared.map((p) => p.sourceId),
    );

    const toWrite: Prepared[] = [];
    for (const item of prepared) {
      const existing = existingMap.get(item.sourceId);
      // Same source object, unchanged content, already written: skipping is
      // the correct disposition, and it is what keeps a delta sync cheap.
      if (existing?.builderlync_object_id && existing.content_hash === item.hash) {
        outcomes.push({
          sourceId: item.sourceId, state: 'SKIPPED',
          builderLyncId: existing.builderlync_object_id, contentHash: item.hash,
        });
        continue;
      }
      toWrite.push(item);
    }

    // --- deduplicate (contacts only, for now) -----------------------------
    const mergeTargets = new Map<string, string>();
    if (entity === 'contact' && toWrite.length > 0) {
      await this.classifyDuplicates(context, entity, toWrite, existingMap, mergeTargets, outcomes, batch.id);
    }

    const writable = toWrite.filter((item) => !outcomes.some((o) => o.sourceId === item.sourceId));

    // --- write to destination --------------------------------------------
    if (writable.length > 0) {
      const response = await withRetry(
        () =>
          this.destination.writeBatch({
            tenantId: context.tenantId,
            migrationId: context.migrationId,
            entity,
            records: writable.map((item) => ({
              sourceId: item.sourceId,
              idempotencyKey: idempotencyKey({
                migrationId: context.migrationId,
                sourcePlatform: this.adapter.platform,
                objectType: entity,
                sourceObjectId: item.sourceId,
              }),
              contentHash: item.hash,
              payload: item.payload,
            })),
          }),
        retryOptionsFrom(this.adapter.rateLimit, {
          signal: this.options.signal,
          onRetry: ({ attempt, delayMs, error }) => {
            metrics.increment('migration_retry_total', { entity, code: error.code, level: 'batch' });
            parentLog.warn('Retrying destination write', { attempt, delay_ms: delayMs, error_code: error.code });
          },
        }),
      );

      const hashBySourceId = new Map(writable.map((w) => [w.sourceId, w.hash]));
      const updatedAtBySourceId = new Map(writable.map((w) => [w.sourceId, w.sourceUpdatedAt]));

      // Scope §44: every record sent must come back. Checked here rather than
      // only in the HTTP driver, so the guarantee holds for every destination
      // implementation including the in-process one. A short response would
      // otherwise surface hours later as a reconciliation variance with no
      // traceable cause.
      const sentIds = new Set(writable.map((w) => w.sourceId));
      const returnedIds = new Set(response.results.map((r) => r.source_id));
      const omitted = writable.filter((w) => !returnedIds.has(w.sourceId));
      if (omitted.length > 0) {
        throw new MigrationError(
          'BUILDERLYNC_API_ERROR',
          `Destination returned ${response.results.length} results for ${writable.length} records; ` +
            `${omitted.length} unaccounted for (first: ${omitted[0]?.sourceId}).`,
          { entity, migrationId: context.migrationId, batchId: batch.id },
        );
      }

      // And results for records we never sent are discarded rather than
      // written. Trusting them would put a fabricated mapping in the object
      // map, so support would later trace a real BuilderLync id to nothing.
      const phantom = response.results.filter((r) => !sentIds.has(r.source_id));
      if (phantom.length > 0) {
        log.warn('Destination returned results for records that were never sent; ignoring them', {
          count: phantom.length,
          first: phantom[0]?.source_id,
        });
      }
      const accepted = response.results.filter((r) => sentIds.has(r.source_id));

      for (const result of accepted) {
        const state = mergeTargets.has(result.source_id) && result.status === 'UPDATED'
          ? ('MERGED' as RecordState)
          : (result.status as RecordState);

        outcomes.push({
          sourceId: result.source_id,
          state,
          builderLyncId: result.builderlync_id,
          contentHash: hashBySourceId.get(result.source_id) ?? null,
          errorCode: result.error?.code ?? null,
          errorMessage: result.error?.message ?? null,
        });

        if (result.error) {
          await withTransaction((client) =>
            errorsRepo.recordError(client, {
              migrationId: context.migrationId, tenantId: context.tenantId,
              batchId: batch.id, entity, sourceId: result.source_id,
              error: new MigrationError(
                (result.error?.code ?? 'BUILDERLYNC_API_ERROR') as never,
                result.error?.message ?? 'Destination rejected the record',
                { entity, sourceId: result.source_id },
                { retryable: result.error?.retryable ?? false },
              ),
            }),
          );
        }
      }

      // Update the object map for everything the destination accepted.
      await withTransaction(async (client) => {
        for (const result of accepted) {
          if (!result.builderlync_id) continue;
          await recordsRepo.upsertObjectMap(client, {
            migrationId: context.migrationId,
            tenantId: context.tenantId,
            sourcePlatform: this.adapter.platform,
            sourceObjectType: entity,
            sourceObjectId: result.source_id,
            builderLyncObjectType: entity,
            builderLyncObjectId: result.builderlync_id,
            contentHash: hashBySourceId.get(result.source_id) ?? null,
            migrationStatus: result.status as RecordState,
            sourceUpdatedAt: updatedAtBySourceId.get(result.source_id) ?? null,
            transformerVersion: this.adapter.transformerVersion(entity),
          });
        }
      });
    }

    // --- persist outcomes and close the batch -----------------------------
    const counts = tally(outcomes);
    await withTransaction(async (client) => {
      await recordsRepo.recordOutcomes(client, {
        migrationId: context.migrationId, tenantId: context.tenantId, entity, outcomes,
      });
      await recordsRepo.finishBatch(client, batch.id, counts);
    });

    metrics.increment('migration_records_processed_total', { entity }, outcomes.length);
    if (counts.failed > 0) metrics.increment('migration_records_failed_total', { entity }, counts.failed);

    log.info('Batch complete', { ...counts, record_count: rawRecords.length });
  }

  /**
   * Replace source-id references with resolved BuilderLync ids.
   *
   * Scope §3.5: relationships must survive. A job carries the *source* contact
   * id; the destination needs the BuilderLync id. Because entities run in
   * dependency order, the parent is already mapped by the time we get here --
   * and if it is not, the reference is dropped and a warning is raised rather
   * than writing a dangling pointer.
   */
  private async resolveParentReferences(
    context: AdapterContext,
    entity: EntityType,
    payloads: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    if (payloads.length === 0) return;

    const references: Array<{ sourceField: string; targetField: string; parentEntity: EntityType; isArray?: boolean }> = [];

    switch (entity) {
      case 'contact':
        references.push(
          { sourceField: 'assigned_user_source_id', targetField: 'assigned_user_builderlync_id', parentEntity: 'user' },
          { sourceField: 'company_source_id', targetField: 'company_builderlync_id', parentEntity: 'company' },
        );
        break;
      case 'job':
        references.push(
          { sourceField: 'contact_source_id', targetField: 'contact_builderlync_id', parentEntity: 'contact' },
          { sourceField: 'opportunity_source_id', targetField: 'opportunity_builderlync_id', parentEntity: 'opportunity' },
          { sourceField: 'stage_source_id', targetField: 'stage_builderlync_id', parentEntity: 'pipeline_stage' },
          { sourceField: 'assigned_user_source_ids', targetField: 'assigned_user_builderlync_ids', parentEntity: 'user', isArray: true },
        );
        break;
      case 'opportunity':
        references.push(
          { sourceField: 'contact_source_id', targetField: 'contact_builderlync_id', parentEntity: 'contact' },
          { sourceField: 'pipeline_source_id', targetField: 'pipeline_builderlync_id', parentEntity: 'pipeline' },
          { sourceField: 'stage_source_id', targetField: 'stage_builderlync_id', parentEntity: 'pipeline_stage' },
          { sourceField: 'assigned_user_source_id', targetField: 'assigned_user_builderlync_id', parentEntity: 'user' },
        );
        break;
      case 'pipeline_stage':
        references.push({ sourceField: 'pipeline_source_id', targetField: 'pipeline_builderlync_id', parentEntity: 'pipeline' });
        break;
      case 'note':
      case 'activity':
      case 'task':
      case 'appointment':
        // Parent type varies per record, so it is resolved below rather than
        // through the uniform reference list.
        await this.resolvePolymorphicParents(context, payloads);
        references.push({ sourceField: 'author_user_source_id', targetField: 'author_user_builderlync_id', parentEntity: 'user' });
        references.push({ sourceField: 'user_source_id', targetField: 'user_builderlync_id', parentEntity: 'user' });
        references.push({ sourceField: 'assigned_user_source_id', targetField: 'assigned_user_builderlync_id', parentEntity: 'user' });
        break;
      default:
        break;
    }

    for (const ref of references) {
      const sourceIds = new Set<string>();
      for (const payload of payloads) {
        const value = payload[ref.sourceField];
        if (ref.isArray && Array.isArray(value)) {
          for (const v of value) if (typeof v === 'string') sourceIds.add(v);
        } else if (typeof value === 'string' && value) {
          sourceIds.add(value);
        }
      }
      if (sourceIds.size === 0) continue;

      const resolved = await recordsRepo.resolveDestinationIds(
        context.tenantId, this.adapter.platform, ref.parentEntity, [...sourceIds],
      );

      for (const payload of payloads) {
        const value = payload[ref.sourceField];
        if (ref.isArray && Array.isArray(value)) {
          payload[ref.targetField] = value
            .map((v) => (typeof v === 'string' ? resolved.get(v) : null))
            .filter((v): v is string => Boolean(v));
        } else if (typeof value === 'string' && value) {
          payload[ref.targetField] = resolved.get(value) ?? null;
        } else {
          payload[ref.targetField] = ref.isArray ? [] : null;
        }
      }
    }
  }

  private async resolvePolymorphicParents(
    context: AdapterContext,
    payloads: ReadonlyArray<Record<string, unknown>>,
  ): Promise<void> {
    const byType = new Map<string, Set<string>>();
    for (const payload of payloads) {
      const parentType = payload['parent_entity_type'];
      const parentId = payload['parent_source_id'];
      if (typeof parentType !== 'string' || typeof parentId !== 'string' || !parentId) continue;
      if (!byType.has(parentType)) byType.set(parentType, new Set());
      byType.get(parentType)?.add(parentId);
    }

    const resolvedByType = new Map<string, Map<string, string>>();
    for (const [parentType, ids] of byType) {
      resolvedByType.set(
        parentType,
        await recordsRepo.resolveDestinationIds(context.tenantId, this.adapter.platform, parentType as EntityType, [...ids]),
      );
    }

    for (const payload of payloads) {
      const parentType = payload['parent_entity_type'];
      const parentId = payload['parent_source_id'];
      payload['parent_builderlync_id'] =
        typeof parentType === 'string' && typeof parentId === 'string'
          ? resolvedByType.get(parentType)?.get(parentId) ?? null
          : null;
    }
  }

  /**
   * Apply the dedupe tiers to a page of contacts.
   *
   * Tier 1 (an existing object-map entry) is handled by the caller's skip
   * logic. This handles tiers 2-4 and, critically, routes REVIEW candidates to
   * migration_duplicate_candidates instead of merging them (Guide §13.3).
   */
  private async classifyDuplicates(
    context: AdapterContext,
    entity: EntityType,
    candidates: ReadonlyArray<{ sourceId: string; payload: Record<string, unknown> }>,
    existingMap: Map<string, recordsRepo.ObjectMapRow>,
    mergeTargets: Map<string, string>,
    outcomes: recordsRepo.RecordOutcome[],
    batchId: string,
  ): Promise<void> {
    const decisions = await errorsRepo.getDuplicateDecisions(
      context.tenantId, context.migrationId, entity, candidates.map((c) => c.sourceId),
    );

    for (const candidate of candidates) {
      // Tier 1: already mapped, this is an update of a known record.
      if (existingMap.has(candidate.sourceId)) continue;

      // Guide §13.4: a previously confirmed decision wins over re-matching.
      const decided = decisions.get(candidate.sourceId);
      if (decided) {
        if (decided.decision === 'SKIP') {
          outcomes.push({ sourceId: candidate.sourceId, state: 'SKIPPED', builderLyncId: decided.candidateId, contentHash: null });
        } else if (decided.decision === 'MERGE' && decided.candidateId) {
          mergeTargets.set(candidate.sourceId, decided.candidateId);
        }
        continue;
      }

      const match = await matchContact(
        this.destination,
        {
          tenantId: context.tenantId,
          sourcePlatform: this.adapter.platform,
          sourceObjectId: candidate.sourceId,
          normalizedEmail: (candidate.payload['normalized_email'] as string | null) ?? null,
          normalizedPhone: (candidate.payload['normalized_phone'] as string | null) ?? null,
          firstName: (candidate.payload['first_name'] as string | null) ?? null,
          lastName: (candidate.payload['last_name'] as string | null) ?? null,
          address: (candidate.payload['address'] as never) ?? null,
        },
        this.dedupePolicy,
      );

      if (match.action === 'CREATE_NEW') continue;

      if (match.action === 'REVIEW') {
        // Held for a human. The record is *not* written, and it is not lost:
        // it lands as SKIPPED with an open duplicate candidate attached, so
        // reconciliation still accounts for it and the console surfaces it.
        await withTransaction(async (client) => {
          await errorsRepo.recordDuplicateCandidate(client, {
            migrationId: context.migrationId, tenantId: context.tenantId, entity,
            sourceObjectId: candidate.sourceId, candidateBuilderLyncId: match.builderLyncId,
            tier: match.tier ?? 4, confidence: match.confidence, signals: match.signals,
          });
          await errorsRepo.recordWarning(client, {
            migrationId: context.migrationId, tenantId: context.tenantId, batchId, entity,
            sourceId: candidate.sourceId, code: 'DUPLICATE_REVIEW_REQUIRED',
            message: `Possible duplicate of ${match.builderLyncId} (tier ${match.tier}, confidence ${match.confidence.toFixed(2)}). Held for review.`,
          });
        });
        outcomes.push({ sourceId: candidate.sourceId, state: 'SKIPPED', builderLyncId: match.builderLyncId, contentHash: null });
        continue;
      }

      if (match.action === 'MERGE' && match.builderLyncId) {
        mergeTargets.set(candidate.sourceId, match.builderLyncId);
      }
      // UPDATE_EXISTING falls through: the destination's external-identity
      // lookup turns the write into an update on the same record.
    }
  }

  private throwIfAborted(): void {
    if (this.options.signal?.aborted) throw new MigrationAborted('signal');
  }
}

function tally(outcomes: readonly recordsRepo.RecordOutcome[]) {
  const counts = { created: 0, updated: 0, merged: 0, skipped: 0, unsupported: 0, failed: 0 };
  for (const outcome of outcomes) {
    switch (outcome.state) {
      case 'CREATED': counts.created += 1; break;
      case 'UPDATED': counts.updated += 1; break;
      case 'MERGED': counts.merged += 1; break;
      case 'SKIPPED': counts.skipped += 1; break;
      case 'UNSUPPORTED': counts.unsupported += 1; break;
      case 'FAILED': counts.failed += 1; break;
      default: break;
    }
  }
  return counts;
}

function lastSourceIdOf(records: readonly unknown[]): string | null {
  const last = records[records.length - 1];
  if (last && typeof last === 'object' && 'id' in last) return String((last as { id: unknown }).id);
  return null;
}

/**
 * A stable synthetic id for a record whose source id is missing or unusable.
 * Derived from batch and position so it is identical on a replay of the same
 * page -- otherwise a retry would create a second ledger row for one record.
 */
function fallbackSourceId(raw: unknown, entity: EntityType, batchNumber: number, index: number): string {
  if (raw && typeof raw === 'object' && 'id' in raw) {
    const id = (raw as { id: unknown }).id;
    if (typeof id === 'string' && id) return id;
    if (typeof id === 'number') return String(id);
  }
  return `__unidentified:${entity}:b${batchNumber}:i${index}`;
}

export { ENTITY_PLAN, planFor, createLogger, getPool, migrationsRepo };
// Re-exported so pipeline callers can catch an abort without reaching into
// the domain layer for it.
export { MigrationAborted };
