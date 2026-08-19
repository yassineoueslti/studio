# Architecture

## The one decision everything else follows from

> **Scope §88:** *"Source-specific logic belongs in adapters. Migration logic
> belongs in the migration platform… This architectural decision will determine
> whether the platform remains maintainable as BuilderLync grows from five
> source systems to twenty-five."*

Every structural choice in this repository serves that rule. Concretely:

* A source adapter is the **only** place a vendor field name may appear.
* Adapters emit **canonical objects**; nothing downstream knows which CRM a
  record came from.
* The destination receives canonical objects through **one interface**, so
  swapping the sandbox for the real BuilderLync API changes configuration, not
  code paths.

If you are about to write `if (platform === 'jobnimbus')` outside
`src/adapters/`, that is the rule being violated.

## Responsibility split (Scope §69)

```
                    ┌──────────────────────────────────────┐
                    │  BuilderLync application             │
                    │  wizard · console · auth · UX        │
                    └───────────────┬──────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────┐
                    │  Migration Service  (this repo)      │
                    │                                      │
                    │  authorize · store state · dedupe    │
                    │  validate · persist · map ids        │
                    │  audit · reconcile · report          │
                    └───┬──────────────────────────┬───────┘
                        │                          │
        ┌───────────────▼────────┐   ┌─────────────▼──────────────┐
        │ PostgreSQL             │   │ n8n workers                │
        │ migration_* tables     │   │ connect · extract · page   │
        │ secrets · object store │   │ throttle · download · call │
        └────────────────────────┘   └─────────────┬──────────────┘
                                                   │
                                     ┌─────────────▼──────────────┐
                                     │ Source adapters            │
                                     │ GHL · AccuLynx · JobNimbus │
                                     │ ProLine · Roofr · CSV      │
                                     └────────────────────────────┘
```

**n8n never holds migration state.** Scope §68 is explicit: n8n orchestrates,
but state and safe asynchronous execution live in the migration platform. This
is why the MIG-* workflows read their resume position from
`/internal/migration/:id/checkpoint/:entity` rather than from n8n execution
data — an n8n execution can die at any moment and the migration still resumes
correctly.

## Two supported topologies

Both are first-class; they differ only in who calls the adapter.

**In-process orchestration** — `POST /api/migrations/:id/start`
The migration service drives extraction directly through the adapter contract.
This is what the Sprint 1 acceptance run and the whole test suite use. It is
simpler to operate and appropriate for small and mid-size migrations.

**n8n-driven orchestration** — the `MIG-*` workflows
n8n owns connection, extraction, pagination, throttling and file download, then
calls the ingestion endpoints. This is the production topology for vendor
connectors, and the one Scope §5.3 describes.

The canonical schema and the ingestion contract are identical in both. That is
the point: the topology is a deployment decision, not a fork in the code.

## Request path for one batch

```
adapter.extract(entity, cursor)
   └─ rate limiter (Scope §25)          declared per-adapter req/s and req/min
   └─ retry w/ full jitter (Scope §29)  transient only; 403 is never retried
        │
        ▼
adapter.normalize(entity, raw)          the last place vendor fields exist
        │
        ▼
register discovered records             BEFORE any write — a crash here still
                                        leaves every record accounted for
        │
        ▼
validate against canonical schema       a bad record fails alone (Scope §44)
        │
        ▼
resolve parent references               source ids → BuilderLync ids, from
                                        migration_object_map (Scope §3.5)
        │
        ▼
skip unchanged  (content_hash match)    what makes a delta sync cheap
        │
        ▼
deduplicate     (tiers 1–4)             weak matches held, never auto-merged
        │
        ▼
destination.writeBatch()                idempotency key per record
        │
        ▼
record outcomes + advance checkpoint    one transaction — this ordering is
                                        what makes resume-after-crash safe
```

### Why the ordering matters

Two orderings in that path are load-bearing, and both are easy to get wrong:

**Discovery is registered before writing.** If the worker dies between
extraction and loading, the records are already in the ledger as `DISCOVERED`.
Reconciliation then reports them as in-flight and refuses to mark the migration
complete. Register *after* writing instead, and a crash makes records vanish
with nothing to reconcile against — the exact "unexplained missing records"
Scope §3.4 forbids.

**Outcomes and the checkpoint commit together.** The checkpoint says "everything
before this cursor is done". If it committed before the outcomes, a crash in
between would advance past records that were never recorded, and the resume
would skip them silently.

## Data model

Four tables carry the platform's guarantees:

| Table | Guarantee | Mechanism |
|---|---|---|
| `migration_object_map` | **Idempotency** | `UNIQUE (tenant_id, source_platform, source_object_type, source_object_id)` |
| `migration_checkpoints` | **Resumability** | Opaque cursor + batch number per entity, one row per entity |
| `migration_records` | **Auditability** | One row per discovered source object, with a final disposition |
| `migration_batches` | **Bounded work** | Per-batch status, retry counter and statistics |

The remaining tables — errors, warnings, files, mappings, duplicate candidates,
validation results, audit log, sync state, webhook inbox — support the features
built on top.

## Completion gate

A migration cannot report `COMPLETED` unless, for every entity:

```
Discovered = Created + Updated + Merged + Skipped + Unsupported + Failed
```

`DISCOVERED`, `QUEUED` and `PROCESSING` deliberately do **not** count as
accounted for. That is what stops the equation from being a tautology: a record
still in flight leaves a non-zero variance, and the migration lands in
`WAITING_FOR_REVIEW` — a state a human must clear.

Reconciliation also compares the discovery scan against the ledger. The equation
alone balances perfectly over whatever was extracted, so it cannot detect a
silently truncated page; comparing against what discovery said the source held
can.

## Relationship reconciliation

Reconciliation separates two things that look identical in the destination:

* A job that **had no customer at the source** — faithful migration of the
  source's own gap. Scope §60 lists "jobs without customers" as an edge case to
  carry across, not to reject.
* A job that **had a customer and lost it in transit** — a genuine defect.

Only the second blocks completion. The adapter raises a `JOB_WITHOUT_CONTACT`
warning during normalization, so the warning ledger already knows which gaps
pre-existed. Without that distinction, any dataset containing a customer-less
job would permanently fail validation for a defect that does not exist.

## Directory layout

Follows Guide §22:

```
services/migration/src/
  adapters/        source adapters + capability registry
    mock/          fixture-driven fake CRM (Sprint 1)
    planned.ts     declared capabilities for the five launch connectors
  api/             HTTP surface: control plane, ingestion, admin, webhooks
  canonical/       versioned canonical schema + content hashing
  db/              schema, pool, repositories
  dedupe/          confidence-tier matching
  destination/     the destination port + sandbox and HTTP drivers
  domain/          states, entities/sequencing, errors, permissions
  files/           asset transfer engine
  observability/   structured logging w/ redaction, metrics
  pipeline/        orchestrator, retry, rate limiting
  reporting/       manifest + customer report
  security/        credential encryption
  service/         the control plane the API delegates to
  transformers/    normalization
  validation/      reconciliation
n8n/workflows/     MIG-001, MIG-100, MIG-140, MIG-900
```

## Versioning (Scope §66)

Every migration records three versions, so data imported by older logic stays
identifiable:

* `source_connector_version` — e.g. `jobnimbus-v1.2.0`
* `canonical_schema_version` — currently `1.0.0`
* `destination_api_version` — the BuilderLync API contract in force

Individual records additionally carry a `transformer_version`
(e.g. `jobnimbus-contact-v1.4.2`, Scope §31).
