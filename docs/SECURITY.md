# Security Checklist

Guide §19 lists eleven items required before production. Each is recorded below
with its current state and where it is implemented or verified.

| # | Requirement | State | Where |
|---|---|---|---|
| 1 | Encrypt source credentials at rest | **Implemented** | `src/security/crypto.ts` — AES-256-GCM, per-row IV and auth tag, `key_version` stored for rotation |
| 2 | Use TLS for every source/destination call | **Enforced by configuration** | `BUILDERLYNC_API_BASE_URL` must be `https://` in production; adapters must not downgrade |
| 3 | Never log API keys or OAuth tokens | **Implemented** | `src/observability/redact.ts` — deep redaction at the logging boundary, not at call sites |
| 4 | Enforce BuilderLync tenant identity server-side | **Implemented + tested** | `src/api/auth.ts`, every repository query; *Test 10* |
| 5 | Use least-privilege source permissions | **Supported** | Per-adapter capability registry + permission preflight (`testConnection().resourceAccess`) |
| 6 | Use signed/expiring file URLs | **Partial** | Sandbox writes to local storage. Signed-URL issuance belongs to BuilderLync's object store — see open items |
| 7 | Keep migration raw payload retention bounded | **Implemented** | `RAW_PAYLOAD_RETENTION_DAYS`, `raw_payload_expires_at`, hourly `purgeExpiredRawPayloads()` sweep |
| 8 | Record audit events for migration actions | **Implemented** | `migration_audit_log`, 17 audit actions, written in the same transaction as the change |
| 9 | Role permissions for view/create/configure/start/pause/cancel/retry/admin | **Implemented** | `src/domain/permissions.ts`, enforced at every service entry point |
| 10 | Redact secrets from n8n execution data and application logs | **Implemented (service) / configuration (n8n)** | Service: item 3. n8n: credentials must be stored as n8n credentials, never in workflow JSON or Code nodes (Guide §5.3) |
| 11 | Separate development/staging credentials from production | **Enforced by configuration** | `NODE_ENV=production` refuses to start with `DESTINATION_DRIVER=sandbox` or a missing `MIGRATION_SECRET_KEY` |

## Credential handling

Source credentials follow one path and never leave it:

```
customer input → POST /api/migrations/:id/connect
                   → seal()  AES-256-GCM
                   → migration_credentials (ciphertext, iv, auth_tag, key_version)
                   → open()  only inside the adapter that needs it
```

They are **never**:

* returned in an API response — `/connect` confirms storage, it does not echo
  the secret;
* written to a log — the redactor strips any key matching
  `password|secret|token|api[-_]?key|authorization|credential|…` and any value
  shaped like `Bearer …`;
* stored in n8n workflow JSON;
* included in a support export.

### Rotation

`rotateCredentials(tenantId)` re-wraps every credential below the current key
version. Because `key_version` is stored per row, rotation is incremental — no
flag day, and a partially-rotated state is valid.

## Tenant isolation (Scope §47)

Defence in depth, because this is the failure with the worst blast radius —
writing one contractor's customers into another's account:

1. **Transport** — the tenant comes from the authenticated principal. A
   `tenant_id` in a request body is ignored.
2. **Query** — every repository function takes `tenantId` and puts it in the
   `WHERE` clause. There is no unscoped accessor except an explicitly named
   staff function.
3. **Destination** — the sandbox driver independently re-checks that the
   payload's tenant matches the request's, and rejects the record if not. The
   destination does not assume the caller already validated.
4. **Error shape** — a cross-tenant id returns *not found*, never *forbidden*,
   so the API cannot be used to probe which migration ids exist elsewhere.

Verified by *Test 10 — Tenant isolation* (three cases: crafted payload,
cross-tenant read, listing scope).

## Raw payload retention (Scope §30)

Raw source payloads are retained to make transformation bugs diagnosable
without re-querying the vendor. They are also the most sensitive thing the
migration database holds, so:

* retention is bounded by `RAW_PAYLOAD_RETENTION_DAYS` (default 14);
* `raw_payload_expires_at` is set at write time;
* an hourly sweep nulls expired payloads while keeping the ledger row — the
  record stays accounted for after its payload is gone;
* reading a raw payload requires `migration.admin` and is itself audited.

## Pre-deployment audit

A hostile-input audit was run against every boundary before deployment. It
found **fifteen** genuine defects, all fixed and each now covered by a
regression test. They are recorded here because the pattern matters more than
the list: every one passed the functional suite first.

### Authorization

| Finding | Severity | Fix |
|---|---|---|
| Internal endpoints accepted a `migration_id` without checking it belonged to the caller's tenant — a valid token could poison another tenant's checkpoints, inject errors into their dashboard, or tag rows with their migration | **High** | Every internal endpoint now verifies ownership, reporting *not found* rather than *forbidden* so it cannot be used to probe for ids |
| `GET /webhooks/:vendor/inbox` was anonymous and returned vendor event ids, types and error text across all customers | **High** | Authenticated. The POST ingress stays open because vendors must reach it |
| `GET /metrics` was anonymous | Medium | Authenticated. `/health` stays open for load balancers and leaks nothing beyond liveness |

### Data integrity

| Finding | Severity | Fix |
|---|---|---|
| Idempotency used check-then-insert. Three concurrent identical batches produced **19 duplicate contacts** | **High** | Unique index on `(tenant_id, external_source_platform, external_source_id)` plus `INSERT … ON CONFLICT`. The guarantee now lives in a constraint, which a race cannot lose |
| A source repeating one record inside a page aborted the whole migration with a raw Postgres error (`cannot affect row a second time`) — and real APIs do this when rows shift under a paginating reader | **High** | Repeats collapse before the multi-row insert |
| A short batch response was only detected in the HTTP driver, so the in-process path accepted it silently | **High** | Completeness is asserted in the orchestrator, covering every driver |
| A destination could return results for records it was never sent, writing fabricated entries into the object map | Medium | Results are filtered to what was actually sent; phantoms are logged and discarded |
| An adapter reporting `hasMore` forever looped indefinitely | Medium | Extraction stops on an empty page and warns if the adapter still claimed more |

### Configuration and filesystem

| Finding | Severity | Fix |
|---|---|---|
| A wrong-length `MIGRATION_SECRET_KEY` let the service boot healthy and pass health checks, then fail the first customer's source connection with a generic 500 | **High** | Key length is validated at startup, so a misconfigured deploy refuses to start |
| Tenant and migration ids reached a filesystem path unsanitized | Medium | Every path segment is reduced to safe characters; confinement to the storage root is tested with a hostile tenant id |
| `tsx` strips types without checking them, so a type error could pass all tests | Medium | `pnpm test` now typechecks first |
| Production could start with `DESTINATION_DRIVER=http` over plain HTTP | Low | Production requires `https://` |

### Deployment surface

Found by stopping the "run it from source" habit and doing what an operator
does: follow the README on a clean machine, build the artifact, start it. Every
one of these was invisible behind a green test suite, because the suite never
built the service and never read a config file.

| Finding | Severity | Fix |
|---|---|---|
| Nothing in the codebase read `.env`. The README instructs the operator to create one and put `MIGRATION_SECRET_KEY` in it — every value they configured was silently ignored in favour of schema defaults, giving a service pointed at the wrong database with credential encryption unconfigured | **High** | `src/env.ts` loads `.env` through the single choke point every entrypoint already uses. Real environment variables still win, so container secrets are never overridden by a `.env` baked into an image |
| `.env.example` shipped `DESTINATION_DRIVER=in-memory`; the schema accepts only `sandbox \| http`. Copying the example verbatim, exactly as the README says, produced a service that refused to start | Medium | Corrected, and a test now parses `.env.example` against the real schema so the two cannot drift again |
| The build emitted `dist/src/index.js` while `package.json` pointed `main` and `start` at `dist/index.js`. `pnpm start` could never have worked | **High** | A dedicated `tsconfig.build.json` with a single root. `pnpm build` asserts the entrypoint exists before it reports success |
| The production build compiled the test suite, the mock source adapter and the acceptance script into `dist/` | Medium | The build config covers `src/` only; asserted by test |
| Schema migrations are `.sql` files read from disk relative to the compiled module, and `tsc` does not copy them. A built service would start, pass its health check, and die on its first query with `ENOENT` | **High** | `scripts/bundle-assets.mjs` copies them and fails the build if any is missing |
| The test suite inherited the *development* database defaults, so on a machine where that database was reachable, running the tests would have `TRUNCATE`d it | Medium | Vitest pins the test database and keys, so the suite cannot reach any other database |

### Verified as already safe

Confirmed by test rather than assumed: SQL identifiers are never interpolated
from user input; hostile SQL in source ids and payloads round-trips as literal
text; batch size limits hold; deeply nested payloads do not crash the process;
a reused idempotency key cannot overwrite a different record; credentials never
appear in any API response and are ciphertext at rest; errors carry no stack
traces or connection strings.

## Open items before production

- [ ] **Signed URLs for file transfer** (item 6). The sandbox writes to local
      storage. Production needs pre-signed, expiring upload and download URLs
      from BuilderLync's object store — also the right answer for large photo
      libraries, since it keeps bytes out of the migration service entirely.
- [ ] **Key management.** `MIGRATION_SECRET_KEY` is read from the environment.
      Production should source it from a managed KMS with audited access.
- [ ] **Rate limiting on the public API.** The migration control endpoints have
      no per-tenant request limiting yet.
- [ ] **Alerting** (Scope §57). Metrics are emitted; alert rules for worker
      offline, abnormal error rate, queue backlog, repeated vendor auth failure
      and stalled migrations still need wiring to the monitoring stack.
- [ ] **Penetration test** of the ingestion endpoints before they are exposed
      to n8n workers outside the trust boundary.

## Reporting a vulnerability

Do not open a public issue. Contact the BuilderLync security owner directly.
