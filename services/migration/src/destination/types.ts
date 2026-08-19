import type { EntityType } from '../domain/entities.js';
import type { RecordState } from '../domain/states.js';

/**
 * The destination port: everything the migration engine needs BuilderLync to
 * expose, and nothing more.
 *
 * Guide §1.2/§1.3 and Scope §43-45 describe this as a set of internal batch
 * endpoints with per-record results and idempotency keys. Expressing it as one
 * interface has two payoffs:
 *
 *   1. The engine is testable and demonstrable before BuilderLync's real
 *      endpoints exist (the sandbox driver).
 *   2. Scope §88's rule -- source-specific logic must not leak into BuilderLync
 *      -- is enforced by construction, because the only thing that crosses this
 *      boundary is a canonical object.
 */

/** Per-record outcome. Scope §44: every input record gets one of these back. */
export interface BatchRecordResult {
  /** The source object id, so the caller can reconcile without relying on order. */
  source_id: string;
  status: Extract<RecordState, 'CREATED' | 'UPDATED' | 'MERGED' | 'SKIPPED' | 'FAILED' | 'UNSUPPORTED'>;
  builderlync_id: string | null;
  /** Present only when status is FAILED. */
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  /** True when the write was served from the idempotency ledger, not re-executed. */
  idempotent_replay?: boolean;
}

export interface BatchRequest {
  tenantId: string;
  migrationId: string;
  entity: EntityType;
  /** Canonical objects, already validated against the canonical schema. */
  records: ReadonlyArray<{
    sourceId: string;
    idempotencyKey: string;
    contentHash: string;
    payload: Record<string, unknown>;
  }>;
}

export interface BatchResponse {
  results: BatchRecordResult[];
}

/** A destination-side duplicate candidate (Scope §20, Guide §13.2). */
export interface ContactCandidate {
  builderlync_id: string;
  normalized_email: string | null;
  normalized_phone: string | null;
  first_name: string | null;
  last_name: string | null;
  address_key: string | null;
  external_source_platform: string | null;
  external_source_id: string | null;
}

export interface ContactLookupCriteria {
  tenantId: string;
  normalizedEmail?: string | null;
  normalizedPhone?: string | null;
  nameKey?: string | null;
  addressKey?: string | null;
}

export interface FileUploadRequest {
  tenantId: string;
  migrationId: string;
  idempotencyKey: string;
  fileName: string;
  originalName: string | null;
  mimeType: string | null;
  kind: 'document' | 'image' | 'attachment';
  content: Buffer;
  contentHash: string;
  parentEntityType: string | null;
  /** Already-resolved BuilderLync id of the parent; never a source id. */
  parentBuilderLyncId: string | null;
  uploadedByUserId: string | null;
  sourceCreatedAt: Date | null;
  width?: number | null;
  height?: number | null;
  album?: string | null;
  externalSourcePlatform: string;
  externalSourceId: string;
}

export interface FileUploadResult {
  builderlync_file_id: string;
  destination_hash: string;
  destination_url: string;
  size_bytes: number;
  idempotent_replay?: boolean;
}

/** Reconciliation support: what the destination believes it holds (Scope §38). */
export interface DestinationCounts {
  entity: EntityType;
  created_by_migration: number;
  updated_by_migration: number;
}

export interface RelationshipIntegrityReport {
  jobs_without_contact: number;
  opportunities_without_pipeline: number;
  jobs_without_assigned_user: number;
  files_without_parent: number;
  contacts_without_jobs: number;
  records_referencing_missing_user: number;
}

export interface DestinationClient {
  readonly driver: 'sandbox' | 'http';
  readonly apiVersion: string;

  /** Guide §1.2: one call per entity batch, per-record results guaranteed. */
  writeBatch(request: BatchRequest): Promise<BatchResponse>;

  /** Guide §13: candidate lookup for the deduplication tiers. */
  findContactCandidates(criteria: ContactLookupCriteria): Promise<ContactCandidate[]>;

  /** Guide §14: binary transfer, separate from the record pipeline. */
  uploadFile(request: FileUploadRequest): Promise<FileUploadResult>;

  /** Scope §38-39: destination-side counts and relationship checks. */
  countsForMigration(tenantId: string, migrationId: string): Promise<DestinationCounts[]>;
  relationshipIntegrity(tenantId: string, migrationId: string): Promise<RelationshipIntegrityReport>;

  /** Resolve a previously-migrated source id to its BuilderLync id. */
  resolveId(tenantId: string, entity: EntityType, builderLyncId: string): Promise<boolean>;

  close?(): Promise<void>;
}

/**
 * Destination-side rejection reasons that the engine must distinguish from
 * transport failures. A tenant mismatch is never retryable: retrying it would
 * be retrying a security violation (Scope §47).
 */
export class TenantIsolationError extends Error {
  constructor(expected: string, received: string) {
    super(
      `Tenant isolation violation: migration belongs to tenant "${expected}" but the write targeted "${received}". ` +
        'The write was rejected and no records were persisted.',
    );
    this.name = 'TenantIsolationError';
  }
}
