import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ENTITY_TYPES, type EntityType } from '../../domain/entities.js';
import { ERROR_CODES } from '../../domain/errors.js';
import { getDestination } from '../../destination/index.js';
import { requireAuth } from '../auth.js';
import { getPool } from '../../db/pool.js';
import * as migrationsRepo from '../../db/repositories/migrations.js';
import { MigrationError } from '../../domain/errors.js';
import type { Principal } from '../../domain/permissions.js';

/**
 * Confirm the migration exists AND belongs to the caller's tenant.
 *
 * Every internal endpoint takes a migration_id from the request. Without this
 * check a caller holding a perfectly valid token for their own tenant could
 * aim writes at somebody else's migration: poisoning its checkpoints so a
 * resumed run skips real records, injecting errors into its dashboard, or
 * tagging destination rows with a migration that does not belong to them --
 * which breaks the audit chain Scope §83 requires.
 *
 * Reported as not-found rather than forbidden, so the endpoint cannot be used
 * to discover which migration ids exist in other tenants (Scope §47).
 */
async function requireOwnedMigration(principal: Principal, migrationId: string): Promise<void> {
  const migration = await migrationsRepo.getMigration(getPool(), principal.tenantId, migrationId);
  if (!migration) {
    throw new MigrationError('SOURCE_NOT_FOUND', `Migration ${migrationId} was not found.`, { migrationId });
  }
}

/**
 * Internal ingestion API (Guide §1.2, Scope §43-45).
 *
 * These are the endpoints n8n workers call. They exist separately from normal
 * application CRUD for the reasons Scope §43 gives: bulk import has different
 * shape, different idempotency needs, and different failure semantics than a
 * user editing one contact in the UI.
 *
 * Two invariants every endpoint here upholds:
 *   1. Every input record receives a result (Scope §44).
 *   2. The tenant comes from the authenticated principal, never the body
 *      (Scope §47) -- a worker cannot be tricked into writing into another
 *      customer's account by a crafted payload.
 */

const ENTITY_BY_PATH: Record<string, EntityType> = {
  accounts: 'account',
  locations: 'location',
  users: 'user',
  contacts: 'contact',
  companies: 'company',
  opportunities: 'opportunity',
  jobs: 'job',
  activities: 'activity',
  notes: 'note',
  tasks: 'task',
  appointments: 'appointment',
  tags: 'tag',
  'custom-fields': 'custom_field',
  pipelines: 'pipeline',
  'pipeline-stages': 'pipeline_stage',
};

const batchBody = z.object({
  migration_id: z.string().uuid(),
  entity: z.enum(ENTITY_TYPES).optional(),
  records: z.array(
    z.object({
      source_id: z.string().min(1),
      idempotency_key: z.string().min(1),
      content_hash: z.string().min(1),
      payload: z.record(z.string(), z.unknown()),
    }),
  ).min(1).max(2000),
});

export function registerIngestionRoutes(app: FastifyInstance): void {
  for (const [path, entity] of Object.entries(ENTITY_BY_PATH)) {
    app.post(`/internal/migration/${path}/batch`, async (request, reply) => {
      const principal = requireAuth(request, reply);
      if (!principal) return;

      const body = batchBody.parse(request.body);
      await requireOwnedMigration(principal, body.migration_id);
      const destination = getDestination();

      const response = await destination.writeBatch({
        // Server-resolved tenancy. A tenant_id in the body is ignored.
        tenantId: principal.tenantId,
        migrationId: body.migration_id,
        entity: body.entity ?? entity,
        records: body.records.map((r) => ({
          sourceId: r.source_id,
          idempotencyKey: r.idempotency_key,
          contentHash: r.content_hash,
          payload: r.payload,
        })),
      });

      // Scope §44: assert the per-record contract at the boundary, so a driver
      // bug surfaces here rather than as an unexplained reconciliation variance
      // hours later.
      const returned = new Set(response.results.map((r) => r.source_id));
      const missing = body.records.filter((r) => !returned.has(r.source_id));
      if (missing.length > 0) {
        return reply.code(500).send({
          error: {
            code: 'BUILDERLYNC_API_ERROR',
            message: `Ingestion returned ${response.results.length} results for ${body.records.length} records; ` +
              `${missing.length} unaccounted for.`,
          },
        });
      }

      return { results: response.results };
    });
  }

  // --- file ingestion (Guide §1.2) ---------------------------------------
  app.post('/internal/migration/files', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;

    const body = z.object({
      migration_id: z.string().uuid(),
      idempotency_key: z.string().min(1),
      file_name: z.string().min(1),
      original_name: z.string().nullish(),
      mime_type: z.string().nullish(),
      kind: z.enum(['document', 'image', 'attachment']).default('document'),
      parent_entity_type: z.string().nullish(),
      parent_id: z.string().nullish(),
      external_source_platform: z.string().min(1),
      external_source_id: z.string().min(1),
      /** Base64 body. Large assets should use the streaming path in production. */
      content_base64: z.string().min(1),
    }).parse(request.body);

    await requireOwnedMigration(principal, body.migration_id);

    const content = Buffer.from(body.content_base64, 'base64');
    const { createHash } = await import('node:crypto');
    const contentHash = createHash('sha256').update(content).digest('hex');

    const result = await getDestination().uploadFile({
      tenantId: principal.tenantId,
      migrationId: body.migration_id,
      idempotencyKey: body.idempotency_key,
      fileName: body.file_name,
      originalName: body.original_name ?? null,
      mimeType: body.mime_type ?? null,
      kind: body.kind,
      content,
      contentHash,
      parentEntityType: body.parent_entity_type ?? null,
      parentBuilderLyncId: body.parent_id ?? null,
      uploadedByUserId: null,
      sourceCreatedAt: null,
      externalSourcePlatform: body.external_source_platform,
      externalSourceId: body.external_source_id,
    });

    return result;
  });

  // --- dedupe candidate lookup, used by the matcher over HTTP -------------
  app.get('/internal/migration/contacts/candidates', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;

    const query = z.object({
      email: z.string().optional(),
      phone: z.string().optional(),
      name: z.string().optional(),
      address_key: z.string().optional(),
    }).parse(request.query ?? {});

    const candidates = await getDestination().findContactCandidates({
      tenantId: principal.tenantId,
      normalizedEmail: query.email ?? null,
      normalizedPhone: query.phone ?? null,
      nameKey: query.name ?? null,
      addressKey: query.address_key ?? null,
    });

    return { candidates };
  });

  /**
   * Checkpoint recording for externally-driven extraction (Scope §27).
   *
   * When n8n owns extraction -- the production topology for vendor adapters --
   * it must still checkpoint into BuilderLync rather than into n8n execution
   * state, because Scope §68 puts migration state in the migration platform and
   * leaves n8n as the orchestration engine. This is the endpoint that keeps that
   * boundary honest: an n8n execution can die at any point and the migration
   * resumes from what BuilderLync recorded.
   */
  app.post('/internal/migration/:migrationId/checkpoint', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;

    const { migrationId } = z.object({ migrationId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      entity: z.enum(ENTITY_TYPES),
      cursor: z.unknown().nullish(),
      last_source_id: z.string().nullish(),
      records_processed: z.number().int().nonnegative(),
      batch_number: z.number().int().nonnegative(),
      extraction_complete: z.boolean().default(false),
    }).parse(request.body);

    await requireOwnedMigration(principal, migrationId);

    const { withTransaction } = await import('../../db/pool.js');
    const recordsRepo = await import('../../db/repositories/records.js');

    await withTransaction((client) =>
      recordsRepo.saveCheckpoint(client, {
        migrationId,
        tenantId: principal.tenantId,
        entity: body.entity,
        cursor: body.cursor ?? null,
        lastSourceId: body.last_source_id ?? null,
        recordsProcessed: body.records_processed,
        batchNumber: body.batch_number,
        extractionComplete: body.extraction_complete,
      }),
    );

    return { checkpointed: true };
  });

  /** Resume support: where should the caller pick up for this entity? */
  app.get('/internal/migration/:migrationId/checkpoint/:entity', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;

    const params = z.object({
      migrationId: z.string().uuid(),
      entity: z.enum(ENTITY_TYPES),
    }).parse(request.params);

    await requireOwnedMigration(principal, params.migrationId);

    const recordsRepo = await import('../../db/repositories/records.js');
    const checkpoint = await recordsRepo.getCheckpoint(principal.tenantId, params.migrationId, params.entity);

    return {
      // A migration with no checkpoint starts from the beginning; that is a
      // normal first run, not an error.
      cursor: checkpoint?.cursor_json ?? null,
      batch_number: checkpoint?.batch_number ?? 0,
      records_processed: checkpoint?.records_processed ?? 0,
      extraction_complete: checkpoint?.extraction_complete ?? false,
    };
  });

  /** Error reporting from an orchestrator worker (MIG-900). */
  app.post('/internal/migration/:migrationId/errors', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;

    const { migrationId } = z.object({ migrationId: z.string().uuid() }).parse(request.params);
    const body = z.object({
      entity: z.string().nullish(),
      source_id: z.string().nullish(),
      error_code: z.enum(ERROR_CODES).default('UNKNOWN_ERROR'),
      message: z.string().min(1),
      context: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);

    await requireOwnedMigration(principal, migrationId);

    const { withTransaction } = await import('../../db/pool.js');
    const errorsRepo = await import('../../db/repositories/errors.js');

    await withTransaction((client) =>
      errorsRepo.recordError(client, {
        migrationId,
        tenantId: principal.tenantId,
        entity: body.entity ?? null,
        sourceId: body.source_id ?? null,
        error: new MigrationError(body.error_code, body.message, {
          entity: body.entity ?? undefined,
          sourceId: body.source_id ?? undefined,
          raw: body.context,
        }),
      }),
    );

    return { recorded: true };
  });

  app.get('/internal/migration/:migrationId/counts', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { migrationId } = z.object({ migrationId: z.string().uuid() }).parse(request.params);
    await requireOwnedMigration(principal, migrationId);
    return { counts: await getDestination().countsForMigration(principal.tenantId, migrationId) };
  });

  app.get('/internal/migration/:migrationId/relationship-integrity', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { migrationId } = z.object({ migrationId: z.string().uuid() }).parse(request.params);
    await requireOwnedMigration(principal, migrationId);
    return await getDestination().relationshipIntegrity(principal.tenantId, migrationId);
  });
}
