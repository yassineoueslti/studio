import type { EntityType } from '../domain/entities.js';
import type { SourcePlatform } from '../canonical/common.js';

/**
 * The source adapter contract (Guide §6, Scope §6).
 *
 * Every CRM implements this same interface and returns canonical objects.
 * Scope §88 is the rule this enforces: source-specific logic lives here and
 * nowhere else, so the migration platform never grows a `if (platform ===
 * 'jobnimbus')` branch.
 */

// ---------------------------------------------------------------------------
// Capability registry (Guide §6, Scope §65)
// ---------------------------------------------------------------------------

/**
 * 'conditional' is the important value. Several sources expose files only for
 * certain plans or API scopes (Scope §7.3/§7.4). Declaring that up front lets
 * the wizard warn before a migration, instead of failing at 80% through the
 * asset phase.
 */
export type CapabilityLevel = true | false | 'conditional';

export interface SourceCapabilities {
  /** Per-entity extraction support. */
  readonly entities: Readonly<Partial<Record<EntityType, CapabilityLevel>>>;
  /** Scope §51: can this source report changes since a watermark? */
  readonly delta_sync: CapabilityLevel;
  /** Scope §52: does the vendor emit webhooks we can subscribe to? */
  readonly webhooks: CapabilityLevel;
  /** Does the source expose historical records over its API at all? */
  readonly historical_api_access: CapabilityLevel;
  /** Can a customer self-serve authentication (Scope §82 gate)? */
  readonly self_service_auth: CapabilityLevel;
  /** Export/file upload path in addition to, or instead of, the API. */
  readonly file_export_import: CapabilityLevel;
  /** Free-text caveats surfaced in the wizard and the migration report. */
  readonly notes: Readonly<Partial<Record<string, string>>>;
}

export function supports(capabilities: SourceCapabilities, entity: EntityType): boolean {
  return capabilities.entities[entity] === true || capabilities.entities[entity] === 'conditional';
}

export function isConditional(capabilities: SourceCapabilities, entity: EntityType): boolean {
  return capabilities.entities[entity] === 'conditional';
}

export function supportedEntities(capabilities: SourceCapabilities): EntityType[] {
  return (Object.keys(capabilities.entities) as EntityType[]).filter((e) => supports(capabilities, e));
}

// ---------------------------------------------------------------------------
// Rate limits and pagination (Scope §25-26)
// ---------------------------------------------------------------------------

export interface RateLimitProfile {
  readonly requestsPerSecond: number;
  readonly requestsPerMinute: number;
  readonly pageSize: number;
  readonly concurrency: number;
  readonly retryAttempts: number;
  readonly retryDelayMs: number;
  readonly backoffMultiplier: number;
  /** Upper bound on any single backoff wait, so a migration cannot stall forever. */
  readonly maxRetryDelayMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitProfile = Object.freeze({
  requestsPerSecond: 5,
  requestsPerMinute: 120,
  pageSize: 100,
  concurrency: 2,
  retryAttempts: 5,
  retryDelayMs: 1_000,
  backoffMultiplier: 2,
  maxRetryDelayMs: 60_000,
});

/** Scope §26: the adapter declares which pagination shape it uses. */
export type PaginationStrategy = 'page' | 'offset' | 'cursor' | 'next_url' | 'date_range' | 'none';

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * One page of source records. `cursor` is opaque to the pipeline -- it is
 * handed straight back to the adapter on resume, and persisted verbatim in
 * migration_checkpoints (Scope §27).
 */
export interface ExtractPage<T = unknown> {
  records: T[];
  cursor: unknown | null;
  hasMore: boolean;
  /** Total available, when the source reports one. Used for progress display. */
  totalEstimate?: number | null;
}

export interface ExtractOptions {
  cursor?: unknown | null;
  pageSize?: number;
  /** Delta sync (Scope §50): only records changed since this instant. */
  updatedSince?: Date | null;
  signal?: AbortSignal;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Human-readable, safe to show a customer. Never contains a credential. */
  message: string;
  sourceTenantId?: string | null;
  sourceAccountName?: string | null;
  /**
   * Guide §9.2: per-resource permission preflight. The wizard renders this as
   * "Contacts OK / Jobs OK / Files - permission missing" *before* the migration
   * starts rather than discovering it at 60% completion.
   */
  resourceAccess?: Array<{
    entity: EntityType;
    accessible: boolean;
    reason?: string;
  }>;
}

export interface DiscoveryResult {
  counts: Array<{
    entity: EntityType;
    count: number;
    supported: boolean;
    note?: string;
  }>;
  sourceTenantId?: string | null;
  sourceAccountName?: string | null;
  totalEstimatedObjects: number;
}

/** Credentials, already decrypted by the secrets layer. Never logged. */
export interface AdapterCredentials {
  type: 'api_key' | 'oauth2' | 'basic' | 'file_upload' | 'none';
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date | null;
  username?: string;
  password?: string;
  /** Source-specific extras, e.g. AccuLynx location id, GHL location id. */
  metadata?: Record<string, string>;
}

export interface AdapterContext {
  migrationId: string;
  tenantId: string;
  sourceTenantId: string | null;
  credentials: AdapterCredentials;
  /** Per-migration overrides, e.g. a reduced page size for a fragile account. */
  options?: Record<string, unknown>;
}

/**
 * Adapters yield *raw* source records from get*(), then convert them in
 * normalize(). Keeping the two separate is what lets the platform retain raw
 * payloads for troubleshooting (Scope §30) and re-run a transformation with a
 * newer transformer version without re-querying the vendor (Scope §31).
 */
export interface SourceAdapter {
  readonly platform: SourcePlatform;
  readonly connectorVersion: string;
  readonly capabilities: SourceCapabilities;
  readonly rateLimit: RateLimitProfile;
  readonly paginationStrategy: PaginationStrategy;

  authenticate(context: AdapterContext): Promise<void>;
  testConnection(context: AdapterContext): Promise<ConnectionTestResult>;
  discover(context: AdapterContext): Promise<DiscoveryResult>;

  /**
   * Single generic extraction entry point. A per-entity method set
   * (getContacts, getJobs, ...) is provided by `entityMethods` below for
   * readability, but the pipeline drives extraction through this one function
   * so adding an entity does not mean touching the orchestrator.
   */
  extract(entity: EntityType, context: AdapterContext, options?: ExtractOptions): Promise<ExtractPage>;

  /** Raw source record -> canonical object. Pure; no I/O. */
  normalize(entity: EntityType, raw: unknown, context: AdapterContext): Record<string, unknown>;

  /** Scope §31: e.g. "jobnimbus-contact-v1.4.2". */
  transformerVersion(entity: EntityType): string;

  /** Scope §51: changes since a watermark, for sources that support delta. */
  getChanges?(entity: EntityType, context: AdapterContext, since: Date, options?: ExtractOptions): Promise<ExtractPage>;

  /** Fetch one asset's bytes. Separate from metadata extraction (Guide §14.1). */
  downloadFile?(context: AdapterContext, file: { sourceId: string; url: string | null }): Promise<{
    content: Buffer;
    mimeType: string | null;
    fileName: string | null;
  }>;

  disconnect?(context: AdapterContext): Promise<void>;
}

/**
 * Convenience accessors matching the method names in Guide §6. They delegate to
 * extract() so there is exactly one extraction implementation per adapter.
 */
export const entityMethods = {
  getUsers: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('user', c, o),
  getContacts: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('contact', c, o),
  getTags: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('tag', c, o),
  getPipelines: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('pipeline', c, o),
  getOpportunities: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('opportunity', c, o),
  getJobs: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('job', c, o),
  getNotes: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('note', c, o),
  getActivities: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('activity', c, o),
  getFiles: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('document', c, o),
  getImages: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('image', c, o),
  getCustomFields: (a: SourceAdapter, c: AdapterContext, o?: ExtractOptions) => a.extract('custom_field', c, o),
} as const;

/** Thrown by an adapter asked for something it declared unsupported. */
export class UnsupportedEntityError extends Error {
  constructor(platform: string, entity: EntityType) {
    super(`Adapter "${platform}" does not support entity "${entity}". Check its capability registry before extracting.`);
    this.name = 'UnsupportedEntityError';
  }
}
