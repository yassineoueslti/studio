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
| 7 | HighLevel adapter | **Specified, not implemented** — capabilities declared, verification checklist written |
| 8 | Deduplication and conflict handling | **Done** |
| 9 | File transfer engine | **Done** |
| 10 | Validation/reconciliation | **Done** |
| 11 | AccuLynx adapter | **Specified, not implemented** |
| 12 | JobNimbus adapter | **Specified, not implemented** |
| 13 | ProLine hybrid adapter | **Specified, not implemented** — webhook inbox already built |
| 14 | Roofr/export importer | **Specified, not implemented** |
| 15 | Generic CSV/XLSX importer | **Not started** |
| 16 | Customer wizard | **Backend complete** — every wizard step has an endpoint; UI not built |
| 17 | Admin console | **Backend complete** — search, object map, raw payloads, revalidate, manifest; UI not built |
| 18 | Incremental sync | **Foundations built** — watermarks, `getChanges()`, webhook inbox with deduplication; delta workflows not built |
| 19 | Final cutover workflow | **State modelled** (`CUTOVER_COMPLETE`); workflow not built |
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

Guide §21 step 7 — the HighLevel connector — is the natural next unit, and the
guide explains why it is first: a current REST API, OAuth, contacts,
opportunities and webhooks.

1. Work the HighLevel verification checklist in `src/adapters/planned.ts`
   against live documentation.
2. Write connector contract tests pinning those assumptions.
3. Replace `PlannedAdapter` with a real `HighLevelAdapter` implementing
   `SourceAdapter`. Extraction order per Guide §7.4: users → pipelines/stages →
   contacts → opportunities → notes/tasks → files.
4. Wire OAuth token storage through `src/security/crypto.ts`.
5. Fill in the `TO CONFIRM` cells in `docs/DESTINATION_INVENTORY.md` and point
   `DESTINATION_DRIVER=http` at the real BuilderLync API.

Everything else — batching, checkpointing, retry, dedupe, files, reconciliation,
reporting, the wizard endpoints, the admin console, tenant isolation — already
works and is under test. A new connector inherits all of it.

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
