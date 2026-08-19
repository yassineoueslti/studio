import { z } from 'zod';
import {
  addressSchema,
  canonicalBaseSchema,
  communicationPrefsSchema,
  customFieldsSchema,
  moneySchema,
} from './common.js';

/**
 * The canonical object families (Scope §10, Guide §3.1).
 *
 * Field sets follow Scope §10 exactly; anything a source supplies beyond them
 * lands in `custom_fields` or is reported as UNSUPPORTED_FIELD rather than
 * silently dropped.
 */

// --- 10.1 Account ----------------------------------------------------------
export const migrationAccountSchema = canonicalBaseSchema.extend({
  name: z.string().min(1),
  legal_name: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  website: z.string().nullable().default(null),
  address: addressSchema.nullable().default(null),
  custom_fields: customFieldsSchema,
});
export type MigrationAccount = z.infer<typeof migrationAccountSchema>;

export const migrationLocationSchema = canonicalBaseSchema.extend({
  name: z.string().min(1),
  branch_code: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  address: addressSchema.nullable().default(null),
  is_active: z.boolean().default(true),
  parent_account_source_id: z.string().nullable().default(null),
});
export type MigrationLocation = z.infer<typeof migrationLocationSchema>;

// --- 10.2 User -------------------------------------------------------------
export const migrationUserSchema = canonicalBaseSchema.extend({
  first_name: z.string().nullable().default(null),
  last_name: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  role: z.string().nullable().default(null),
  /** Untranslated source role, kept for audit even after role mapping. */
  source_role: z.string().nullable().default(null),
  team: z.string().nullable().default(null),
  branch: z.string().nullable().default(null),
  location_source_id: z.string().nullable().default(null),
  is_active: z.boolean().default(true),
  /**
   * Scope §19: set when the source user is disabled/deleted, or when the
   * customer chose "Import as Inactive Historical User". Their historical work
   * stays attributed to them instead of landing on a current employee.
   */
  is_historical: z.boolean().default(false),
});
export type MigrationUser = z.infer<typeof migrationUserSchema>;

export const migrationTeamSchema = canonicalBaseSchema.extend({
  name: z.string().min(1),
  member_source_ids: z.array(z.string()).default([]),
});
export type MigrationTeam = z.infer<typeof migrationTeamSchema>;

// --- Foundation config objects --------------------------------------------
export const migrationTagSchema = canonicalBaseSchema.extend({
  name: z.string().min(1),
  color: z.string().nullable().default(null),
});
export type MigrationTag = z.infer<typeof migrationTagSchema>;

export const CUSTOM_FIELD_TYPES = [
  'text', 'textarea', 'number', 'currency', 'date', 'datetime',
  'boolean', 'select', 'multiselect', 'email', 'phone', 'url',
] as const;

export const migrationCustomFieldSchema = canonicalBaseSchema.extend({
  entity_type: z.string().min(1),
  key: z.string().min(1),
  label: z.string().nullable().default(null),
  field_type: z.enum(CUSTOM_FIELD_TYPES).default('text'),
  options: z.array(z.string()).default([]),
});
export type MigrationCustomField = z.infer<typeof migrationCustomFieldSchema>;

export const migrationPipelineSchema = canonicalBaseSchema.extend({
  name: z.string().min(1),
  is_active: z.boolean().default(true),
});
export type MigrationPipeline = z.infer<typeof migrationPipelineSchema>;

export const migrationStageSchema = canonicalBaseSchema.extend({
  name: z.string().min(1),
  pipeline_source_id: z.string().nullable().default(null),
  position: z.number().int().default(0),
  is_won: z.boolean().default(false),
  is_lost: z.boolean().default(false),
});
export type MigrationStage = z.infer<typeof migrationStageSchema>;

export const migrationStatusDefinitionSchema = canonicalBaseSchema.extend({
  entity_type: z.string().min(1),
  name: z.string().min(1),
  position: z.number().int().default(0),
  is_terminal: z.boolean().default(false),
});
export type MigrationStatusDefinition = z.infer<typeof migrationStatusDefinitionSchema>;

// --- 10.3 Contact ----------------------------------------------------------
export const migrationContactSchema = canonicalBaseSchema.extend({
  first_name: z.string().nullable().default(null),
  last_name: z.string().nullable().default(null),
  company_name: z.string().nullable().default(null),
  company_source_id: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  phone: z.string().nullable().default(null),
  secondary_emails: z.array(z.string()).default([]),
  secondary_phones: z.array(z.string()).default([]),
  address: addressSchema.nullable().default(null),
  communication_prefs: communicationPrefsSchema.default({}),
  lead_source: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  assigned_user_source_id: z.string().nullable().default(null),
  custom_fields: customFieldsSchema,
  /**
   * Normalized match keys computed by the normalization step (Scope §21) and
   * consumed by dedupe (Scope §20). Held on the canonical object so matching
   * never re-derives them per candidate comparison.
   */
  normalized_email: z.string().nullable().default(null),
  normalized_phone: z.string().nullable().default(null),
});
export type MigrationContact = z.infer<typeof migrationContactSchema>;

export const migrationCompanySchema = canonicalBaseSchema.extend({
  name: z.string().min(1),
  phone: z.string().nullable().default(null),
  email: z.string().nullable().default(null),
  website: z.string().nullable().default(null),
  address: addressSchema.nullable().default(null),
  assigned_user_source_id: z.string().nullable().default(null),
  custom_fields: customFieldsSchema,
});
export type MigrationCompany = z.infer<typeof migrationCompanySchema>;

// --- 10.4 Opportunity ------------------------------------------------------
export const migrationOpportunitySchema = canonicalBaseSchema.extend({
  name: z.string().nullable().default(null),
  contact_source_id: z.string().nullable().default(null),
  pipeline_source_id: z.string().nullable().default(null),
  stage_source_id: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  value: moneySchema.default({}),
  assigned_user_source_id: z.string().nullable().default(null),
  lead_source: z.string().nullable().default(null),
  closed_at: z.coerce.date().nullable().default(null),
  lost_reason: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  custom_fields: customFieldsSchema,
});
export type MigrationOpportunity = z.infer<typeof migrationOpportunitySchema>;

export const migrationLeadSchema = canonicalBaseSchema.extend({
  contact_source_id: z.string().nullable().default(null),
  lead_source: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  assigned_user_source_id: z.string().nullable().default(null),
  custom_fields: customFieldsSchema,
});
export type MigrationLead = z.infer<typeof migrationLeadSchema>;

// --- 10.5 Job / Project ----------------------------------------------------
export const migrationJobSchema = canonicalBaseSchema.extend({
  job_number: z.string().nullable().default(null),
  name: z.string().nullable().default(null),
  contact_source_id: z.string().nullable().default(null),
  opportunity_source_id: z.string().nullable().default(null),
  address: addressSchema.nullable().default(null),
  job_type: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  stage_source_id: z.string().nullable().default(null),
  value: moneySchema.default({}),
  assigned_user_source_ids: z.array(z.string()).default([]),
  start_date: z.coerce.date().nullable().default(null),
  completion_date: z.coerce.date().nullable().default(null),
  lead_source: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  notes: z.string().nullable().default(null),
  custom_fields: customFieldsSchema,
});
export type MigrationJob = z.infer<typeof migrationJobSchema>;

export const migrationJobAssignmentSchema = canonicalBaseSchema.extend({
  job_source_id: z.string().min(1),
  user_source_id: z.string().min(1),
  role: z.string().nullable().default(null),
});
export type MigrationJobAssignment = z.infer<typeof migrationJobAssignmentSchema>;

export const migrationContactJobRelationshipSchema = canonicalBaseSchema.extend({
  job_source_id: z.string().min(1),
  contact_source_id: z.string().min(1),
  relationship: z.string().nullable().default(null), // primary | billing | referral | ...
});
export type MigrationContactJobRelationship = z.infer<typeof migrationContactJobRelationshipSchema>;

// --- 10.6 Activity / Note / Task / Appointment -----------------------------
export const migrationNoteSchema = canonicalBaseSchema.extend({
  parent_entity_type: z.string().min(1),
  parent_source_id: z.string().min(1),
  body: z.string().nullable().default(null),
  body_format: z.enum(['text', 'html']).default('text'),
  /** Guide §9.4: the source's timestamp, never the import clock. */
  authored_at: z.coerce.date().nullable().default(null),
  author_user_source_id: z.string().nullable().default(null),
  author_source_name: z.string().nullable().default(null),
});
export type MigrationNote = z.infer<typeof migrationNoteSchema>;

export const ACTIVITY_TYPES = ['call', 'email', 'sms', 'meeting', 'status_change', 'log', 'other'] as const;

export const migrationActivitySchema = canonicalBaseSchema.extend({
  parent_entity_type: z.string().min(1),
  parent_source_id: z.string().min(1),
  activity_type: z.enum(ACTIVITY_TYPES).default('other'),
  subject: z.string().nullable().default(null),
  body: z.string().nullable().default(null),
  direction: z.enum(['inbound', 'outbound']).nullable().default(null),
  occurred_at: z.coerce.date().nullable().default(null),
  user_source_id: z.string().nullable().default(null),
  author_source_name: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type MigrationActivity = z.infer<typeof migrationActivitySchema>;

export const migrationTaskSchema = canonicalBaseSchema.extend({
  parent_entity_type: z.string().nullable().default(null),
  parent_source_id: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  description: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  due_at: z.coerce.date().nullable().default(null),
  completed_at: z.coerce.date().nullable().default(null),
  assigned_user_source_id: z.string().nullable().default(null),
});
export type MigrationTask = z.infer<typeof migrationTaskSchema>;

export const migrationAppointmentSchema = canonicalBaseSchema.extend({
  parent_entity_type: z.string().nullable().default(null),
  parent_source_id: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  starts_at: z.coerce.date().nullable().default(null),
  ends_at: z.coerce.date().nullable().default(null),
  assigned_user_source_id: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
});
export type MigrationAppointment = z.infer<typeof migrationAppointmentSchema>;

// --- 10.7 File / 10.8 Image ------------------------------------------------
export const migrationFileSchema = canonicalBaseSchema.extend({
  file_name: z.string().min(1),
  original_name: z.string().nullable().default(null),
  mime_type: z.string().nullable().default(null),
  size_bytes: z.number().int().nonnegative().nullable().default(null),
  /** Where the binary is fetched from. May be a signed, expiring URL. */
  source_url: z.string().nullable().default(null),
  parent_entity_type: z.string().nullable().default(null),
  parent_source_id: z.string().nullable().default(null),
  uploaded_by_user_source_id: z.string().nullable().default(null),
  /** Source-declared hash where the vendor exposes one (Scope §23). */
  source_hash: z.string().nullable().default(null),
  kind: z.enum(['document', 'image', 'attachment']).default('document'),
});
export type MigrationFile = z.infer<typeof migrationFileSchema>;

export const migrationImageSchema = migrationFileSchema.extend({
  kind: z.literal('image').default('image'),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  album: z.string().nullable().default(null),
  /** Scope §10.8: EXIF handling is a policy decision, recorded per file. */
  exif_retention: z.enum(['retain', 'strip']).default('strip'),
  thumbnail_url: z.string().nullable().default(null),
});
export type MigrationImage = z.infer<typeof migrationImageSchema>;
