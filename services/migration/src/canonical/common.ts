import { z } from 'zod';

/**
 * Canonical migration schema, shared parts.
 *
 * Scope §9 / Guide §3: every source platform transforms into these objects
 * *before* anything is written to the destination. The rest of the platform --
 * dedupe, batching, reconciliation, reporting -- only ever sees canonical
 * objects, which is what keeps source-specific field names out of BuilderLync
 * business logic (Scope §88).
 */

/** Bumped whenever a canonical shape changes incompatibly. Stored per migration. */
export const CANONICAL_SCHEMA_VERSION = '1.0.0';

export const SOURCE_PLATFORMS = [
  'highlevel',
  'acculynx',
  'jobnimbus',
  'proline',
  'roofr',
  'file_import',
  'mock',
] as const;

export type SourcePlatform = (typeof SOURCE_PLATFORMS)[number];

/**
 * Source provenance carried by every canonical object (Guide §3.1).
 * This is what makes Scope §83 "Auditability" possible: any BuilderLync record
 * can be traced back to migration, platform, source tenant, type and id.
 */
export const sourceMetadataSchema = z.object({
  source_platform: z.enum(SOURCE_PLATFORMS),
  source_tenant_id: z.string().nullable().default(null),
  source_object_type: z.string().min(1),
  source_object_id: z.string().min(1),
  source_created_at: z.coerce.date().nullable().default(null),
  source_updated_at: z.coerce.date().nullable().default(null),
  /**
   * Pointer to the retained raw payload (Scope §30) rather than the payload
   * itself, so canonical objects stay small enough to batch cheaply.
   */
  raw_source_reference: z.string().nullable().default(null),
  /** Scope §31, e.g. "jobnimbus-contact-v1.4.2". */
  transformer_version: z.string().min(1),
});

export type SourceMetadata = z.infer<typeof sourceMetadataSchema>;

export const addressSchema = z.object({
  line1: z.string().nullable().default(null),
  line2: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  state: z.string().nullable().default(null),
  postal_code: z.string().nullable().default(null),
  country: z.string().nullable().default(null),
});

export type CanonicalAddress = z.infer<typeof addressSchema>;

/**
 * Money is carried as integer minor units. Scope §21 requires a consistent
 * currency representation; floats silently lose cents across a large migration.
 */
export const moneySchema = z.object({
  amount_cents: z.number().int().nullable().default(null),
  currency: z.string().length(3).default('USD'),
});

export const communicationPrefsSchema = z.object({
  email_opt_in: z.boolean().nullable().default(null),
  sms_opt_in: z.boolean().nullable().default(null),
  call_opt_in: z.boolean().nullable().default(null),
  do_not_contact: z.boolean().nullable().default(null),
});

/** Custom field values keyed by BuilderLync custom-field key. */
export const customFieldsSchema = z.record(z.string(), z.unknown()).default({});

/** Every canonical object extends this. */
export const canonicalBaseSchema = sourceMetadataSchema.extend({
  migration_id: z.string().uuid(),
  /**
   * Warnings raised during transformation that did not stop the record --
   * e.g. an unmapped field, a coerced invalid date. These become
   * migration_warnings rows so a WARNING disposition is explainable (Scope §3.4).
   */
  warnings: z
    .array(z.object({ code: z.string(), message: z.string(), field: z.string().optional() }))
    .default([]),
});

export type CanonicalBase = z.infer<typeof canonicalBaseSchema>;
