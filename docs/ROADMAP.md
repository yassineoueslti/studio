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
| 11 | AccuLynx adapter | **Specified, not implemented** |
| 12 | JobNimbus adapter | **Specified, not implemented** |
| 13 | ProLine hybrid adapter | **Specified, not implemented** — webhook inbox already built |
| 14 | Roofr/export importer | **Specified, not implemented — but promoted to connector #1.** See below |
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

**Roofr, not HighLevel.**

Guide §21 puts HighLevel first, reasoning that it has the most modern API
surface — a current REST API, OAuth, contacts, opportunities and webhooks. That
reasoning is sound in the abstract and is why HighLevel stays the natural
*second* connector.

Delivery reality overrides it. Roofr is the source actively being migrated for
live clients right now, so it is the connector whose absence costs onboarding
time today. Building the technically-nicest connector while the team hand-runs
the one they actually need every week is the wrong order.

### Before writing any Roofr code

**Read the existing migration scripts and n8n workflows first.** They already
move Roofr job data for real onboardings, which means they encode field
mappings, export quirks and edge cases discovered against real client exports.
That knowledge does not exist in any documentation, and re-deriving it from
scratch means rediscovering the same problems the hard way.

The goal is to fold that working knowledge into the adapter contract — not to
replace it with a guess.

### Then

1. Work the Roofr verification checklist in `src/adapters/planned.ts`:
   confirm current export formats and their exact column headers, whether file
   and photo archives can be exported, and how assets reference their parent
   job.
2. Decide the asset-correlation rule — source id, job number, directory
   structure, or manifest (Guide §11.5).
3. Implement the export parser behind `SourceAdapter`, emitting the same
   canonical objects as any API adapter.
4. Confirm the export carries a stable record id. If it does not, a
   migration-scoped synthetic id is required, and its limitations for the
   second pass must be documented (Guide §12.4).
5. Fill in the `TO CONFIRM` cells in `docs/DESTINATION_INVENTORY.md` and point
   `DESTINATION_DRIVER=http` at the real BuilderLync API.

Then HighLevel, which is where the API-first path — OAuth, webhooks, real
timestamp-based delta sync — gets proven.

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
