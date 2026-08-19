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
