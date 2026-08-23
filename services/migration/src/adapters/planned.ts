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
  /** Guide §24: what must be confirmed against live docs before coding. */
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
  verificationChecklist: [
    'Confirm the current API version and base URL, and whether the legacy v1 API is still available to new apps.',
    'Enumerate the minimum OAuth scopes for: locations, users, contacts, custom fields, tags, opportunities, pipelines, notes, tasks.',
    'Confirm the pagination shape per endpoint (cursor vs page vs startAfter) - it is not uniform across resources.',
    'Confirm published rate limits per app and per location, plus burst behaviour.',
    'Confirm token lifetime and refresh semantics, including whether refresh rotates the refresh token.',
    'Confirm whether media/files are retrievable via API for the plans BuilderLync customers hold.',
    'Confirm the contact duplicate-handling behaviour on write, so BuilderLync dedupe stays authoritative (Guide §7.6).',
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
  verificationChecklist: [
    'Confirm the API key model: per-company or per-location, and how many keys a multi-location customer must supply.',
    'Confirm published rate limits and whether they are per key or per company.',
    'Confirm the pagination contract (page/pageSize vs skip/take) and the maximum page size.',
    'Confirm which job milestone/status fields are exposed and their exact value vocabulary.',
    'Confirm the document endpoint: listing, metadata, and whether download URLs are signed and expiring.',
    'Confirm whether job contacts are a distinct resource from contacts, and how the relationship is expressed.',
    'Confirm whether any updated-since filter exists, which decides if delta sync is real or reconciliation-scan only.',
  ],
  documentation: ['AccuLynx - Getting Started', 'AccuLynx - API Integrations for Developers'],
  designNotes: [
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
  verificationChecklist: [
    'Confirm the current authorization scheme and header format for platform API keys.',
    'Confirm how access profiles map to readable resources, and which endpoint reveals the key\'s effective permissions.',
    'Confirm the pagination contract (size/from) and maximum page size per resource.',
    'Confirm published rate limits and the throttling response shape.',
    'Confirm attachment/file listing and download support, and which access profile grants it.',
    'Confirm whether records expose a reliable updated-at for delta sync.',
    'Confirm the custom-field representation and whether field ids or names are stable across time.',
  ],
  documentation: ['JobNimbus - Platform API Authorization'],
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
  verificationChecklist: [
    'Locate the API key under Integrations / ProLine API and confirm its scope.',
    'Inventory which of contacts, projects, team members, events, quotes, invoices and files are reliably retrievable, against a real account.',
    'Confirm whether a search/read endpoint supports historical bulk extraction, or whether an export is required.',
    'Confirm the webhook event catalogue, payload shape, and whether a vendor event id is present for deduplication.',
    'Confirm retry/delivery semantics for webhooks (documented as not guaranteed) to size the reconciliation scan.',
    'Confirm file access and whether download URLs are signed and expiring.',
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
  verificationChecklist: [
    'Confirm which export formats Roofr currently produces and their exact column headers, per export type.',
    'Confirm whether file and photo archives can be exported, and how assets reference their parent job.',
    'Confirm whether any API or partner extraction access is available, and which objects it covers.',
    'Determine a deterministic asset-correlation rule: source id, job number, directory structure, or manifest (Guide §11.5).',
    'Confirm whether exports carry a stable record id; if not, a migration-scoped synthetic id is required (Guide §12.4).',
  ],
  documentation: ['Roofr - Data Migration Outline'],
  designNotes: [
    'Reuses the generic file-ingestion components; Roofr export records become the same canonical objects as API adapters (Guide §11.6, §12).',
    'Mapping preview must show source field -> BuilderLync field, sample values, unmapped fields and validation errors before import (Guide §11.4).',
    'FIRST CONNECTOR TO BUILD. Roofr is the source in active use for live client migrations, so working extraction here removes real onboarding effort immediately.',
    'Existing migration scripts already move Roofr job data for onboarding. Review those before writing anything: they encode field mappings and quirks discovered against real client exports, which is knowledge no amount of documentation reading reproduces.',
    'Export-based sources have no updated-at watermark, so the two-pass model (historical, then final delta before go-live) must be driven by re-uploading a fresh export and relying on content hashing to skip unchanged rows -- not by a timestamp filter.',
  ],
};

/**
 * Build order.
 *
 * Guide §21 puts HighLevel first, on the reasoning that it has the most modern
 * API surface. Current delivery reality overrides that: Roofr is the source
 * actively being migrated for live clients, so it is the connector whose
 * absence costs onboarding time today. HighLevel remains the better *second*
 * connector for exactly the reason the guide gives -- OAuth, webhooks and delta
 * sync make it the right place to prove the API-first path.
 */
export const PLANNED_SPECS: readonly PlannedAdapterSpec[] = Object.freeze([
  ROOFR_SPEC, HIGHLEVEL_SPEC, ACCULYNX_SPEC, JOBNIMBUS_SPEC, PROLINE_SPEC,
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
        `Before implementing it, confirm against current vendor documentation: ` +
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
