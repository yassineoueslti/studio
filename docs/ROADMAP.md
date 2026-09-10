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
| 7 | HighLevel adapter | **Specified, not implemented — connector #3.** Scopes and rate limits confirmed from public docs |
| 8 | Deduplication and conflict handling | **Done** |
| 9 | File transfer engine | **Done** |
| 10 | Validation/reconciliation | **Done** |
| 11 | AccuLynx adapter | **Specified, not implemented — connector #1.** Best public documentation of the five. See below |
| 12 | JobNimbus adapter | **Specified, not implemented — connector #2.** Base URL, auth and pagination confirmed |
| 13 | ProLine hybrid adapter | **BLOCKED** — no public REST API documentation exists. Webhook inbox already built |
| 14 | Roofr/export importer | **BLOCKED** on obtaining real sample exports. See below |
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

**AccuLynx** — on documented merit.

The earlier justification for putting AccuLynx first was that working scripts
existed in-house to learn from. They do not, and no vendor SME is available, so
the order was re-derived from what can actually be verified from public
documentation (researched September 2026).

AccuLynx still comes first, for a better reason: **it is the best-documented of
the five by a wide margin, and it maps most directly onto the contractor model
BuilderLync stores.** Its public reference covers contacts (with emails,
phones, notes, custom fields, logs and job associations), jobs (with milestones,
photos, custom fields, trade and work types, lead sources), leads, users,
documents, payments, invoices, and 30+ webhook topics. It even publishes a
machine-readable documentation index at `apidocs.acculynx.com/llms.txt`.

### Already established (pinned in `src/adapters/planned.ts`)

- API key created by a Location or Company Administrator; **scoped per
  Location**, one key per integration — which confirms Scope §7.2's requirement
  that a multi-location company supplies several credentials merging into one
  canonical stream.
- Pagination: `pageStartIndex` (zero-based) + `pageSize`. Defaults vary by
  endpoint, typically 25–100, maximum often 50 — so **page size must be
  per-endpoint, not global**.
- Rate limiting is reported through `RateLimit-*` response headers; numeric
  limits are unpublished, so the limiter must **read the headers** rather than
  assume a fixed rate.
- Job-to-contact relationships are exposed directly as job associations, so
  they do not have to be inferred.

### Still to confirm, and it needs a live key

- The API base hostname and the exact header the key travels in. The docs
  describe key *creation* thoroughly but not key *transmission*.
- Actual numeric rate limits, by reading the headers from a real response.
- The milestone/status vocabulary in a real account — customer-configurable, and
  must be mapped rather than copied as foreign ids (Guide §8.5).
- Whether document download URLs are signed and expiring.
- Whether any updated-since filter exists; if not, delta sync leans on webhooks
  plus a reconciliation scan.

**So the single thing that unblocks connector #1 is an AccuLynx API key on a
real account** — ideally a multi-location one, since that exercises the hardest
requirement.

### Then JobNimbus (#2)

Simple and unambiguous: base `https://app.jobnimbus.com/api1/`, bearer key,
`size`/`from` offset pagination, endpoints `/contacts`, `/jobs`, `/tasks`,
`/estimates`, `/invoices`. Both `/contacts` and `/jobs` return what the key's
**Access Profile** permits — which confirms Guide §9.1 and makes the permission
preflight mandatory rather than a nicety.

Caveat: the only reference documentation is a Postman collection and **rate
limits are unpublished**, so start conservatively and measure.

### Then HighLevel (#3)

Ranked third only because it has no native job/project object, so it delivers
less of the contractor model — but its documentation is the most precise, which
makes it the right place to prove the full API-first path.

Confirmed: 100 requests / 10 seconds burst, 200,000 / day, counted **per app per
Location**, reported via `X-RateLimit-*` headers. Contacts paginate with
`startAfter`/`startAfterId`, 20 default and 100 maximum.

One finding worth carrying into implementation: **there are no separate readonly
scopes for pipelines, notes or tasks** — they are bundled under
`contacts.readonly`. Requesting a scope that does not exist fails authorization,
so the scope list must not invent them.

### Roofr (#4) and ProLine (#5) are blocked, not merely later

- **Roofr** exports contacts, proposals and measurement reports as CSV, and has
  no public API. A parser cannot be written without **real sample exports** —
  column headers and how photo archives reference their parent job cannot be
  inferred, and guessing produces a parser that dies on the first client file.
- **ProLine** has an API key and webhooks, but **no public REST API reference
  exists at all** — only end-user integration guides. Either developer
  documentation comes from ProLine directly, or the Zapier surface has to be
  assessed for bulk read access. Failing both, ProLine becomes export-assisted
  like Roofr.

Everything else — batching, checkpointing, retry, dedupe, files, reconciliation,
reporting, the two-pass delivery model, historical fidelity, the go-live
checklist, the wizard endpoints, the admin console, tenant isolation — already
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
