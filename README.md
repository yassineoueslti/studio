# BuilderLync Universal CRM Migration Engine

One migration platform with source adapters — not five migration tools.

Moves contacts, users, opportunities, jobs, pipelines, stages, tags, custom
fields, notes, activities, documents and images out of contractor CRMs and into
BuilderLync: **idempotently, resumably, auditably, and with relationships
intact**.

Built to the *Universal CRM Migration Engine — Product & Technical Scope* and
the *Step-by-Step Implementation Guide*. Section references throughout the code
and docs point back to those documents.

---

## Status

**Sprint 1 (Guide §25) is complete and verified.** The platform foundation is
built and proven against a mock source, which is the order both documents
require: *"build the migration platform first, then add CRM adapters."*

```
$ pnpm demo

[PASS] Volume: 5,000 contacts + 1,000 jobs processed
       4,985 contacts, 1,000 jobs in destination
[PASS] Safe restart: migration resumed after a forced crash
       0 -> 4,985 contacts across the restart
[PASS] Idempotency: replaying the same source data created no duplicates
       0 net new rows from the replay
[PASS] No unexplained records: discovered = accounted for, every entity
       contact:0 custom_field:0 job:0 pipeline:0 pipeline_stage:0 tag:0 user:0
[PASS] ID mapping: every migrated object is traceable to its source
       6,023 rows in migration_object_map
[PASS] Relationships: jobs resolved to their migrated contacts
[PASS] Report produced with a machine-readable manifest

SPRINT 1 ACCEPTANCE: PASSED
```

**73 tests pass**, including all eleven of Guide §20's named
production-readiness tests.

The five launch connectors — GoHighLevel, AccuLynx, JobNimbus, ProLine, Roofr —
ship as **declared capability registries with verification checklists**, not as
extraction code. See [why](docs/ROADMAP.md#why-the-vendor-connectors-are-specified-rather-than-implemented).

---

## Quick start

```bash
createdb builderlync_migration && createdb builderlync_migration_test
cp .env.example services/migration/.env
openssl rand -base64 32          # → MIGRATION_SECRET_KEY in .env

pnpm install
pnpm db:migrate

pnpm test     # 73 tests
pnpm demo     # Sprint 1 acceptance run
pnpm dev      # API on :3001
```

Full walkthrough, including driving a whole migration from cURL:
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## The five properties everything else serves

| Property | How it is guaranteed |
|---|---|
| **Reusable** (§3.1) | One engine. Source-specific logic exists only inside adapters — enforced by the canonical schema boundary and by test |
| **Idempotent** (§3.2) | `migration_object_map`, unique on `(tenant, platform, object type, source id)`, plus a per-record idempotency key and content hash |
| **Resumable** (§3.3) | Checkpoints commit in the same transaction as record outcomes, so a killed worker resumes without re-importing or skipping |
| **Auditable** (§3.4) | Every discovered record gets exactly one disposition. `Discovered = Created + Updated + Merged + Skipped + Unsupported + Failed` is a **hard completion gate** |
| **Relationship-aware** (§3.5) | Entities migrate in dependency order; parent source ids resolve to BuilderLync ids from the object map before any write |

---

## What is built

**Platform**
Migration database (all `migration_*` tables) · migration and record state
machines · versioned canonical schema (13 object families) · source adapter
contract + capability registry · orchestrator with dependency-ordered phases,
bounded batches, multi-level checkpoints, three-tier retry with full-jitter
backoff and token-bucket throttling · normalization · four-tier deduplication ·
file transfer engine with SHA-256 integrity and independent per-asset retry ·
reconciliation and reporting · migration API · internal batch ingestion ·
admin console endpoints · deduplicating webhook inbox · server-side tenant
enforcement · AES-256-GCM credential encryption · secret redaction · audit log.

**Orchestration**
n8n workflows MIG-001 (controller), MIG-100 (contacts), MIG-140 (jobs),
MIG-900 (error handler) — with checkpoint and error endpoints so n8n holds no
migration state of its own.

**Destination**
The engine writes through one `DestinationClient` interface. A **sandbox
driver** implements the documented BuilderLync ingestion contract against
PostgreSQL, so idempotency and crash-resume are provable today. An **HTTP
driver** is ready for the real API; both are held to the same contract.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/DESTINATION_INVENTORY.md`](docs/DESTINATION_INVENTORY.md) | **Guide §1.1** — the BuilderLync contract. Ingestion endpoints, idempotency rules, batch response shape, and the per-entity field tables to confirm |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Responsibility split, both supported topologies, the batch request path and why its ordering matters |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Guide §19's eleven items, each with state and location |
| [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md) | Guide §20's eleven tests mapped to implementations |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Guide §21's twenty steps with current state, and the next sprint |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Setup, cURL walkthrough, stuck migrations, retries, record tracing, monitoring, deployment |

---

## Repository layout

```
services/migration/     the migration service (Guide §22)
  src/adapters/         source adapters + capability registry
  src/canonical/        versioned canonical schema
  src/destination/      destination port + sandbox and HTTP drivers
  src/pipeline/         orchestrator, retry, rate limiting
  src/dedupe/           confidence-tier matching
  src/validation/       reconciliation
  test/                 73 tests
  scripts/              Sprint 1 acceptance run
n8n/workflows/          MIG-001, MIG-100, MIG-140, MIG-900
docs/                   the documents above
```

---

## Next step

Guide §21 step 7: the **HighLevel connector** — chosen first by the guide
because it has a current REST API, OAuth, contacts, opportunities and webhooks.
Its verification checklist is already written in
`services/migration/src/adapters/planned.ts`.

A new connector inherits batching, checkpointing, retry, deduplication, file
transfer, reconciliation, reporting, the wizard endpoints, the admin console and
tenant isolation. It only has to earn authentication, discovery, extraction and
field mapping.
