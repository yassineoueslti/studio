/**
 * Canonical entity vocabulary and dependency-ordered migration sequencing.
 *
 * Scope §14 lists 29 sequenced steps grouped into five phases. Encoding the
 * order as data (rather than as the call order inside an orchestrator function)
 * is what lets the engine resume mid-phase, skip unsupported entities per
 * adapter capability, and report progress per entity.
 */

export const ENTITY_TYPES = [
  'account',
  'location',
  'user',
  'team',
  'custom_field',
  'tag',
  'pipeline',
  'pipeline_stage',
  'status_definition',
  'contact',
  'company',
  'lead',
  'opportunity',
  'job',
  'job_assignment',
  'contact_job_relationship',
  'task',
  'appointment',
  'note',
  'activity',
  'document',
  'image',
  'attachment',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

export const MIGRATION_PHASES = ['FOUNDATION', 'CRM_DATA', 'OPERATIONAL', 'ASSETS', 'VALIDATION'] as const;
export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

export interface EntityPlan {
  readonly entity: EntityType;
  /** Scope §14 step number, 1-23 for data entities. */
  readonly order: number;
  readonly phase: MigrationPhase;
  /**
   * STRUCTURAL parents. The record stores a reference to these, so a missing
   * one leaves an orphan -- a job with no contact_id. Not selecting these is a
   * real error, and preflight blocks on it.
   */
  readonly requires: readonly EntityType[];
  /**
   * Polymorphic structural parents, of which AT LEAST ONE must be present.
   * A note attaches to a contact or a job, so requiring both would falsely
   * block a migration that only selected one of them.
   */
  readonly requiresAny: readonly EntityType[];
  /**
   * DEFINITIONAL parents. The record stores the *value*, not a reference to
   * these -- a contact carries its tag names and custom-field values inline, so
   * it is complete whether or not the tag and custom-field definitions were
   * migrated. Missing ones cost metadata fidelity in the destination UI, not
   * record correctness, so preflight reports them rather than blocking.
   *
   * Conflating these two kinds of dependency is what made selecting
   * "user, contact, job" -- the obvious first migration -- fail preflight for a
   * problem that does not exist.
   */
  readonly enrichedBy: readonly EntityType[];
  /** Assets move through the file pipeline, not the record batch pipeline. */
  readonly isAsset: boolean;
  /**
   * Every dependency, in any category. Sequencing uses this: an entity must
   * still run after anything it references, structurally or not, so that
   * inline values and resolved ids are both available.
   */
  readonly dependsOn: readonly EntityType[];
}

type EntityPlanInput = Omit<EntityPlan, 'dependsOn' | 'requires' | 'requiresAny' | 'enrichedBy'> & {
  requires?: readonly EntityType[];
  requiresAny?: readonly EntityType[];
  enrichedBy?: readonly EntityType[];
};

function plan(input: EntityPlanInput): EntityPlan {
  const requires = input.requires ?? [];
  const requiresAny = input.requiresAny ?? [];
  const enrichedBy = input.enrichedBy ?? [];
  return {
    ...input,
    requires,
    requiresAny,
    enrichedBy,
    dependsOn: [...new Set([...requires, ...requiresAny, ...enrichedBy])],
  };
}

export const ENTITY_PLAN: readonly EntityPlan[] = Object.freeze([
  // Phase A - Foundation
  plan({ entity: 'account', order: 1, phase: 'FOUNDATION', isAsset: false }),
  plan({ entity: 'location', order: 2, phase: 'FOUNDATION', requires: ['account'], isAsset: false }),
  plan({ entity: 'user', order: 3, phase: 'FOUNDATION', enrichedBy: ['account'], isAsset: false }),
  plan({ entity: 'team', order: 4, phase: 'FOUNDATION', requires: ['user'], isAsset: false }),
  plan({ entity: 'custom_field', order: 5, phase: 'FOUNDATION', enrichedBy: ['account'], isAsset: false }),
  plan({ entity: 'tag', order: 6, phase: 'FOUNDATION', enrichedBy: ['account'], isAsset: false }),
  plan({ entity: 'pipeline', order: 7, phase: 'FOUNDATION', enrichedBy: ['account'], isAsset: false }),
  // A stage without its pipeline is genuinely orphaned: it stores pipeline_id.
  plan({ entity: 'pipeline_stage', order: 8, phase: 'FOUNDATION', requires: ['pipeline'], isAsset: false }),
  plan({ entity: 'status_definition', order: 9, phase: 'FOUNDATION', enrichedBy: ['account'], isAsset: false }),

  // Phase B - CRM Data
  // A contact stands alone. Its assignee, tags and custom fields are attributes:
  // losing them degrades the record, it does not orphan it.
  plan({ entity: 'contact', order: 10, phase: 'CRM_DATA', enrichedBy: ['user', 'tag', 'custom_field'], isAsset: false }),
  plan({ entity: 'company', order: 11, phase: 'CRM_DATA', enrichedBy: ['user'], isAsset: false }),
  plan({ entity: 'lead', order: 12, phase: 'CRM_DATA', requires: ['contact'], isAsset: false }),
  plan({
    entity: 'opportunity', order: 13, phase: 'CRM_DATA',
    requires: ['contact'],
    // An unstaged opportunity is still a real opportunity; Scope §39 lists
    // "opportunities without pipelines" as something to report, not to reject.
    enrichedBy: ['pipeline', 'pipeline_stage', 'user'],
    isAsset: false,
  }),

  // Phase C - Operational Data
  plan({
    entity: 'job', order: 14, phase: 'OPERATIONAL',
    requires: ['contact'],
    enrichedBy: ['user', 'status_definition', 'tag'],
    isAsset: false,
  }),
  plan({ entity: 'job_assignment', order: 15, phase: 'OPERATIONAL', requires: ['job', 'user'], isAsset: false }),
  plan({ entity: 'contact_job_relationship', order: 16, phase: 'OPERATIONAL', requires: ['job', 'contact'], isAsset: false }),
  plan({ entity: 'task', order: 17, phase: 'OPERATIONAL', requiresAny: ['contact', 'job'], enrichedBy: ['user'], isAsset: false }),
  plan({ entity: 'appointment', order: 18, phase: 'OPERATIONAL', requiresAny: ['contact', 'job'], enrichedBy: ['user'], isAsset: false }),
  // Notes and activities attach to whichever parent the source gave them.
  plan({ entity: 'note', order: 19, phase: 'OPERATIONAL', requiresAny: ['contact', 'job'], enrichedBy: ['user'], isAsset: false }),
  plan({ entity: 'activity', order: 20, phase: 'OPERATIONAL', requiresAny: ['contact', 'job'], enrichedBy: ['user'], isAsset: false }),

  // Phase D - Assets
  plan({ entity: 'document', order: 21, phase: 'ASSETS', requiresAny: ['job', 'contact'], isAsset: true }),
  plan({ entity: 'image', order: 22, phase: 'ASSETS', requiresAny: ['job', 'contact'], isAsset: true }),
  plan({ entity: 'attachment', order: 23, phase: 'ASSETS', requiresAny: ['job', 'contact', 'note'], isAsset: true }),
]);

const PLAN_BY_ENTITY = new Map<EntityType, EntityPlan>(ENTITY_PLAN.map((p) => [p.entity, p]));

export function planFor(entity: EntityType): EntityPlan {
  const plan = PLAN_BY_ENTITY.get(entity);
  if (!plan) throw new Error(`No migration plan defined for entity "${entity}"`);
  return plan;
}

export function isAssetEntity(entity: EntityType): boolean {
  return planFor(entity).isAsset;
}

/**
 * Sort a selected subset of entities into safe execution order. Callers pass
 * only the entities the customer selected (Wizard step 4) intersected with what
 * the adapter declares it supports.
 */
export function sequence(selected: readonly EntityType[]): EntityPlan[] {
  const wanted = new Set(selected);
  return ENTITY_PLAN.filter((p) => wanted.has(p.entity)).sort((a, b) => a.order - b.order);
}

export interface DependencyGap {
  entity: EntityType;
  /** Structural parents not selected. These orphan records; preflight blocks. */
  missingRequired: EntityType[];
  /** Definitional parents not selected. Metadata fidelity only; advisory. */
  missingEnrichment: EntityType[];
}

/**
 * Dependencies of `selected` that were not themselves selected, split by
 * whether their absence breaks records or merely degrades them.
 *
 * Surfaced by preflight so the customer is warned before, not during, a
 * migration -- selecting jobs without contacts orphans every job, while
 * selecting contacts without tags just means tag definitions do not appear in
 * BuilderLync's tag manager.
 */
export function missingDependencies(selected: readonly EntityType[]): DependencyGap[] {
  const wanted = new Set(selected);
  const gaps: DependencyGap[] = [];

  for (const entityPlan of sequence(selected)) {
    const missingRequired = entityPlan.requires.filter((dep) => !wanted.has(dep));

    // requiresAny is satisfied by any one of its options, so it only counts as
    // missing when none were selected.
    if (entityPlan.requiresAny.length > 0 && !entityPlan.requiresAny.some((dep) => wanted.has(dep))) {
      missingRequired.push(...entityPlan.requiresAny);
    }

    const missingEnrichment = entityPlan.enrichedBy.filter((dep) => !wanted.has(dep));

    if (missingRequired.length > 0 || missingEnrichment.length > 0) {
      gaps.push({ entity: entityPlan.entity, missingRequired, missingEnrichment });
    }
  }
  return gaps;
}

/** Phase E of Scope §14 - validation steps, run after all data phases. */
export const VALIDATION_STEPS = [
  'relationship_reconciliation',
  'object_count_reconciliation',
  'file_reconciliation',
  'duplicate_detection',
  'error_review',
  'final_report',
] as const;

export type ValidationStep = (typeof VALIDATION_STEPS)[number];
