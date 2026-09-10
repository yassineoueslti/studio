# BuilderLync Destination Inventory

> **Guide §1.1 — Freeze the BuilderLync destination model.**
> *"Do not begin source mapping until the team knows exactly what BuilderLync
> can receive."*

This document is the contract between the migration engine and BuilderLync.
It is deliberately the **first** document in the repository, because the guide
makes it a precondition for every connector.

Two things live here:

1. **The ingestion contract** — the endpoints, idempotency semantics and batch
   response shape BuilderLync must provide (Guide §1.2, §1.3; Scope §43–45).
   This part is **implemented and verified** by the sandbox destination driver.
2. **The entity inventory** — the per-object field table Guide §1.1 requires.
   The migration engine's canonical schema states what it *sends*; the columns
   marked **`TO CONFIRM`** must be filled in from the real BuilderLync
   application before any vendor connector is written.

---

## 1. Ingestion contract

### 1.1 Batch endpoints (Guide §1.2)

| Endpoint | Entity |
|---|---|
| `POST /internal/migration/accounts/batch` | account |
| `POST /internal/migration/locations/batch` | location |
| `POST /internal/migration/users/batch` | user |
| `POST /internal/migration/contacts/batch` | contact |
| `POST /internal/migration/companies/batch` | company |
| `POST /internal/migration/opportunities/batch` | opportunity |
| `POST /internal/migration/jobs/batch` | job |
| `POST /internal/migration/activities/batch` | activity |
| `POST /internal/migration/notes/batch` | note |
| `POST /internal/migration/tasks/batch` | task |
| `POST /internal/migration/appointments/batch` | appointment |
| `POST /internal/migration/tags/batch` | tag |
| `POST /internal/migration/custom-fields/batch` | custom_field |
| `POST /internal/migration/pipelines/batch` | pipeline |
| `POST /internal/migration/pipeline-stages/batch` | pipeline_stage |
| `POST /internal/migration/files` | document / image / attachment |

**Request**

```jsonc
{
  "migration_id": "0f9c…",
  "records": [
    {
      "source_id": "87562",
      "idempotency_key": "mig_0f9c…:jobnimbus:contact:87562",
      "content_hash": "sha256…",
      "payload": { /* canonical object — see docs/CANONICAL_SCHEMA.md */ }
    }
  ]
}
```

**Response — one result per input record, always**

```jsonc
{
  "results": [
    {
      "source_id": "87562",
      "status": "CREATED",          // CREATED | UPDATED | MERGED | SKIPPED | FAILED | UNSUPPORTED
      "builderlync_id": "bl_contact_…",
      "idempotent_replay": false,
      "error": null                  // present only when status is FAILED
    }
  ]
}
```

> **Scope §44 is non-negotiable.** Every input record receives a result.
> A short response is treated as a server error by the engine
> (`src/destination/http.ts`) *and* at the API boundary
> (`src/api/routes/ingestion.ts`), because a missing result later surfaces as an
> unexplained reconciliation variance with no way to trace its cause.

### 1.2 Idempotency (Guide §1.3, Scope §45)

Key format:

```
mig_<migration_id>:<source_platform>:<source_object_type>:<source_object_id>
```

Required behaviour:

| Situation | Required response |
|---|---|
| Key unseen | Perform the write, store the outcome, return it |
| Key seen, **same** `content_hash` | Return the stored outcome. **Write nothing.** Set `idempotent_replay: true` |
| Key seen, **different** `content_hash` | Treat as a delta update. Update the record, return `UPDATED` |
| Key unseen, but `external_source_platform` + `external_source_id` already exist for the tenant | Update the existing record, return `UPDATED` |

That last row matters and is easy to miss: the idempotency key embeds the
migration id, so a *second* migration importing the same source account would
miss every prior mapping. Matching on external source identity is what makes
re-migration safe.

> **Done when** (Guide §1.3): a developer can re-send the same batch with cURL
> and create no duplicates. Verified by
> `test/production-readiness.test.ts` → *Test 2 — Duplicate replay*.

### 1.3 Tenant enforcement (Scope §47)

* The tenant is resolved **server-side** from the authenticated principal.
* A `tenant_id` appearing in a request body is **ignored**, and if it disagrees
  with the resolved tenant the record is **rejected**, not silently reassigned.
* Verified by *Test 10 — Tenant isolation*.

### 1.4 Record tagging (Scope §63)

Every destination row written by a migration carries:

| Column | Purpose |
|---|---|
| `created_by_migration_id` | Rows this migration created — the unit of targeted rollback |
| `updated_by_migration_id` | Rows this migration updated rather than created |
| `external_source_platform` | Support traceability (Scope §64) |
| `external_source_id` | Support traceability, and re-migration matching |

Full transactional rollback of a large migration is impractical (Scope §63);
these columns are what make a *targeted* recovery possible instead.

---

## 2. Entity inventory

**Status legend**
`SENT` — the canonical schema defines and sends this field.
`TO CONFIRM` — must be filled in from the live BuilderLync application.

### 2.1 Contact

| Canonical field | Type | Sent | BuilderLync field | Required? | Max length |
|---|---|---|---|---|---|
| `first_name` | string \| null | SENT | `TO CONFIRM` | `TO CONFIRM` | `TO CONFIRM` |
| `last_name` | string \| null | SENT | `TO CONFIRM` | `TO CONFIRM` | `TO CONFIRM` |
| `email` | string \| null | SENT | `TO CONFIRM` | `TO CONFIRM` | `TO CONFIRM` |
| `phone` | E.164 string \| null | SENT | `TO CONFIRM` | `TO CONFIRM` | `TO CONFIRM` |
| `secondary_emails` | string[] | SENT | `TO CONFIRM` | — | `TO CONFIRM` |
| `secondary_phones` | string[] | SENT | `TO CONFIRM` | — | `TO CONFIRM` |
| `address` | object \| null | SENT | `TO CONFIRM` | — | — |
| `company_name` / `company_source_id` | string \| null | SENT | `TO CONFIRM` | — | — |
| `lead_source` | string \| null | SENT | `TO CONFIRM` | — | `TO CONFIRM` |
| `tags` | string[] | SENT | `TO CONFIRM` | — | — |
| `assigned_user_source_id` | string \| null | SENT | resolved to `assigned_user_builderlync_id` | — | — |
| `custom_fields` | object | SENT | `TO CONFIRM` | — | — |
| `communication_prefs` | object | SENT | `TO CONFIRM` | — | — |
| `source_created_at` / `source_updated_at` | date \| null | SENT | `TO CONFIRM` | — | — |

**Answered**

- [x] **Are `source_created_at` / `source_updated_at` writable?**
      **No. BuilderLync stamps its own created date at write time and will not
      accept a supplied value.** Confirmed with the BuilderLync team.

      This is the single most consequential destination constraint, and it
      collides with Guide §9.4. Read that requirement precisely: it forbids
      rewriting history as new activity *"without storing the original source
      timestamps/author metadata"*. The obligation is not to set the created
      date — which is impossible here — but to ensure history does not
      masquerade as new activity.

      The engine satisfies it in three layers
      (`src/transformers/historical-fidelity.ts`):

      1. `source_created_at` / `source_updated_at` on every record — exact and
         machine-readable, used by delta sync and reconciliation, but invisible
         to someone browsing the UI.
      2. A dated attribution prefix on every migrated note and activity body:
         `[2021-03-14 · Mike Reynolds] Called the homeowner...`. This is the
         layer a human actually sees, and the one that stops five years of
         history reading as though it happened on migration day.
      3. The original date mirrored into a `migrated_original_date` custom
         field, so it can be displayed, sorted and filtered like any native
         field.

      The limitation is disclosed to the customer once in the migration report,
      with a record count and an explanation of where the real dates live —
      never as a per-record warning, which on a large account would write
      hundreds of thousands of rows and bury the warnings that need a human.

**Still open**

- [ ] What is the custom-field value format — keyed by field id, or by key?
      This blocks layer 3 above from being verified against the real API.
- [ ] Are there required fields with no canonical equivalent?
- [ ] What are the allowed `status` values, and are they per-tenant configurable?

### 2.2 Job / Project

| Canonical field | Sent | BuilderLync field | Notes |
|---|---|---|---|
| `job_number` | SENT | `TO CONFIRM` | Uniqueness constraint? `TO CONFIRM` |
| `name` | SENT | `TO CONFIRM` | |
| `contact_source_id` | SENT | resolved to `contact_builderlync_id` | Parent resolution is the engine's job |
| `opportunity_source_id` | SENT | resolved | |
| `address` | SENT | `TO CONFIRM` | |
| `job_type` | SENT | `TO CONFIRM` | Enumerated or free text? `TO CONFIRM` |
| `status` | SENT | `TO CONFIRM` | **Never copy foreign status ids** (Guide §8.5) |
| `value` | `{amount_cents, currency}` | `TO CONFIRM` | Confirm minor units vs decimal |
| `assigned_user_source_ids` | SENT | resolved to array | Multiple assignees supported? `TO CONFIRM` |
| `start_date` / `completion_date` | SENT | `TO CONFIRM` | |
| `tags`, `custom_fields`, `lead_source` | SENT | `TO CONFIRM` | |

### 2.3 User

| Canonical field | Sent | Notes |
|---|---|---|
| `first_name`, `last_name`, `email`, `phone` | SENT | |
| `role` / `source_role` | SENT | Both kept: `source_role` preserves the untranslated value for audit |
| `is_active` | SENT | |
| `is_historical` | SENT | **Scope §19.** Historical employees import as inactive historical users so their past work stays attributed to them instead of landing on current staff |

**Answered**

- [x] **Does importing historical users cost the customer anything?**
      **No — BuilderLync does not bill per user.** Confirmed with the
      BuilderLync team.

      This settles Scope §19 in favour of the highest-fidelity option. Every
      historical employee is imported as an inactive historical user, so their
      past work stays attributed to them. The lossy alternatives §19 lists —
      reassigning old work to the account owner, or leaving it unassigned —
      exist to avoid seat costs that do not apply here, and both destroy the
      attribution a contractor needs when they ask who handled a job three
      years ago. They remain available as mapping choices but are no longer
      the pragmatic default.

### 2.4 File / Image

| Canonical field | Sent | Notes |
|---|---|---|
| `file_name`, `original_name`, `mime_type`, `size_bytes` | SENT | |
| `content_hash` (SHA-256) | SENT | Computed on the bytes actually transferred |
| `parent_entity_type` + resolved parent id | SENT | |
| `kind` | SENT | `document` \| `image` \| `attachment` |
| `width`, `height`, `album` | SENT (images) | |
| `exif_retention` | SENT | `retain` \| `strip` — a policy decision recorded per file |

**Open questions**

- [ ] Upload mechanism: direct multipart, or pre-signed URL then register?
      Pre-signed is strongly preferred for large photo libraries.
- [ ] Maximum file size, and per-tenant storage quota (needed by preflight,
      Scope §16).
- [ ] **Does BuilderLync return a content hash?** Asked; not answered. The
      engine no longer depends on the answer either way.

      Requiring a hash would fail every upload against a destination that does
      not provide one; assuming success without one would let the report claim
      integrity that was never checked. The transfer therefore degrades
      explicitly and records which level it reached per file
      (`migration_files.integrity_level`):

      | Level | Meaning |
      |---|---|
      | `hash_verified` | Destination checksum matched the bytes sent |
      | `size_verified` | No checksum returned; byte count matched. Catches a truncated upload, not silent corruption |
      | `unverified` | Neither available. The upload succeeded; nothing about its contents was proven |

      A byte-count mismatch still fails the transfer. The migration report
      states how many files reached each level rather than reporting them all
      as "verified".

### 2.5 Remaining entities

`account`, `location`, `company`, `pipeline`, `pipeline_stage`,
`status_definition`, `tag`, `custom_field`, `opportunity`, `note`, `activity`,
`task`, `appointment` follow the same pattern. Canonical definitions are in
`services/migration/src/canonical/objects.ts`; BuilderLync columns are
`TO CONFIRM`.

---

## 3. How to complete this document

For each entity, from the live BuilderLync application:

1. Internal object name and API endpoint
2. Create method and update/upsert method
3. Required fields and optional fields
4. Parent/child relationships
5. Maximum field lengths
6. Allowed status values
7. Custom-field format
8. File attachment method
9. Tenant/account scoping requirements

Then:

* Update `services/migration/src/destination/http.ts` to match the real
  endpoints and payload shapes.
* Run the destination contract tests against the real API. They already pass
  against the sandbox driver, so any divergence is a genuine mismatch between
  what the engine sends and what BuilderLync accepts.
* Set `DESTINATION_DRIVER=http`.

Until then the sandbox driver stands in, and it implements the contract above
for real — which is why the engine's guarantees are demonstrable today rather
than assumed.
