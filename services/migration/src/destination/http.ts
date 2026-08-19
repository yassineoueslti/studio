import { config } from '../config.js';
import type { EntityType } from '../domain/entities.js';
import { MigrationError, toMigrationError } from '../domain/errors.js';
import type {
  BatchRequest, BatchResponse, ContactCandidate, ContactLookupCriteria, DestinationClient,
  DestinationCounts, FileUploadRequest, FileUploadResult, RelationshipIntegrityReport,
} from './types.js';

/**
 * HTTP destination driver: calls the real BuilderLync internal ingestion API
 * described in Guide §1.2 and Scope §43.
 *
 * Endpoint shapes are documented in docs/DESTINATION_INVENTORY.md. Contract
 * tests (test/destination-contract.test.ts) run against BOTH drivers, so when
 * BuilderLync's endpoints land, the same assertions that pass for the sandbox
 * must pass here -- that is the mechanism that keeps the swap honest rather
 * than hopeful.
 */

const ENTITY_ENDPOINTS: Partial<Record<EntityType, string>> = {
  contact: '/internal/migration/contacts/batch',
  user: '/internal/migration/users/batch',
  opportunity: '/internal/migration/opportunities/batch',
  job: '/internal/migration/jobs/batch',
  activity: '/internal/migration/activities/batch',
  note: '/internal/migration/notes/batch',
  company: '/internal/migration/companies/batch',
  tag: '/internal/migration/tags/batch',
  custom_field: '/internal/migration/custom-fields/batch',
  pipeline: '/internal/migration/pipelines/batch',
  pipeline_stage: '/internal/migration/pipeline-stages/batch',
  task: '/internal/migration/tasks/batch',
  appointment: '/internal/migration/appointments/batch',
  account: '/internal/migration/accounts/batch',
  location: '/internal/migration/locations/batch',
};

export interface HttpDestinationOptions {
  baseUrl?: string;
  token?: string;
  apiVersion?: string;
  /** Per-request timeout. Distinct from pipeline-level retry budget. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpDestination implements DestinationClient {
  readonly driver = 'http' as const;
  readonly apiVersion: string;

  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpDestinationOptions = {}) {
    const cfg = config();
    this.baseUrl = (options.baseUrl ?? cfg.BUILDERLYNC_API_BASE_URL).replace(/\/$/, '');
    this.token = options.token ?? cfg.BUILDERLYNC_API_TOKEN;
    this.apiVersion = options.apiVersion ?? cfg.BUILDERLYNC_DESTINATION_API_VERSION;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? fetch;

    if (!this.baseUrl) {
      throw new Error('BUILDERLYNC_API_BASE_URL is required when DESTINATION_DRIVER=http');
    }
  }

  async writeBatch(request: BatchRequest): Promise<BatchResponse> {
    const endpoint = ENTITY_ENDPOINTS[request.entity];
    if (!endpoint) {
      return {
        results: request.records.map((r) => ({
          source_id: r.sourceId,
          status: 'UNSUPPORTED' as const,
          builderlync_id: null,
          error: {
            code: 'UNSUPPORTED_FIELD',
            message: `No BuilderLync ingestion endpoint is mapped for entity "${request.entity}"`,
            retryable: false,
          },
        })),
      };
    }

    const body = await this.post<BatchResponse>(endpoint, {
      migration_id: request.migrationId,
      entity: request.entity,
      records: request.records.map((r) => ({
        source_id: r.sourceId,
        idempotency_key: r.idempotencyKey,
        content_hash: r.contentHash,
        payload: r.payload,
      })),
    }, request.tenantId);

    // Scope §44: the response must account for every input record. If the
    // destination returns a short list, the missing records are unaccounted
    // for -- which the reconciliation gate would later catch as a discrepancy
    // with no explanation. Failing loudly here names the real cause.
    const returned = new Set(body.results.map((r) => r.source_id));
    const missing = request.records.filter((r) => !returned.has(r.sourceId));
    if (missing.length > 0) {
      throw new MigrationError(
        'BUILDERLYNC_API_ERROR',
        `Batch response omitted ${missing.length} of ${request.records.length} records ` +
          `(first missing source_id: ${missing[0]?.sourceId}). Every input record must receive a result.`,
        { entity: request.entity, migrationId: request.migrationId },
      );
    }

    return body;
  }

  async findContactCandidates(criteria: ContactLookupCriteria): Promise<ContactCandidate[]> {
    const params = new URLSearchParams();
    if (criteria.normalizedEmail) params.set('email', criteria.normalizedEmail);
    if (criteria.normalizedPhone) params.set('phone', criteria.normalizedPhone);
    if (criteria.nameKey) params.set('name', criteria.nameKey);
    if (criteria.addressKey) params.set('address_key', criteria.addressKey);
    if ([...params.keys()].length === 0) return [];

    const body = await this.get<{ candidates: ContactCandidate[] }>(
      `/internal/migration/contacts/candidates?${params.toString()}`,
      criteria.tenantId,
    );
    return body.candidates ?? [];
  }

  async uploadFile(request: FileUploadRequest): Promise<FileUploadResult> {
    const form = new FormData();
    form.set('migration_id', request.migrationId);
    form.set('idempotency_key', request.idempotencyKey);
    form.set('kind', request.kind);
    form.set('content_hash', request.contentHash);
    if (request.parentEntityType) form.set('parent_entity_type', request.parentEntityType);
    if (request.parentBuilderLyncId) form.set('parent_id', request.parentBuilderLyncId);
    if (request.uploadedByUserId) form.set('uploaded_by_user_id', request.uploadedByUserId);
    if (request.sourceCreatedAt) form.set('source_created_at', request.sourceCreatedAt.toISOString());
    form.set('external_source_platform', request.externalSourcePlatform);
    form.set('external_source_id', request.externalSourceId);
    form.set(
      'file',
      new Blob([new Uint8Array(request.content)], { type: request.mimeType ?? 'application/octet-stream' }),
      request.fileName,
    );

    const response = await this.request('/internal/migration/files', {
      method: 'POST',
      body: form,
      tenantId: request.tenantId,
    });
    return (await response.json()) as FileUploadResult;
  }

  async countsForMigration(tenantId: string, migrationId: string): Promise<DestinationCounts[]> {
    const body = await this.get<{ counts: DestinationCounts[] }>(
      `/internal/migration/${encodeURIComponent(migrationId)}/counts`,
      tenantId,
    );
    return body.counts ?? [];
  }

  async relationshipIntegrity(tenantId: string, migrationId: string): Promise<RelationshipIntegrityReport> {
    return this.get<RelationshipIntegrityReport>(
      `/internal/migration/${encodeURIComponent(migrationId)}/relationship-integrity`,
      tenantId,
    );
  }

  async resolveId(tenantId: string, entity: EntityType, builderLyncId: string): Promise<boolean> {
    try {
      await this.get(`/internal/migration/objects/${entity}/${encodeURIComponent(builderLyncId)}`, tenantId);
      return true;
    } catch (err) {
      if (err instanceof MigrationError && err.code === 'SOURCE_NOT_FOUND') return false;
      throw err;
    }
  }

  // --- transport ---------------------------------------------------------

  private async get<T>(path: string, tenantId: string): Promise<T> {
    const response = await this.request(path, { method: 'GET', tenantId });
    return (await response.json()) as T;
  }

  private async post<T>(path: string, payload: unknown, tenantId: string): Promise<T> {
    const response = await this.request(path, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
      tenantId,
    });
    return (await response.json()) as T;
  }

  private async request(
    path: string,
    options: { method: string; body?: BodyInit; headers?: Record<string, string>; tenantId: string },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: options.method,
        body: options.body,
        signal: controller.signal,
        headers: {
          ...(options.headers ?? {}),
          authorization: `Bearer ${this.token}`,
          // Scope §47: tenancy travels as an explicit header that BuilderLync
          // must re-authorize server-side. It is never read from a payload.
          'x-builderlync-tenant': options.tenantId,
          'x-builderlync-api-version': this.apiVersion,
          accept: 'application/json',
        },
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new MigrationError(
          response.status === 404 ? 'SOURCE_NOT_FOUND' : 'BUILDERLYNC_API_ERROR',
          `BuilderLync ${options.method} ${path} returned ${response.status}: ${text.slice(0, 500)}`,
          { raw: { status: response.status, path } },
          { retryable: response.status >= 500 || response.status === 429 },
        );
      }
      return response;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new MigrationError('SOURCE_TIMEOUT', `BuilderLync ${options.method} ${path} timed out after ${this.timeoutMs}ms`, {
          raw: { path },
        });
      }
      throw toMigrationError(err, { raw: { path } });
    } finally {
      clearTimeout(timer);
    }
  }
}
