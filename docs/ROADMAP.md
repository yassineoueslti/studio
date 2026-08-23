# Build Sequence and Roadmap

Guide §21 fixes the build order. This is where the project stands against it.

| # | Step | State |
|---|---|---|
| 1 | BuilderLync destination inventory and batch APIs | **Done** — contract implemented and verified; entity field tables await BuilderLync confirmation (`docs/DESTINATION_INVENTORY.md`) |
| 2 | Migration database and state machine | **Done** |
| 3 | Canonical schemas | **Done** — 13 object families, v1.0.0 |
| 4 | Migration service endpoints | **Done** — full `/api/migrations/*` family |
| 5 | n8n environment and reusable controller workflows | **Done** — MIG-001/100/140/900; staging n8n deployment is an ops task |
| 6 | Mock/test adapter | **Done** |
| 7 | HighLevel adapter | **Specified, not implemented** — capabilities declared, verification checklist written. *Reordered: see below* |
| 8 | Deduplication and conflict handling | **Done** |
| 9 | File transfer engine | **Done** |
| 10 | Validation/reconciliation | **Done** |
| 11 | AccuLynx adapter | **Specified, not implemented — promoted to connector #1.** Working scripts exist in-house. See below |
| 12 | JobNimbus adapter | **Specified, not implemented** |
| 13 | ProLine hybrid adapter | **Specified, not implemented** — webhook inbox already built |
| 14 | Roofr/export importer | **Specified, not implemented — connector #2, blocked on sample exports.** See below |
| 15 | Generic CSV/XLSX importer | **Not started** |
| 16 | Customer wizard | **Backend complete** — every wizard step has an endpoint; UI not built |
| 17 | Admin console | **Backend complete** — search, object map, raw payloads, revalidate, manifest; UI not built |
| 18 | Incremental sync | **Built and tested** — named passes (historical / delta / final delta), watermarks, `getChanges()`, webhook inbox with deduplication. See `docs/DELIVERY_MODEL.md` |
| 19 | Final cutover workflow | **Built and tested** — `POST /final-delta`, go-live readiness with named blockers, 30-day SLA tracking |
| 20 | MCP/AI migration assistance | **Not started** — correctly last |

> Guide §21: *"Do not build AI-assisted mapping before deterministic mapping,
> idempotency, checkpointing, retries, and reconciliation are proven."*
> Steps 2, 8, 9 and 10 are now proven by a passing test suite, so step 20 is
> unblocked whenever the deterministic connectors are in place.

## Why the vendor connectors are specified rather than implemented

This is deliberate and follows both source documents.

Guide §25 opens: *"For the first implementation sprint, do not attempt a real
vendor migration. Build the platform foundation."* Guide §24 adds: *"vendor APIs
change. Before coding any adapter, confirm the current endpoint version, scopes,
pagination method, rate limits, and object coverage in the official
documentation and lock those assumptions into connector contract tests."*

Writing extraction code from memory would produce adapters that look finished
and fail on first contact with a real account — the worst possible state,
because it is indistinguishable from working code until a customer's migration
is already running.

What each planned connector ships with instead:

* a **real capability registry** that the wizard, preflight, discovery and
  reconciliation all read today;
* per-vendor **design notes** drawn from Scope §7 (AccuLynx multi-location
  credentials, JobNimbus permission-dependent access, ProLine's unguaranteed
  webhook delivery, Roofr's export-first path);
* a **verification checklist** naming exactly what to confirm before coding;
* a `PlannedAdapter` that fails loudly with that checklist if anything tries to
  pull data through it, rather than failing obscurely at 60% of a migration.

## Next sprint

**AccuLynx.**

Guide §21 puts HighLevel first, reasoning that it has the most modern API
surface. That ranks connectors by how pleasant their API is rather than by what
can actually be finished, and one fact outweighs it: **working AccuLynx
migration scripts already exist in-house and have run against real client
accounts.**

That is the strongest de-risking signal available. Those scripts encode field
names, milestone vocabularies, multi-location credential handling and edge cases
that were each found the hard way against live data. Starting from a proven
mapping beats starting from vendor documentation, and it is available today.

### Before writing any AccuLynx code

Read the existing scripts. Extract, in priority order:

1. The exact AccuLynx field names used per object.
2. The milestone / status value vocabulary observed in real accounts.
3. How multi-location credentials are handled.
4. Pagination parameters and any rate limits hit in practice.
5. **Every edge case the script special-cases** — each one is a bug someone
   already paid for.

Port that knowledge into `normalize()`, not into the platform. The scripts
predate the canonical schema, so their output shape will not match; the mappings
they encode are the valuable part, not their structure.

### Then

1. Work the AccuLynx verification checklist in `src/adapters/planned.ts` against
   current vendor documentation — the scripts show what *worked*, the docs show
   what is *supported now*, and those diverge over time.
2. Write connector contract tests pinning both.
3. Replace `PlannedAdapter` with a real `AccuLynxAdapter`. Extraction order per
   Guide §8.3: users → contacts → jobs → job contacts/relationships →
   milestones/status → notes/logs → documents.
4. Handle multi-location credentials: one company may hold several AccuLynx
   locations, each with its own key, merging into one canonical stream
   (Scope §7.2).
5. Map milestones to BuilderLync stages. **Never copy foreign status ids**
   (Guide §8.5).

### Then Roofr — but it is blocked

Roofr is migrated by hand today, so automating it removes real recurring
effort. There is no existing tooling for it, and it is export-based, so a parser
cannot be written without **real sample exports**. Column headers, export
variants and how photo archives reference their parent job cannot be inferred
from documentation; guessing them produces a parser that fails on the first real
client file.

**The unblock:** obtain sanitized sample exports of each type — contacts, jobs,
and any file/photo archive — and add them to `test/fixtures` as contract tests.

HighLevel follows third, and remains the right place to prove the full API-first
path: OAuth, webhooks and genuine timestamp-based delta sync.

Everything else — batching, checkpointing, retry, dedupe, files, reconciliation,
reporting, the two-pass delivery model, the go-live checklist, the wizard
endpoints, the admin console, tenant isolation — already works and is under
test. A new connector inherits all of it.

## Definition of done for a supported CRM (Scope §82)

A source is not marketed as supported until:

- [ ] Authentication is self-service
- [ ] Connection testing works
- [ ] Discovery works
- [ ] Supported objects are documented
- [ ] Fields map correctly
- [ ] Relationships are maintained
- [ ] Idempotency works
- [ ] Migrations resume after interruption
- [ ] Duplicate protection works
- [ ] Rate limiting works
- [ ] Files are validated where supported
- [ ] Errors are actionable
- [ ] Validation reconciliation runs
- [ ] The customer receives a migration report
- [ ] Internal staff can troubleshoot without engineering database access

Items 7–15 are provided by the platform and already pass for the mock source.
Items 1–6 are what a connector must earn.
