import type { ZodTypeAny } from 'zod';
import type { EntityType } from '../domain/entities.js';
import { MigrationError } from '../domain/errors.js';
import {
  migrationAccountSchema, migrationActivitySchema, migrationAppointmentSchema,
  migrationCompanySchema, migrationContactJobRelationshipSchema, migrationContactSchema,
  migrationCustomFieldSchema, migrationFileSchema, migrationImageSchema,
  migrationJobAssignmentSchema, migrationJobSchema, migrationLeadSchema,
  migrationLocationSchema, migrationNoteSchema, migrationOpportunitySchema,
  migrationPipelineSchema, migrationStageSchema, migrationStatusDefinitionSchema,
  migrationTagSchema, migrationTaskSchema, migrationTeamSchema, migrationUserSchema,
} from './objects.js';

export * from './common.js';
export * from './objects.js';

/**
 * Entity type -> canonical schema. The pipeline validates every object against
 * this registry before it reaches the destination, so a malformed record is a
 * VALIDATION_ERROR against one bad record rather than a rejected batch
 * (Test 6, Guide §20).
 */
export const CANONICAL_SCHEMAS: Readonly<Record<EntityType, ZodTypeAny>> = Object.freeze({
  account: migrationAccountSchema,
  location: migrationLocationSchema,
  user: migrationUserSchema,
  team: migrationTeamSchema,
  custom_field: migrationCustomFieldSchema,
  tag: migrationTagSchema,
  pipeline: migrationPipelineSchema,
  pipeline_stage: migrationStageSchema,
  status_definition: migrationStatusDefinitionSchema,
  contact: migrationContactSchema,
  company: migrationCompanySchema,
  lead: migrationLeadSchema,
  opportunity: migrationOpportunitySchema,
  job: migrationJobSchema,
  job_assignment: migrationJobAssignmentSchema,
  contact_job_relationship: migrationContactJobRelationshipSchema,
  task: migrationTaskSchema,
  appointment: migrationAppointmentSchema,
  note: migrationNoteSchema,
  activity: migrationActivitySchema,
  document: migrationFileSchema,
  image: migrationImageSchema,
  attachment: migrationFileSchema,
});

export interface ValidationOutcome<T = unknown> {
  ok: boolean;
  value?: T;
  error?: MigrationError;
}

/**
 * Validate one canonical object. Returns rather than throws: the caller is
 * processing a batch and must record a disposition for this record and keep
 * going (Scope §44 - one bad record must not make a batch unaccountable).
 */
export function validateCanonical(entity: EntityType, input: unknown): ValidationOutcome {
  const schema = CANONICAL_SCHEMAS[entity];
  if (!schema) {
    return {
      ok: false,
      error: new MigrationError('UNSUPPORTED_FIELD', `No canonical schema registered for entity "${entity}"`, { entity }),
    };
  }

  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  const detail = parsed.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');

  const sourceId =
    typeof input === 'object' && input !== null && 'source_object_id' in input
      ? String((input as { source_object_id: unknown }).source_object_id)
      : undefined;

  return {
    ok: false,
    error: new MigrationError('VALIDATION_ERROR', `Canonical validation failed for ${entity}: ${detail}`, {
      entity,
      sourceId,
      raw: { issues: parsed.error.issues },
    }),
  };
}
