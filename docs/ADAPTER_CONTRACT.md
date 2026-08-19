# Source Adapter Contract

**`services/migration/src/adapters/types.ts`**

Every CRM implements the same interface and returns canonical objects. This is
the boundary that keeps vendor field names out of BuilderLync (Scope §88).

## Interface (Guide §6)

```ts
interface SourceAdapter {
  readonly platform: SourcePlatform;
  readonly connectorVersion: string;
  readonly capabilities: SourceCapabilities;
  readonly rateLimit: RateLimitProfile;
  readonly paginationStrategy: PaginationStrategy;

  authenticate(context): Promise<void>;
  testConnection(context): Promise<ConnectionTestResult>;
  discover(context): Promise<DiscoveryResult>;

  extract(entity, context, options?): Promise<ExtractPage>;
  normalize(entity, raw, context): Record<string, unknown>;   // pure, no I/O
  transformerVersion(entity): string;

  getChanges?(entity, context, since, options?): Promise<ExtractPage>;
  downloadFile?(context, file): Promise<{ content, mimeType, fileName }>;
  disconnect?(context): Promise<void>;
}
```

Guide §6 lists per-entity methods (`getUsers()`, `getContacts()`, …). They exist
as helpers in `entityMethods`, but the pipeline drives extraction through the
single `extract(entity, …)` entry point — so adding an entity does not mean
touching the orchestrator.

**`extract()` returns raw source records; `normalize()` converts them.** Keeping
those separate is what lets the platform retain raw payloads for troubleshooting
(Scope §30) and re-run a transformation with a newer transformer version without
re-querying the vendor (Scope §31).

## Capability registry (Scope §65)

```ts
{
  entities: { contact: true, job: true, document: 'conditional', appointment: false, … },
  delta_sync: true | false | 'conditional',
  webhooks: …,
  historical_api_access: …,
  self_service_auth: …,
  file_export_import: …,
  notes: { files: 'Media access depends on granted scopes and plan.' },
}
```

`'conditional'` is the important value. Several sources expose files only on
certain plans or scopes (Scope §7.3, §7.4). Declaring that up front lets the
wizard warn *before* a migration instead of failing 80% through the asset phase.

The registry is read at runtime by discovery, preflight, entity sequencing and
the wizard. It is data, not documentation.

## Rate limits (Scope §25)

```ts
{
  requestsPerSecond, requestsPerMinute, pageSize, concurrency,
  retryAttempts, retryDelayMs, backoffMultiplier, maxRetryDelayMs,
}
```

The orchestrator enforces these with a token bucket before every call. Guide
§8.4 — *"Do not let n8n automatically retry indefinitely"* — is why being polite
up front matters: some vendors penalise sustained overage beyond the individual
request.

## Pagination (Scope §26)

Declare one of `page | offset | cursor | next_url | date_range | none`. The
cursor is **opaque to the pipeline**: it is handed straight back to the adapter
on resume and persisted verbatim in `migration_checkpoints`, so an adapter can
change its cursor representation without touching the platform.

## Permission preflight (Guide §9.2)

`testConnection()` returns per-resource access:

```ts
{
  ok: true,
  resourceAccess: [
    { entity: 'contact', accessible: true },
    { entity: 'document', accessible: false,
      reason: "The connected credential's access profile does not grant read access to document." },
  ],
}
```

The wizard renders this as *Contacts OK / Jobs OK / Files — permission missing*
before the migration starts. Naming the missing permission is the point: "failed"
is not actionable.

## Writing a new adapter

1. **Verify first.** Guide §24: confirm the current endpoint version, scopes,
   pagination method, rate limits and object coverage against live vendor
   documentation. Each planned connector's checklist is in
   `src/adapters/planned.ts`.
2. **Pin those assumptions in contract tests** before writing extraction code.
3. Declare capabilities, rate limits and pagination strategy.
4. Implement `authenticate`, `testConnection` (with per-resource access),
   `discover` (read-only — Guide §7.3), `extract` and `normalize`.
5. Add `getChanges` if the source supports a watermark, `downloadFile` if it
   serves assets.
6. Register in `src/adapters/registry.ts`.
7. Test against the same suite the mock adapter passes.

`src/adapters/mock/index.ts` is the reference implementation — it paginates,
throttles, throws the standard error taxonomy, and supports injectable failures.

## The rule

Source field names appear in `extract()` and `normalize()`. Nowhere else. If
platform-specific logic is leaking past the adapter boundary, the platform is
being built wrong — and Scope §88 is explicit that this is the decision that
determines whether it survives growing from five sources to twenty-five.
