import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool } from '../../db/pool.js';
import * as errorsRepo from '../../db/repositories/errors.js';
import * as migrationsRepo from '../../db/repositories/migrations.js';
import * as recordsRepo from '../../db/repositories/records.js';
import { ENTITY_TYPES } from '../../domain/entities.js';
import { PermissionDeniedError } from '../../domain/permissions.js';
import type { MigrationService } from '../../service/migration-service.js';
import { requireAuth } from '../auth.js';

/**
 * Admin migration console (Scope §41, §64, Guide §16).
 *
 * The requirement this satisfies: "support can diagnose a failed object without
 * asking a database engineer to manually trace it." Every route here answers a
 * question support actually asks, keyed by the identifiers they actually have
 * -- a source id, an email, a job number, a filename.
 *
 * All routes require migration.admin. Staff access is audited like any other.
 */

export function registerAdminRoutes(app: FastifyInstance, service: MigrationService): void {
  const requireStaff = (request: Parameters<typeof requireAuth>[0], reply: Parameters<typeof requireAuth>[1]) => {
    const principal = requireAuth(request, reply);
    if (!principal) return null;
    if (!principal.permissions.includes('migration.admin')) {
      throw new PermissionDeniedError('migration.admin');
    }
    return principal;
  };

  // --- Scope §64: search by whatever identifier support has ---------------
  app.get('/admin/migrations/search', async (request, reply) => {
    const principal = requireStaff(request, reply);
    if (!principal) return;

    const query = z.object({
      source_id: z.string().optional(),
      builderlync_id: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      job_number: z.string().optional(),
      filename: z.string().optional(),
    }).parse(request.query ?? {});

    const results: Record<string, unknown> = {};

    if (query.source_id || query.builderlync_id) {
      results['records'] = await recordsRepo.traceRecord(principal.tenantId, {
        sourceId: query.source_id,
        builderLyncId: query.builderlync_id,
      });
    }

    if (query.email || query.phone) {
      const { rows } = await getPool().query(
        `SELECT id, first_name, last_name, email, phone, external_source_platform, external_source_id,
                created_by_migration_id, updated_by_migration_id
           FROM bl_contacts
          WHERE tenant_id = $1
            AND (($2::text IS NOT NULL AND normalized_email = $2::text)
              OR ($3::text IS NOT NULL AND normalized_phone = $3::text))
          LIMIT 50`,
        [principal.tenantId, query.email ?? null, query.phone ?? null],
      );
      results['contacts'] = rows;
    }

    if (query.job_number) {
      const { rows } = await getPool().query(
        `SELECT id, job_number, name, contact_id, external_source_platform, external_source_id, created_by_migration_id
           FROM bl_jobs WHERE tenant_id = $1 AND job_number = $2 LIMIT 50`,
        [principal.tenantId, query.job_number],
      );
      results['jobs'] = rows;
    }

    if (query.filename) {
      const { rows } = await getPool().query(
        `SELECT id, migration_id, source_file_id, source_filename, state, failure_code, failure_reason,
                destination_file_id, attempt_count
           FROM migration_files WHERE tenant_id = $1 AND source_filename ILIKE $2 LIMIT 50`,
        [principal.tenantId, `%${query.filename}%`],
      );
      results['files'] = rows;
    }

    return results;
  });

  /**
   * Raw source payload for one record (Scope §41). Retained only for the
   * configured window (Scope §30), and gated behind migration.admin because it
   * is the one endpoint that returns unredacted customer data.
   */
  app.get('/admin/migrations/:id/records/:entity/:sourceId/raw', async (request, reply) => {
    const principal = requireStaff(request, reply);
    if (!principal) return;

    const params = z.object({
      id: z.string().uuid(),
      entity: z.enum(ENTITY_TYPES),
      sourceId: z.string(),
    }).parse(request.params);

    const { rows } = await getPool().query(
      `SELECT source_object_id, entity_type, state, disposition, raw_payload, raw_payload_expires_at,
              last_error_code, last_error_message, attempt_count
         FROM migration_records
        WHERE tenant_id = $1 AND migration_id = $2 AND entity_type = $3 AND source_object_id = $4`,
      [principal.tenantId, params.id, params.entity, params.sourceId],
    );

    await migrationsRepo.recordAudit(getPool(), {
      migrationId: params.id, tenantId: principal.tenantId, actorId: principal.userId,
      actorType: 'staff', action: 'migration.retried',
      detail: { viewed_raw_payload: `${params.entity}:${params.sourceId}` },
    });

    if (rows.length === 0) return reply.code(404).send({ error: { code: 'SOURCE_NOT_FOUND', message: 'No such record.' } });
    return { record: rows[0] };
  });

  app.get('/admin/migrations/:id/object-map', async (request, reply) => {
    const principal = requireStaff(request, reply);
    if (!principal) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const { rows } = await getPool().query(
      `SELECT source_object_type, source_object_id, builderlync_object_type, builderlync_object_id,
              migration_status, content_hash, transformer_version, updated_at
         FROM migration_object_map
        WHERE tenant_id = $1 AND migration_id = $2
        ORDER BY source_object_type, source_object_id
        LIMIT 1000`,
      [principal.tenantId, id],
    );
    return { mappings: rows };
  });

  app.get('/admin/migrations/:id/validation', async (request, reply) => {
    const principal = requireStaff(request, reply);
    if (!principal) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return { results: await errorsRepo.listValidationResults(principal.tenantId, id) };
  });

  /** Re-run reconciliation without re-running the migration (Guide §16). */
  app.post('/admin/migrations/:id/revalidate', async (request, reply) => {
    const principal = requireStaff(request, reply);
    if (!principal) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    return { validation: await service.validate(principal, id) };
  });

  app.get('/admin/migrations/:id/manifest', async (request, reply) => {
    const principal = requireStaff(request, reply);
    if (!principal) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    reply.header('content-disposition', `attachment; filename="migration-${id}-manifest.json"`);
    return await service.report(principal, id);
  });
}
