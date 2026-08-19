# Canonical Migration Schema

**Version 1.0.0** — `services/migration/src/canonical/`

Every source platform transforms its records into these objects *before*
anything is written to BuilderLync (Scope §9, Guide §3). The rest of the
platform — deduplication, batching, reconciliation, reporting — only ever sees
canonical objects.

That boundary is what enforces Scope §88: source-specific logic stays inside
adapters, and BuilderLync never grows a `if (platform === 'jobnimbus')` branch.

## Source provenance on every object

```ts
{
  migration_id:         string,          // uuid
  source_platform:      SourcePlatform,  // highlevel | acculynx | jobnimbus | proline | roofr | file_import | mock
  source_tenant_id:     string | null,
  source_object_type:   string,
  source_object_id:     string,          // required and non-empty
  source_created_at:    Date | null,
  source_updated_at:    Date | null,
  raw_source_reference: string | null,   // pointer to the retained payload, not the payload
  transformer_version:  string,          // e.g. "jobnimbus-contact-v1.4.2"  (Scope §31)
  warnings:             Array<{ code, message, field? }>,
}
```

This is what makes Scope §83's auditability requirement true: any BuilderLync
record traces back to migration, platform, source tenant, object type and
source id.

`warnings` carries transformation problems that did **not** stop the record —
an unmapped field, a coerced date, a contact with no contact method. They become
`migration_warnings` rows, which is how a `WARNING` disposition stays
explainable rather than being a vague flag.

## Object families (Scope §10)

| Object | Notes |
|---|---|
| `MigrationAccount` | Company, business metadata |
| `MigrationLocation` | Branch/location, `parent_account_source_id` |
| `MigrationUser` | Includes `source_role` (untranslated, for audit) and `is_historical` |
| `MigrationTeam` | Members by source id |
| `MigrationTag` | |
| `MigrationCustomField` | Typed: text, number, currency, date, select, … |
| `MigrationPipeline` | |
| `MigrationStage` | `pipeline_source_id`, `position`, `is_won`, `is_lost` |
| `MigrationStatusDefinition` | Per-entity status vocabulary |
| `MigrationContact` | Includes `normalized_email` / `normalized_phone` match keys |
| `MigrationCompany` | |
| `MigrationLead` | |
| `MigrationOpportunity` | Contact, pipeline, stage, value, lost reason |
| `MigrationJob` | Job number, contact, address, status, value, assignees, dates |
| `MigrationJobAssignment` | Job ↔ user, with role |
| `MigrationContactJobRelationship` | Job ↔ contact, with relationship type |
| `MigrationNote` | `authored_at` + author **from the source** (Guide §9.4) |
| `MigrationActivity` | call / email / sms / meeting / status_change / log |
| `MigrationTask` | |
| `MigrationAppointment` | |
| `MigrationFile` | Name, MIME, size, source URL, parent, hash |
| `MigrationImage` | Extends file: dimensions, album, `exif_retention` |

## Conventions that matter

**Money is integer minor units.**
`{ amount_cents: number | null, currency: string }`. Scope §21 requires a
consistent currency representation; floats silently lose cents across a large
migration and the loss is unrecoverable after the fact.

**Parent references use *source* ids.**
A job carries `contact_source_id`, not a BuilderLync id. The orchestrator
resolves it from `migration_object_map` immediately before writing, and sets
`contact_builderlync_id`. Adapters never resolve destination ids themselves —
they cannot, and Scope §69 assigns id mapping to BuilderLync.

If a parent cannot be resolved, the reference is dropped and a warning is
raised. It is never written as a dangling pointer.

**Historical timestamps are preserved.**
Guide §9.4: an imported note keeps its original `authored_at` and author. A
migration that rewrites five years of history as "created today" has destroyed
the thing the customer was paying to keep.

**Match keys are computed once.**
`normalized_email` and `normalized_phone` are set during normalization and
carried on the object, so deduplication never re-derives them per candidate
comparison — and both sides of a comparison are guaranteed to have gone through
identical rules.

## Validation

`validateCanonical(entity, input)` **returns** rather than throws. The caller is
processing a batch and must record a disposition for the failing record and
continue — Scope §44: one bad record must not make a batch unaccountable.

A validation failure produces a `VALIDATION_ERROR` with the offending field
path, a `FAILED` disposition for that record alone, and a row in
`migration_errors`. The batch's other records are unaffected.

## Content hashing

`contentHash(payload)` produces a deterministic SHA-256 over a stable
serialization with object keys sorted recursively.

Deliberately excluded from the hash: `migration_id`, `raw_source_reference`,
`transformer_version`, `warnings`, `source_created_at`, `source_updated_at`.
These change between extractions without the record's content changing, and
including them would defeat the point — an unchanged record would look modified
on every run and a delta sync would rewrite the customer's entire database.

## Versioning

* **Schema version** (`CANONICAL_SCHEMA_VERSION`) — bumped on an incompatible
  shape change; recorded per migration.
* **Transformer version** — per adapter *and* per entity, recorded on every
  record, so data imported by older transformation logic stays identifiable
  (Scope §31).

## Adding a field

1. Add it to the zod schema in `src/canonical/objects.ts`, with a default so
   existing adapters keep validating.
2. Map it in the destination writer (`src/destination/sandbox.ts`) and in
   `docs/DESTINATION_INVENTORY.md`.
3. Populate it in each adapter's `normalize()`.
4. Bump the affected transformer versions.
5. Bump `CANONICAL_SCHEMA_VERSION` only if the change is incompatible.
