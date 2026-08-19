import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ENTITY_TYPES, type EntityType } from '../../domain/entities.js';
import { getDestination } from '../../destination/index.js';
import { requireAuth } from '../auth.js';

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

  app.get('/internal/migration/:migrationId/counts', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { migrationId } = z.object({ migrationId: z.string().uuid() }).parse(request.params);
    return { counts: await getDestination().countsForMigration(principal.tenantId, migrationId) };
  });

  app.get('/internal/migration/:migrationId/relationship-integrity', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { migrationId } = z.object({ migrationId: z.string().uuid() }).parse(request.params);
    return await getDestination().relationshipIntegrity(principal.tenantId, migrationId);
  });
}
