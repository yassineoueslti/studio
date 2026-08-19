import { createHash } from 'node:crypto';
import type { EntityType } from '../../domain/entities.js';
import { MigrationError } from '../../domain/errors.js';
import {
  normalizeAddress, normalizeDate, normalizeEmail, normalizeMoneyCents,
  normalizePhone, normalizeTags, normalizeText, splitFullName,
} from '../../transformers/normalize.js';
import {
  DEFAULT_RATE_LIMIT, UnsupportedEntityError, supports,
  type AdapterContext, type ConnectionTestResult, type DiscoveryResult, type ExtractOptions,
  type ExtractPage, type PaginationStrategy, type RateLimitProfile, type SourceAdapter,
  type SourceCapabilities,
} from '../types.js';
import { generateDataset, type GenerateOptions, type MockContact, type MockDataset, type MockFile, type MockJob, type MockNote } from './fixtures.js';

/**
 * Mock source adapter (Guide §21 step 6, Sprint task 6).
 *
 * This is the adapter the platform is proven against before any vendor is
 * touched. It is not a stub: it paginates, it rate-limits, it throws the same
 * error taxonomy real adapters throw, and its failures are *injectable*, which
 * is what makes Guide §20's Tests 3-9 executable without a vendor sandbox.
 */

export interface FaultInjection {
  /** Fail every Nth extraction call with the given error, then succeed. */
  failEveryNthExtract?: { n: number; code: 'RATE_LIMIT' | 'SOURCE_TIMEOUT' | 'AUTHENTICATION_ERROR' | 'PERMISSION_ERROR' };
  /** Throw on the extract call for this entity once, then stop. */
  failOnceForEntity?: EntityType;
  /** Reject authentication outright (Test 7: expired credentials). */
  authFails?: boolean;
  /** Entities the credential is not permitted to read (Test 8: restricted profile). */
  deniedEntities?: EntityType[];
  /** Artificial per-page latency, to exercise timeouts and progress reporting. */
  pageLatencyMs?: number;
}

export interface MockAdapterOptions extends GenerateOptions {
  faults?: FaultInjection;
  /** Overrides the default capability set, for capability-registry tests. */
  capabilities?: Partial<SourceCapabilities>;
  pageSize?: number;
}

const BASE_CAPABILITIES: SourceCapabilities = Object.freeze({
  entities: Object.freeze({
    user: true, tag: true, custom_field: true, pipeline: true, pipeline_stage: true,
    contact: true, opportunity: true, job: true, note: true, activity: true,
    document: true, image: true,
    // Declared unsupported so capability suppression is exercised end to end.
    appointment: false, team: false, lead: false, company: false,
  }),
  delta_sync: true,
  webhooks: false,
  historical_api_access: true,
  self_service_auth: true,
  file_export_import: false,
  notes: Object.freeze({
    general: 'Mock CRM. Deterministic fixtures generated from a seed; used to prove platform behaviour without a vendor account.',
  }),
});

export class MockAdapter implements SourceAdapter {
  readonly platform = 'mock' as const;
  readonly connectorVersion = 'mock-v1.0.0';
  readonly capabilities: SourceCapabilities;
  readonly rateLimit: RateLimitProfile;
  readonly paginationStrategy: PaginationStrategy = 'cursor';

  private readonly dataset: MockDataset;
  private readonly faults: FaultInjection;
  private readonly pageSize: number;
  private extractCallCount = 0;
  private readonly firedOnceFor = new Set<EntityType>();

  constructor(options: MockAdapterOptions) {
    this.dataset = generateDataset(options);
    this.faults = options.faults ?? {};
    this.pageSize = options.pageSize ?? 250;
    this.rateLimit = { ...DEFAULT_RATE_LIMIT, pageSize: this.pageSize, requestsPerSecond: 50, requestsPerMinute: 3000 };

    const denied = this.faults.deniedEntities ?? [];
    const entities = { ...BASE_CAPABILITIES.entities, ...(options.capabilities?.entities ?? {}) };
    for (const entity of denied) entities[entity] = 'conditional';

    this.capabilities = { ...BASE_CAPABILITIES, ...options.capabilities, entities: Object.freeze(entities) };
  }

  /** Test hook: the generated dataset, for assertions about expected counts. */
  get data(): MockDataset {
    return this.dataset;
  }

  async authenticate(_context: AdapterContext): Promise<void> {
    if (this.faults.authFails) {
      throw new MigrationError(
        'AUTHENTICATION_ERROR',
        'The stored credential for this source was rejected. Reconnect the source to continue.',
      );
    }
  }

  async testConnection(context: AdapterContext): Promise<ConnectionTestResult> {
    if (this.faults.authFails) {
      return {
        ok: false,
        message: 'Authentication failed. The API key is invalid or has expired - reconnect the source.',
        resourceAccess: [],
      };
    }

    const denied = new Set(this.faults.deniedEntities ?? []);
    const resourceAccess = (Object.keys(this.capabilities.entities) as EntityType[])
      .filter((entity) => supports(this.capabilities, entity))
      .map((entity) => ({
        entity,
        accessible: !denied.has(entity),
        // Guide §9.2: name the missing permission, do not just say "failed".
        ...(denied.has(entity)
          ? { reason: `The connected credential's access profile does not grant read access to ${entity}.` }
          : {}),
      }));

    return {
      ok: true,
      message: 'Connection succeeded.',
      sourceTenantId: context.sourceTenantId ?? 'mock-tenant-001',
      sourceAccountName: 'Mock Contracting Co.',
      resourceAccess,
    };
  }

  async discover(_context: AdapterContext): Promise<DiscoveryResult> {
    const denied = new Set(this.faults.deniedEntities ?? []);
    const counts = (Object.keys(this.capabilities.entities) as EntityType[]).map((entity) => {
      const supported = supports(this.capabilities, entity) && !denied.has(entity);
      return {
        entity,
        count: supported ? this.recordsFor(entity).length : 0,
        supported,
        ...(denied.has(entity) ? { note: 'Credential lacks permission for this object.' } : {}),
      };
    });

    return {
      counts,
      sourceTenantId: 'mock-tenant-001',
      sourceAccountName: 'Mock Contracting Co.',
      totalEstimatedObjects: counts.reduce((sum, c) => sum + c.count, 0),
    };
  }

  async extract(entity: EntityType, _context: AdapterContext, options: ExtractOptions = {}): Promise<ExtractPage> {
    if (!supports(this.capabilities, entity)) throw new UnsupportedEntityError(this.platform, entity);

    if ((this.faults.deniedEntities ?? []).includes(entity)) {
      throw new MigrationError('PERMISSION_ERROR', `The connected credential cannot read ${entity} from this account.`, { entity });
    }

    this.extractCallCount += 1;

    const nth = this.faults.failEveryNthExtract;
    if (nth && this.extractCallCount % nth.n === 0) {
      throw new MigrationError(nth.code, `Injected ${nth.code} on extract call ${this.extractCallCount}`, { entity });
    }

    if (this.faults.failOnceForEntity === entity && !this.firedOnceFor.has(entity)) {
      this.firedOnceFor.add(entity);
      throw new MigrationError('SOURCE_TIMEOUT', `Injected one-time failure while extracting ${entity}`, { entity });
    }

    if (this.faults.pageLatencyMs) {
      await new Promise((resolve) => setTimeout(resolve, this.faults.pageLatencyMs));
    }

    let records = this.recordsFor(entity);

    // Delta sync (Scope §50): filter by the caller's watermark.
    if (options.updatedSince) {
      const since = options.updatedSince.getTime();
      records = records.filter((r) => {
        const modified = normalizeDate((r as { modified?: unknown }).modified ?? (r as { created?: unknown }).created);
        return modified !== null && modified.getTime() > since;
      });
    }

    const offset = typeof options.cursor === 'number' ? options.cursor : 0;
    const size = options.pageSize ?? this.pageSize;
    const page = records.slice(offset, offset + size);
    const nextOffset = offset + page.length;

    return {
      records: page,
      cursor: nextOffset < records.length ? nextOffset : null,
      hasMore: nextOffset < records.length,
      totalEstimate: records.length,
    };
  }

  async getChanges(entity: EntityType, context: AdapterContext, since: Date, options: ExtractOptions = {}): Promise<ExtractPage> {
    return this.extract(entity, context, { ...options, updatedSince: since });
  }

  async downloadFile(_context: AdapterContext, file: { sourceId: string; url: string | null }): Promise<{
    content: Buffer; mimeType: string | null; fileName: string | null;
  }> {
    const meta = this.dataset.files.find((f) => f.id === file.sourceId);
    if (!meta) {
      throw new MigrationError('SOURCE_NOT_FOUND', `Mock file ${file.sourceId} does not exist at the source`, { sourceId: file.sourceId });
    }
    if (meta.__unavailable || !meta.url) {
      // Test 9: the source lists the asset but cannot serve it.
      throw new MigrationError('FILE_DOWNLOAD_ERROR', `Source asset ${file.sourceId} is listed but not retrievable`, { sourceId: file.sourceId });
    }

    // Deterministic synthetic bytes, so hashes are reproducible across runs.
    const seed = createHash('sha256').update(meta.id).digest();
    const content = Buffer.alloc(meta.size);
    for (let i = 0; i < content.length; i += seed.length) seed.copy(content, i);

    return { content, mimeType: meta.mime, fileName: meta.name };
  }

  transformerVersion(entity: EntityType): string {
    return `mock-${entity}-v1.0.0`;
  }

  // -------------------------------------------------------------------------
  // normalize(): raw mock record -> canonical object (Guide §3)
  // -------------------------------------------------------------------------

  normalize(entity: EntityType, raw: unknown, context: AdapterContext): Record<string, unknown> {
    const base = {
      migration_id: context.migrationId,
      source_platform: this.platform,
      source_tenant_id: context.sourceTenantId,
      source_object_type: entity,
      transformer_version: this.transformerVersion(entity),
      warnings: [] as Array<{ code: string; message: string; field?: string }>,
    };

    switch (entity) {
      case 'user': {
        const u = raw as MockDataset['users'][number];
        return {
          ...base,
          source_object_id: u.id,
          first_name: normalizeText(u.first_name),
          last_name: normalizeText(u.last_name),
          email: normalizeEmail(u.email),
          phone: normalizePhone(u.phone),
          role: normalizeText(u.role),
          source_role: normalizeText(u.role),
          is_active: u.active,
          // Scope §19: an inactive source user becomes an inactive historical
          // BuilderLync user, keeping their historical work attributed to them.
          is_historical: !u.active,
          source_created_at: null,
          source_updated_at: null,
        };
      }

      case 'tag': {
        const t = raw as MockDataset['tags'][number];
        return { ...base, source_object_id: t.id, name: normalizeText(t.name) ?? t.id };
      }

      case 'pipeline': {
        const p = raw as MockDataset['pipelines'][number];
        return { ...base, source_object_id: p.id, name: normalizeText(p.name) ?? p.id, is_active: true };
      }

      case 'pipeline_stage': {
        const s = raw as MockDataset['stages'][number];
        return {
          ...base,
          source_object_id: s.id,
          name: normalizeText(s.name) ?? s.id,
          pipeline_source_id: s.pipeline_id,
          position: s.position,
          is_won: /won|complete/i.test(s.name),
          is_lost: /lost/i.test(s.name),
        };
      }

      case 'custom_field': {
        const key = String(raw);
        return {
          ...base,
          source_object_id: key,
          entity_type: 'contact',
          key,
          label: key.replace(/_/g, ' '),
          field_type: 'text',
          options: [],
        };
      }

      case 'contact':
        return this.normalizeContact(raw as MockContact, base);

      case 'job':
        return this.normalizeJob(raw as MockJob, base);

      case 'note': {
        const nRaw = raw as MockNote;
        return {
          ...base,
          source_object_id: nRaw.id,
          parent_entity_type: nRaw.parent_type,
          parent_source_id: nRaw.parent_id,
          body: normalizeText(nRaw.body, 65_535),
          body_format: /<[a-z][\s\S]*>/i.test(nRaw.body) ? 'html' : 'text',
          // Guide §9.4: the source timestamp and author are preserved, so an
          // imported note reads as history rather than as today's activity.
          authored_at: normalizeDate(nRaw.created),
          author_user_source_id: nRaw.author_user_id,
          author_source_name: normalizeText(nRaw.author_name),
          source_created_at: normalizeDate(nRaw.created),
          source_updated_at: normalizeDate(nRaw.created),
        };
      }

      case 'document':
      case 'image': {
        const f = raw as MockFile;
        return {
          ...base,
          source_object_id: f.id,
          file_name: f.name,
          original_name: f.name,
          mime_type: f.mime,
          size_bytes: f.size,
          source_url: f.url,
          parent_entity_type: f.parent_type,
          parent_source_id: f.parent_id,
          kind: f.kind,
          uploaded_by_user_source_id: null,
          source_hash: null,
          source_created_at: null,
          source_updated_at: null,
          ...(entity === 'image' ? { width: 1600, height: 1200, exif_retention: 'strip' } : {}),
        };
      }

      default:
        throw new UnsupportedEntityError(this.platform, entity);
    }
  }

  private normalizeContact(c: MockContact, base: Record<string, unknown>): Record<string, unknown> {
    const warnings = base['warnings'] as Array<{ code: string; message: string; field?: string }>;

    // A source that supplies only a combined name column still has to produce
    // first/last, because the destination model has both (Guide §12).
    let first = normalizeText(c.first_name);
    let last = normalizeText(c.last_name);
    if ((!first || !last) && c.full_name) {
      const split = splitFullName(c.full_name);
      first ??= split.first;
      last ??= split.last;
    }

    const created = normalizeDate(c.created);
    if (c.created !== null && c.created !== undefined && created === null) {
      warnings.push({ code: 'INVALID_DATE', message: `Unparseable created date "${String(c.created)}"; left empty.`, field: 'created' });
    }

    const email = normalizeEmail(c.email);
    const phone = normalizePhone(c.phone);
    if (!email && !phone) {
      warnings.push({ code: 'NO_CONTACT_METHOD', message: 'Contact has neither an email address nor a phone number.' });
    }

    const address = normalizeAddress({
      line1: c.street, city: c.city, state: c.state, postal_code: c.zip, country: c.country,
    });

    const customFields = Object.fromEntries(
      Object.entries(c.custom).filter(([, v]) => v !== '' && v !== null && v !== undefined),
    );

    return {
      ...base,
      // Test 6: a deliberately malformed record fails canonical validation and
      // is recorded as one FAILED record, leaving its batch-mates intact.
      source_object_id: c.__malformed ? '' : c.id,
      first_name: first,
      last_name: last,
      email,
      phone,
      secondary_emails: c.secondary_email ? [normalizeEmail(c.secondary_email)].filter(Boolean) : [],
      secondary_phones: [],
      address,
      lead_source: normalizeText(c.lead_source),
      tags: normalizeTags(c.tags),
      assigned_user_source_id: c.assigned_user_id,
      custom_fields: customFields,
      communication_prefs: {},
      normalized_email: email,
      normalized_phone: phone,
      source_created_at: created,
      source_updated_at: normalizeDate(c.modified),
    };
  }

  private normalizeJob(job: MockJob, base: Record<string, unknown>): Record<string, unknown> {
    const warnings = base['warnings'] as Array<{ code: string; message: string; field?: string }>;
    if (!job.contact_id) {
      warnings.push({ code: 'JOB_WITHOUT_CONTACT', message: 'Job has no associated customer at the source.' });
    }

    return {
      ...base,
      source_object_id: job.id,
      job_number: normalizeText(job.job_number),
      name: normalizeText(job.name),
      contact_source_id: job.contact_id,
      opportunity_source_id: null,
      address: normalizeAddress({ line1: job.street, city: job.city, state: job.state, postal_code: job.zip, country: 'USA' }),
      job_type: normalizeText(job.job_type),
      status: normalizeText(job.status),
      stage_source_id: null,
      value: { amount_cents: normalizeMoneyCents(job.value), currency: 'USD' },
      assigned_user_source_ids: job.assigned_user_ids,
      start_date: normalizeDate(job.start),
      completion_date: normalizeDate(job.completed),
      lead_source: normalizeText(job.lead_source),
      tags: normalizeTags(job.tags),
      notes: null,
      custom_fields: {},
      source_created_at: normalizeDate(job.created),
      source_updated_at: normalizeDate(job.modified),
    };
  }

  private recordsFor(entity: EntityType): unknown[] {
    switch (entity) {
      case 'user': return this.dataset.users;
      case 'tag': return this.dataset.tags;
      case 'pipeline': return this.dataset.pipelines;
      case 'pipeline_stage': return this.dataset.stages;
      case 'custom_field': return ['referred_by', 'insurance_claim', 'internal_memo'];
      case 'contact': return this.dataset.contacts;
      case 'job': return this.dataset.jobs;
      case 'note': return this.dataset.notes;
      case 'document': return this.dataset.files.filter((f) => f.kind === 'document');
      case 'image': return this.dataset.files.filter((f) => f.kind === 'image');
      case 'opportunity': return [];
      case 'activity': return [];
      default: return [];
    }
  }
}
