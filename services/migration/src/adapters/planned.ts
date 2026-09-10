import type { EntityType } from '../domain/entities.js';
import { MigrationError } from '../domain/errors.js';
import type { SourcePlatform } from '../canonical/common.js';
import {
  DEFAULT_RATE_LIMIT,
  type AdapterContext, type ConnectionTestResult, type DiscoveryResult, type ExtractOptions,
  type ExtractPage, type PaginationStrategy, type RateLimitProfile, type SourceAdapter,
  type SourceCapabilities,
} from './types.js';

/**
 * Capability declarations for the five launch connectors (Scope §7, §65).
 *
 * These are real, in the sense that matters right now: the wizard, preflight
 * and reconciliation all read the capability registry, so declaring AccuLynx's
 * multi-location credentials or JobNimbus's permission-dependent file access
 * changes system behaviour today, before a single vendor call is written.
 *
 * Extraction is intentionally not implemented. Both source documents are
 * explicit about this ordering -- Guide §25: "For the first implementation
 * sprint, do not attempt a real vendor migration"; Guide §24: "vendor APIs
 * change... confirm the current endpoint version, scopes, pagination method,
 * rate limits, and object coverage in the official documentation and lock those
 * assumptions into connector contract tests."
 *
 * Guessing endpoint shapes from memory would produce code that looks finished
 * and fails on first contact. Each adapter below instead records what must be
 * verified, and fails loudly with that list if called.
 */

export interface PlannedAdapterSpec {
  platform: SourcePlatform;
  connectorVersion: string;
  capabilities: SourceCapabilities;
  rateLimit: RateLimitProfile;
  paginationStrategy: PaginationStrategy;
  authKind: 'oauth2' | 'api_key' | 'hybrid' | 'file_upload';
  /**
   * Facts established from public vendor documentation. These are the
   * assumptions to pin in connector contract tests (Guide §24), so that a
   * vendor changing them fails a test rather than a customer's migration.
   */
  confirmed?: readonly string[];
  /** Guide §24: what must still be confirmed, and how. */
  verificationChecklist: readonly string[];
  /** Docs to confirm against. Named, not linked, because URLs rot. */
  documentation: readonly string[];
  /** Scope §7 notes that shape the connector's design. */
  designNotes: readonly string[];
}

const cap = (
  entities: Partial<Record<EntityType, true | false | 'conditional'>>,
  rest: Omit<SourceCapabilities, 'entities'>,
): SourceCapabilities => Object.freeze({ entities: Object.freeze(entities), ...rest });

// ---------------------------------------------------------------------------
// GoHighLevel (Scope §7.1, Guide §7) - first production connector
// ---------------------------------------------------------------------------
export const HIGHLEVEL_SPEC: PlannedAdapterSpec = {
  platform: 'highlevel',
  connectorVersion: 'highlevel-v0.1.0-planned',
  authKind: 'oauth2',
  paginationStrategy: 'cursor',
  rateLimit: { ...DEFAULT_RATE_LIMIT, requestsPerSecond: 5, requestsPerMinute: 100, pageSize: 100, concurrency: 2 },
  capabilities: cap(
    {
      account: true, location: true, user: true, custom_field: true, tag: true,
      pipeline: true, pipeline_stage: true, contact: true, opportunity: true,
      note: true, task: true, appointment: true,
      document: 'conditional', image: 'conditional',
      job: false, company: false, lead: false, team: false, status_definition: false,
      activity: 'conditional', attachment: 'conditional',
    },
    {
      delta_sync: true,
      webhooks: true,
      historical_api_access: true,
      self_service_auth: true,
      file_export_import: false,
      notes: {
        auth: 'Use BuilderLync\'s own OAuth application rather than asking customers to mint permanent tokens (Scope §7.1).',
        files: 'Media access depends on the granted scopes and the customer\'s plan; declared conditional until preflight confirms.',
        jobs: 'HighLevel has no native job/project object. Opportunities map to BuilderLync opportunities, not jobs.',
      },
    },
  ),
  confirmed: [
    'Rate limits are published: 100 requests per 10 seconds (burst) and 200,000 requests per day.',
    'Limits are counted per Marketplace app (client) per resource, where a resource is a single Location (sub-account) or Company (agency) -- so a multi-location customer gets proportionally more budget, and the limiter must be keyed per location.',
    'Usage is reported via X-RateLimit-Limit-Daily, X-RateLimit-Daily-Remaining, X-RateLimit-Interval-Milliseconds, X-RateLimit-Max and X-RateLimit-Remaining.',
    'Contacts pagination returns 20 by default, maximum 100 per request, using startAfter and startAfterId.',
    'Read scopes are named exactly: contacts.readonly, opportunities.readonly, locations.readonly, locations/customFields.readonly, locations/customValues.readonly, locations/tags.readonly, users.readonly, calendars.readonly, calendars/events.readonly, calendars/groups.readonly, calendars/resources.readonly, medias.readonly.',
    'There are NO separate readonly scopes for pipelines, notes or tasks -- access to those is bundled under contacts.readonly. Requesting a non-existent scope fails authorization, so the scope list must not invent them.',
  ],
  verificationChecklist: [
    'Confirm the current API base URL and version path; the developer glossary references v3 without stating a base URL.',
    'Confirm token lifetime and refresh semantics, including whether refreshing rotates the refresh token -- this determines whether a long migration can outlive its own credentials.',
    'Confirm the pagination shape per endpoint; it is documented for contacts but is not uniform across resources.',
    'Confirm the HTTP status and body returned when throttled, since the documentation states the limits but not the rejection shape.',
    'Confirm whether media/files are retrievable for the plans BuilderLync customers actually hold (medias.readonly exists, but plan gating is not documented).',
    'Confirm contact duplicate-handling behaviour on write, so BuilderLync dedupe stays authoritative (Guide §7.6).',
  ],
  documentation: [
    'HighLevel - API Developer Portal',
    'HighLevel - API Introduction',
    'HighLevel - Authorization / OAuth Guidance',
    'HighLevel - Contacts API',
    'HighLevel - Opportunities API',
  ],
  designNotes: [
    'Extraction order (Guide §7.4): users -> pipelines/stages -> contacts -> opportunities -> notes/tasks -> files.',
    'Discovery must not write to BuilderLync CRM tables (Guide §7.3).',
    'Store access and refresh tokens through the secrets layer, never in customer-visible data (Guide §7.2).',
  ],
};

// ---------------------------------------------------------------------------
// AccuLynx (Scope §7.2, Guide §8)
// ---------------------------------------------------------------------------
export const ACCULYNX_SPEC: PlannedAdapterSpec = {
  platform: 'acculynx',
  connectorVersion: 'acculynx-v0.1.0-planned',
  authKind: 'api_key',
  paginationStrategy: 'page',
  rateLimit: { ...DEFAULT_RATE_LIMIT, requestsPerSecond: 3, requestsPerMinute: 60, pageSize: 50, concurrency: 1 },
  capabilities: cap(
    {
      account: true, location: true, user: true, contact: true, job: true,
      job_assignment: true, contact_job_relationship: true, status_definition: true,
      note: true, activity: true, tag: 'conditional', custom_field: 'conditional',
      document: true, image: 'conditional',
      opportunity: false, pipeline: false, pipeline_stage: false, lead: false,
      company: 'conditional', task: 'conditional', appointment: 'conditional',
    },
    {
      delta_sync: 'conditional',
      webhooks: 'conditional',
      historical_api_access: true,
      self_service_auth: true,
      file_export_import: false,
      notes: {
        multi_location:
          'A company may hold several AccuLynx locations, each with its own API credential. The migration must accept multiple credentials and merge their output into one canonical stream (Scope §7.2).',
        stages:
          'AccuLynx milestones are not BuilderLync stages. Never copy foreign status ids; map to existing stages or create customer-approved ones (Guide §8.5).',
        financial: 'Financial metadata availability varies by account; treat as conditional until preflight.',
      },
    },
  ),
  confirmed: [
    'Public API reference exists at apidocs.acculynx.com, with a machine-readable index at apidocs.acculynx.com/llms.txt.',
    'Authentication is an API key created by a Location or Company Administrator in AccuLynx Account Settings.',
    'Keys are scoped PER LOCATION, and the docs state each integration should have its own key -- confirming Scope §7.2: a multi-location company supplies several credentials that must merge into one canonical stream.',
    'Pagination uses pageStartIndex (or StartIndex), zero-based, plus pageSize. Defaults vary by endpoint, typically 25-100, with a maximum often 50 -- so page size must be per-endpoint, not global.',
    'Rate limiting applies to write operations and is reported via RateLimit-* response headers. Numeric limits are not published, so the limiter must read the headers rather than assume a fixed rate.',
    'Documented resources cover contacts (emails, phones, notes, custom fields, logs, job associations), jobs (estimates, invoices, financials, payments, milestones, representatives, photos/videos, measurements, addresses, custom fields, trade types, work types, categories, lead sources, insurance, appointments), leads, users, documents, milestones and statuses, payments, invoices.',
    'Job contacts are exposed as job associations on the contact resource, so the job-to-contact relationship is retrievable directly rather than needing inference.',
    'Webhooks exist under /webhooks/v2/ with 30+ documented topics, giving a real delta path.',
  ],
  verificationChecklist: [
    'Confirm the API base hostname and the exact header the API key is sent in (name, and whether a Bearer prefix is used) -- the public docs describe key creation but not transmission. Requires a live key.',
    'Confirm the numeric rate limits by reading RateLimit-* headers from a real response, since they are not published.',
    'Confirm the exact per-endpoint pageSize maximums rather than assuming the documented typical range.',
    'Confirm the milestone/status value vocabulary in a real account -- these are customer-configurable and must be mapped, never copied as foreign ids (Guide §8.5).',
    'Confirm whether document download URLs are signed and expiring, which determines whether the asset pipeline must fetch within a time window.',
    'Confirm whether any updated-since filter exists on list endpoints. If not, delta sync must rely on webhooks plus a reconciliation scan.',
  ],
  documentation: [
    'AccuLynx API docs: https://apidocs.acculynx.com',
    'AccuLynx machine-readable doc index: https://apidocs.acculynx.com/llms.txt',
    'AccuLynx - Getting Started, Authentication, Endpoints, Webhooks End User Reference',
  ],
  designNotes: [
    'FIRST CONNECTOR TO BUILD. Working AccuLynx migration scripts already exist in-house and have run against real client accounts.',
    'Read those scripts before writing anything. What to extract from them, in priority order: (1) the exact AccuLynx field names used per object, (2) the milestone/status value vocabulary observed in real accounts, (3) how multi-location credentials are handled, (4) pagination parameters and any rate limits hit in practice, (5) every edge case the script special-cases -- each one is a bug found the hard way.',
    'Port that knowledge into normalize(), not into the platform. The scripts predate the canonical schema, so their output shape will not match; the mappings they encode are the valuable part, not their structure.',
    'Connection preflight must identify the company/location and record which endpoints answered (Guide §8.2).',
    'Documents download in bounded batches with MIME/size validation and hashing before upload (Guide §8.6).',
    'Throttle and back off explicitly; do not rely on n8n\'s automatic retry (Guide §8.4).',
  ],
};

// ---------------------------------------------------------------------------
// JobNimbus (Scope §7.3, Guide §9)
// ---------------------------------------------------------------------------
export const JOBNIMBUS_SPEC: PlannedAdapterSpec = {
  platform: 'jobnimbus',
  connectorVersion: 'jobnimbus-v0.1.0-planned',
  authKind: 'api_key',
  paginationStrategy: 'offset',
  rateLimit: { ...DEFAULT_RATE_LIMIT, requestsPerSecond: 4, requestsPerMinute: 90, pageSize: 100, concurrency: 2 },
  capabilities: cap(
    {
      user: true, contact: true, job: true, lead: 'conditional', activity: true,
      note: true, task: true, status_definition: true, custom_field: true, tag: true,
      contact_job_relationship: true, job_assignment: true,
      attachment: 'conditional', document: 'conditional', image: 'conditional',
      account: true, location: false, company: false,
      opportunity: false, pipeline: false, pipeline_stage: false,
      team: false, appointment: 'conditional',
    },
    {
      delta_sync: 'conditional',
      webhooks: 'conditional',
      historical_api_access: true,
      self_service_auth: true,
      file_export_import: true,
      notes: {
        permissions:
          'API keys inherit the permissions of their access profile. Every object is conditional until preflight proves the specific key can read it (Scope §7.3, Guide §9.1-9.2).',
        history:
          'Historical notes and activities must retain their original timestamps and authors; they must not be rewritten as newly created activity (Guide §9.4).',
        fallback: 'Objects the API cannot reach fall back to an export-assisted path (Scope §7.3).',
      },
    },
  ),
  confirmed: [
    'REST base URL is https://app.jobnimbus.com/api1/.',
    'Authentication is an API key sent as a Bearer token in the Authorization header.',
    'Pagination is offset-based: size (number of elements, default 1000) and from (zero-based start, default 0).',
    'Documented endpoints include /contacts, /jobs, /tasks, /estimates and /invoices.',
    'Both /contacts and /jobs return everything the API key\'s Access Profile permits -- confirming Guide §9.1: the key inherits its profile\'s permissions, so a permission preflight is required rather than optional.',
  ],
  verificationChecklist: [
    'Rate limits are NOT published. Measure them against a live key and start conservatively; the adapter must not assume the default profile is safe.',
    'Confirm which endpoint (if any) reveals the API key\'s effective permissions, so preflight can report per-object access without probing each resource destructively.',
    'Confirm attachment/file listing and download support, and which access profile grants it -- file access is the most commonly missing permission.',
    'Confirm whether records expose a reliable updated-at, which decides whether delta sync is real or a full reconciliation scan.',
    'Confirm the custom-field representation and whether field ids or names are stable over time.',
    'The only reference documentation is a Postman collection, so treat every field mapping as unverified until exercised against a real account.',
  ],
  documentation: [
    'JobNimbus Public API (Postman collection) - the only reference documentation available',
    'JobNimbus - Platform API Authorization',
  ],
  designNotes: [
    'Preflight must probe every required resource and return a per-object result, e.g. "Contacts OK / Files - permission missing" (Guide §9.2).',
    'Extraction order (Guide §9.3): users/configuration -> contacts -> jobs -> activities/notes -> custom fields/tags -> attachments.',
  ],
};

// ---------------------------------------------------------------------------
// ProLine (Scope §7.4, Guide §10) - hybrid
// ---------------------------------------------------------------------------
export const PROLINE_SPEC: PlannedAdapterSpec = {
  platform: 'proline',
  connectorVersion: 'proline-v0.1.0-planned',
  authKind: 'hybrid',
  paginationStrategy: 'cursor',
  rateLimit: { ...DEFAULT_RATE_LIMIT, requestsPerSecond: 2, requestsPerMinute: 60, pageSize: 50, concurrency: 1 },
  capabilities: cap(
    {
      user: 'conditional', contact: 'conditional', job: 'conditional',
      pipeline_stage: 'conditional', tag: 'conditional', note: 'conditional',
      activity: 'conditional', document: 'conditional', image: 'conditional',
      account: 'conditional', team: 'conditional', appointment: 'conditional',
      opportunity: false, company: false, lead: false, custom_field: 'conditional',
    },
    {
      delta_sync: 'conditional',
      webhooks: true,
      historical_api_access: 'conditional',
      self_service_auth: true,
      file_export_import: true,
      notes: {
        hybrid:
          'Treated as hybrid until direct historical extraction coverage is confirmed for every required object (Guide §10).',
        webhooks:
          'ProLine documents that outbound webhooks do not guarantee delivery or retries. Delta reconciliation must therefore include polling or a final reconciliation scan -- webhooks alone cannot be the correctness guarantee (Guide §10.5, Scope §52).',
        historical:
          'Do not design the historical importer around outbound webhooks (Guide §10.3).',
      },
    },
  ),
  confirmed: [
    'An API key exists and is copyable from the ProLine settings UI, so customer self-service authentication is viable.',
    'Webhooks and a Zapier integration exist, giving a change-capture path.',
    'NO public REST API reference documentation could be found. ProLine publishes end-user integration guides, not a developer API reference.',
  ],
  verificationChecklist: [
    'BLOCKED: without public API documentation, a historical extractor cannot be designed. Either obtain developer documentation from ProLine directly, or determine whether the Zapier integration exposes enough read surface to drive a bulk extraction.',
    'If neither path yields bulk read access, ProLine becomes export-assisted like Roofr, and needs real sample exports before any work starts.',
    'Confirm the webhook event catalogue and whether a vendor event id is present -- the inbox already dedupes on a payload hash where one is absent, but an event id is far cheaper.',
    'Confirm retry/delivery semantics for webhooks (documented as not guaranteed) to size the reconciliation scan.',
  ],
  documentation: ['ProLine - Zapier / API Key Integration', 'ProLine - Webhooks', 'ProLine - Integrations Collection'],
  designNotes: [
    'Webhook path: endpoint -> immutable event inbox -> deduplication -> queue -> processor (Guide §10.4, Scope §52).',
    'Expect duplicate and missed events; the inbox dedupes on vendor event id, falling back to a payload hash.',
  ],
};

// ---------------------------------------------------------------------------
// Roofr (Scope §7.5, Guide §11) - export-assisted first
// ---------------------------------------------------------------------------
export const ROOFR_SPEC: PlannedAdapterSpec = {
  platform: 'roofr',
  connectorVersion: 'roofr-v0.1.0-planned',
  authKind: 'file_upload',
  paginationStrategy: 'none',
  rateLimit: { ...DEFAULT_RATE_LIMIT, requestsPerSecond: 10, requestsPerMinute: 600, pageSize: 500, concurrency: 2 },
  capabilities: cap(
    {
      contact: true, job: true, user: 'conditional', status_definition: 'conditional',
      tag: 'conditional', custom_field: 'conditional',
      document: 'conditional', image: 'conditional',
      opportunity: false, pipeline: false, pipeline_stage: false,
      note: 'conditional', activity: false, company: false, lead: false,
    },
    {
      delta_sync: false,
      webhooks: false,
      historical_api_access: 'conditional',
      self_service_auth: false,
      file_export_import: true,
      notes: {
        approach:
          'Export-assisted unless BuilderLync obtains documented API or partner extraction access covering the required objects (Scope §7.5).',
        formats:
          'Accept CSV, XLSX and ZIP, including separate contacts and jobs exports and separate file/photo archives. Auto-detect known Roofr export layouts.',
        upload:
          'Uploads arrive through BuilderLync, never through an unprotected n8n webhook (Guide §11.1).',
        delta:
          'Export-based migration has no watermark, so timestamp-based delta sync is unavailable until API access exists. A second pass is still possible by re-uploading a fresh export: unchanged rows match on content hash and are skipped, so only genuinely new or edited records are written.',
      },
    },
  ),
  confirmed: [
    'Roofr supports exporting contacts, proposals and measurement reports as CSV.',
    'No public API reference documentation could be found; export is the documented migration path.',
  ],
  verificationChecklist: [
    'BLOCKED: obtain real sample exports of each type. Column headers, export variants and how photo archives reference their parent job cannot be inferred from documentation, and guessing them produces a parser that fails on the first real client file.',
    'Add the sanitized samples to test/fixtures as contract tests, so a Roofr export-format change fails a test rather than a customer migration.',
    'Determine a deterministic asset-correlation rule: source id, job number, directory structure, or manifest (Guide §11.5).',
    'Confirm whether exports carry a stable record id; if not, a migration-scoped synthetic id is required and its delta limitations documented (Guide §12.4).',
  ],
  documentation: ['Roofr - Data Migration Outline'],
  designNotes: [
    'Reuses the generic file-ingestion components; Roofr export records become the same canonical objects as API adapters (Guide §11.6, §12).',
    'Mapping preview must show source field -> BuilderLync field, sample values, unmapped fields and validation errors before import (Guide §11.4).',
    'SECOND CONNECTOR, AND BLOCKED. Roofr is migrated by hand today, so automating it removes real recurring effort -- but no existing tooling covers it, so there is no reference mapping to start from.',
    'BLOCKER: real sample Roofr exports are required before any parser can be written. Column headers, export variants and how file/photo archives reference their parent job cannot be inferred from documentation, and guessing them produces a parser that fails on the first real client file. Obtain sanitized exports of each type (contacts, jobs, and any file/photo archive) and add them to test/fixtures as contract tests.',
    'Export-based sources have no updated-at watermark, so the two-pass model (historical, then final delta before go-live) must be driven by re-uploading a fresh export and relying on content hashing to skip unchanged rows -- not by a timestamp filter.',
  ],
};

/**
 * Build order.
 *
 * Set from what is actually verifiable from public vendor documentation, since
 * no reference implementation and no vendor SME are available. Researched
 * September 2026; see each spec's `documentation` and `confirmed` fields.
 *
 *   1. AccuLynx   Best-documented for this use case by a wide margin. Public
 *                 docs cover contacts (with emails, phones, notes, custom
 *                 fields, logs and job associations), jobs (with milestones,
 *                 photos/videos, custom fields, trade and work types, lead
 *                 sources), leads, users, documents, payments, invoices and
 *                 30+ webhook topics. Pagination and rate-limit headers are
 *                 documented. It also maps most directly onto the contractor
 *                 model BuilderLync needs: jobs, milestones, job-to-contact
 *                 relationships and documents.
 *   2. JobNimbus  Simple and unambiguous: one base URL, bearer key, offset
 *                 pagination. Docs are a Postman collection rather than a
 *                 reference site, and rate limits are unpublished, so more
 *                 must be discovered against a live key.
 *   3. HighLevel  Scopes and rate limits are published precisely, which makes
 *                 it the right place to prove the full API-first path (OAuth,
 *                 webhooks, timestamp delta sync). Ranked third only because
 *                 it has no native job/project object, so it delivers less of
 *                 the contractor data model than the two above.
 *   4. Roofr      Export-assisted. BLOCKED: needs real sample exports.
 *   5. ProLine    BLOCKED: no public REST API documentation exists.
 *
 * Guide §21 ranks HighLevel first for having the most modern API. That ranks
 * connectors by API pleasantness rather than by delivered coverage; on the
 * evidence above, AccuLynx returns more of what BuilderLync actually stores.
 */
export const PLANNED_SPECS: readonly PlannedAdapterSpec[] = Object.freeze([
  ACCULYNX_SPEC, JOBNIMBUS_SPEC, HIGHLEVEL_SPEC, ROOFR_SPEC, PROLINE_SPEC,
]);

/**
 * An adapter that carries a real capability registry but has no extraction
 * implementation yet.
 *
 * It participates fully in capability queries, discovery-time suppression and
 * the wizard, and it fails with an actionable message -- naming what must be
 * verified -- if anything tries to pull data through it.
 */
export class PlannedAdapter implements SourceAdapter {
  readonly platform: SourcePlatform;
  readonly connectorVersion: string;
  readonly capabilities: SourceCapabilities;
  readonly rateLimit: RateLimitProfile;
  readonly paginationStrategy: PaginationStrategy;
  readonly spec: PlannedAdapterSpec;

  constructor(spec: PlannedAdapterSpec) {
    this.spec = spec;
    this.platform = spec.platform;
    this.connectorVersion = spec.connectorVersion;
    this.capabilities = spec.capabilities;
    this.rateLimit = spec.rateLimit;
    this.paginationStrategy = spec.paginationStrategy;
  }

  private notImplemented(operation: string): MigrationError {
    return new MigrationError(
      'UNSUPPORTED_FIELD',
      `The ${this.platform} connector is specified but not yet implemented (${operation}). ` +
        (this.spec.confirmed?.length
          ? `Already established from public documentation: ${this.spec.confirmed.join(' ')} `
          : '') +
        `Still to confirm before implementing: ` +
        this.spec.verificationChecklist.map((c, i) => `(${i + 1}) ${c}`).join(' ') +
        ` Reference docs: ${this.spec.documentation.join('; ')}.`,
      { raw: { platform: this.platform, operation, checklist: this.spec.verificationChecklist } },
      { retryable: false },
    );
  }

  async authenticate(): Promise<void> {
    throw this.notImplemented('authenticate');
  }

  async testConnection(): Promise<ConnectionTestResult> {
    return {
      ok: false,
      message:
        `The ${this.platform} connector is not yet implemented. Its capabilities are declared and the migration ` +
        `platform is ready for it; extraction is pending vendor API verification.`,
      resourceAccess: [],
    };
  }

  async discover(): Promise<DiscoveryResult> {
    throw this.notImplemented('discover');
  }

  async extract(entity: EntityType, _c: AdapterContext, _o?: ExtractOptions): Promise<ExtractPage> {
    throw this.notImplemented(`extract(${entity})`);
  }

  normalize(entity: EntityType): Record<string, unknown> {
    throw this.notImplemented(`normalize(${entity})`);
  }

  transformerVersion(entity: EntityType): string {
    return `${this.platform}-${entity}-v0.1.0-planned`;
  }
}
