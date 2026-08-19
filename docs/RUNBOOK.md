# Runbook

## Local setup

```bash
# 1. PostgreSQL 16
createdb builderlync_migration
createdb builderlync_migration_test

# 2. Configuration
cp .env.example services/migration/.env
# Generate the credential encryption key (Guide §19):
openssl rand -base64 32     # → MIGRATION_SECRET_KEY

# 3. Install and apply the schema
pnpm install
pnpm db:migrate

# 4. Run
pnpm dev            # API on :3001
pnpm test           # 73 tests
pnpm demo           # Sprint 1 acceptance run
```

In development the service registers a bearer token `dev-token` for tenant
`dev-tenant`, so the API is usable from cURL immediately. It is never
registered outside `NODE_ENV=development`.

## Driving a migration from cURL

Guide §4's definition of done is that the whole lifecycle works before any real
connector exists. It does:

```bash
API=http://localhost:3001
AUTH="Authorization: Bearer dev-token"
JSON="Content-Type: application/json"

# Create
MIGRATION=$(curl -s -X POST $API/api/migrations -H "$AUTH" -H "$JSON" \
  -d '{"source_platform":"mock","configuration":{"selectedEntities":["user","contact","job"]}}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["migration"]["id"])')

curl -s -X POST $API/api/migrations/$MIGRATION/test-connection -H "$AUTH"
curl -s -X POST $API/api/migrations/$MIGRATION/discover        -H "$AUTH"
curl -s     $API/api/migrations/$MIGRATION/preflight           -H "$AUTH"
curl -s -X POST $API/api/migrations/$MIGRATION/start           -H "$AUTH" -H "$JSON" -d '{}'
curl -s     $API/api/migrations/$MIGRATION/status              -H "$AUTH"
curl -s -X POST $API/api/migrations/$MIGRATION/validate        -H "$AUTH"
curl -s    "$API/api/migrations/$MIGRATION/report?format=text" -H "$AUTH"
```

## Operational procedures

### A migration is stuck

```bash
curl -s $API/api/migrations/$ID/status  -H "$AUTH"   # current entity, batch, last checkpoint
curl -s $API/api/migrations/$ID/batches -H "$AUTH"   # per-batch state
curl -s $API/api/migrations/$ID/errors  -H "$AUTH"   # open errors, filterable
```

`last_successful_checkpoint` tells you where a resume would restart. If the
migration is `FAILED`, `POST /resume` continues from there — resume is not a
special mode, it is the ordinary run observing the checkpoints the previous
attempt left behind.

### Records failed and should be retried

```bash
# Individual failed records (Scope §29 level 3)
curl -X POST $API/api/migrations/$ID/retry -H "$AUTH" -H "$JSON" \
  -d '{"scope":"failed_records"}'

# Re-extract an entity from scratch (level 2)
curl -X POST $API/api/migrations/$ID/retry -H "$AUTH" -H "$JSON" \
  -d '{"scope":"failed_batches","entity":"contact"}'

curl -X POST $API/api/migrations/$ID/resume -H "$AUTH"
```

Retry is always safe to issue: writes are idempotent, so records that already
succeeded are skipped rather than duplicated.

### Validation is failing

`POST /validate` returns `blockingReasons`, which name the specific problem:

| Reason | Meaning | Action |
|---|---|---|
| `<entity>: N discovered but only M accounted for` | Records still in flight or lost | Resume, then re-validate |
| `discovery found N but only M were extracted` | A page was silently truncated | Re-run extraction for that entity |
| `files: … still pending` | Asset transfer incomplete | Re-run the file transfer |
| `N job(s) lost their customer during migration` | Real orphans — their contacts failed or were held | Fix the contacts, retry, re-validate |

A job that had **no customer at the source** is reported separately and does not
block: migrating a gap the source already had is correct behaviour.

### Tracing one record (Scope §64)

```bash
curl -s "$API/admin/migrations/search?source_id=C000123"    -H "$AUTH"
curl -s "$API/admin/migrations/search?email=x@example.com"  -H "$AUTH"
curl -s "$API/admin/migrations/search?job_number=2024-1005" -H "$AUTH"
curl -s "$API/admin/migrations/search?filename=roof-3.jpg"  -H "$AUTH"

# Raw source payload, within the retention window. Requires migration.admin
# and is itself audited.
curl -s "$API/admin/migrations/$ID/records/contact/C000123/raw" -H "$AUTH"
```

### Duplicates awaiting review

```bash
curl -s $API/api/migrations/$ID/duplicates -H "$AUTH"
curl -X POST $API/api/migrations/$ID/duplicates/$CANDIDATE -H "$AUTH" -H "$JSON" \
  -d '{"decision":"MERGE"}'    # MERGE | CREATE_NEW | SKIP
```

Decisions persist, so retries and delta syncs reuse them instead of re-asking
(Guide §13.4).

## Monitoring

`GET /metrics` exposes Prometheus text format with the Scope §55 metric names.
Alert on (Scope §57):

* `migration_records_failed_total` rising sharply
* `migration_api_errors_total` by source — a spike usually means a vendor
  incident or a revoked credential
* `migration_source_rate_limit_total` sustained — the adapter's declared
  rate limit is too aggressive for that account
* no `migration_records_processed_total` movement while a migration is in an
  active state — a stalled worker

## Deploying

1. Provision PostgreSQL and run `pnpm db:migrate`.
2. Set `MIGRATION_SECRET_KEY` from a managed KMS.
3. Set `DESTINATION_DRIVER=http` and point `BUILDERLYNC_API_BASE_URL` at the
   real API.
4. Replace `src/api/auth.ts` with BuilderLync's own session verification. The
   only contract it must satisfy is the `Principal` type: a user id, a
   **server-resolved** tenant, and a permission set.
5. Import `n8n/workflows/*.json` into the staging n8n instance and set
   `BUILDERLYNC_MIGRATION_API`, `BUILDERLYNC_MIGRATION_TOKEN` and the
   `N8N_WORKFLOW_MIG_*` ids.

`NODE_ENV=production` refuses to start with the sandbox destination or a
missing encryption key, so a misconfigured deploy fails immediately rather than
quietly writing customer data into a development stand-in.
