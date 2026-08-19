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
   * Entities that must be accounted for before this one runs. The orchestrator
   * uses this both to sequence work and to raise DEPENDENCY_MISSING rather than
   * writing an orphan record.
   */
  readonly dependsOn: readonly EntityType[];
  /** Assets move through the file pipeline, not the record batch pipeline. */
  readonly isAsset: boolean;
}

export const ENTITY_PLAN: readonly EntityPlan[] = Object.freeze([
  // Phase A - Foundation
  { entity: 'account', order: 1, phase: 'FOUNDATION', dependsOn: [], isAsset: false },
  { entity: 'location', order: 2, phase: 'FOUNDATION', dependsOn: ['account'], isAsset: false },
  { entity: 'user', order: 3, phase: 'FOUNDATION', dependsOn: ['account'], isAsset: false },
  { entity: 'team', order: 4, phase: 'FOUNDATION', dependsOn: ['user'], isAsset: false },
  { entity: 'custom_field', order: 5, phase: 'FOUNDATION', dependsOn: ['account'], isAsset: false },
  { entity: 'tag', order: 6, phase: 'FOUNDATION', dependsOn: ['account'], isAsset: false },
  { entity: 'pipeline', order: 7, phase: 'FOUNDATION', dependsOn: ['account'], isAsset: false },
  { entity: 'pipeline_stage', order: 8, phase: 'FOUNDATION', dependsOn: ['pipeline'], isAsset: false },
  { entity: 'status_definition', order: 9, phase: 'FOUNDATION', dependsOn: ['account'], isAsset: false },

  // Phase B - CRM Data
  { entity: 'contact', order: 10, phase: 'CRM_DATA', dependsOn: ['user', 'tag', 'custom_field'], isAsset: false },
  { entity: 'company', order: 11, phase: 'CRM_DATA', dependsOn: ['user'], isAsset: false },
  { entity: 'lead', order: 12, phase: 'CRM_DATA', dependsOn: ['contact'], isAsset: false },
  { entity: 'opportunity', order: 13, phase: 'CRM_DATA', dependsOn: ['contact', 'pipeline_stage', 'user'], isAsset: false },

  // Phase C - Operational Data
  { entity: 'job', order: 14, phase: 'OPERATIONAL', dependsOn: ['contact', 'user', 'status_definition'], isAsset: false },
  { entity: 'job_assignment', order: 15, phase: 'OPERATIONAL', dependsOn: ['job', 'user'], isAsset: false },
  { entity: 'contact_job_relationship', order: 16, phase: 'OPERATIONAL', dependsOn: ['job', 'contact'], isAsset: false },
  { entity: 'task', order: 17, phase: 'OPERATIONAL', dependsOn: ['contact', 'user'], isAsset: false },
  { entity: 'appointment', order: 18, phase: 'OPERATIONAL', dependsOn: ['contact', 'user'], isAsset: false },
  { entity: 'note', order: 19, phase: 'OPERATIONAL', dependsOn: ['contact', 'job'], isAsset: false },
  { entity: 'activity', order: 20, phase: 'OPERATIONAL', dependsOn: ['contact', 'job', 'user'], isAsset: false },

  // Phase D - Assets
  { entity: 'document', order: 21, phase: 'ASSETS', dependsOn: ['job', 'contact'], isAsset: true },
  { entity: 'image', order: 22, phase: 'ASSETS', dependsOn: ['job', 'contact'], isAsset: true },
  { entity: 'attachment', order: 23, phase: 'ASSETS', dependsOn: ['job', 'contact', 'note'], isAsset: true },
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

/**
 * Dependencies of `selected` that were not themselves selected. Surfaced by
 * preflight so the customer is warned before, not during, a migration --
 * e.g. selecting jobs without contacts orphans every job.
 */
export function missingDependencies(selected: readonly EntityType[]): Array<{
  entity: EntityType;
  missing: EntityType[];
}> {
  const wanted = new Set(selected);
  const gaps: Array<{ entity: EntityType; missing: EntityType[] }> = [];
  for (const plan of sequence(selected)) {
    const missing = plan.dependsOn.filter((dep) => !wanted.has(dep));
    if (missing.length > 0) gaps.push({ entity: plan.entity, missing });
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
