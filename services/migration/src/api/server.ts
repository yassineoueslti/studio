import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SOURCE_PLATFORMS } from '../canonical/common.js';
import { config } from '../config.js';
import { getPool } from '../db/pool.js';
import * as errorsRepo from '../db/repositories/errors.js';
import * as migrationsRepo from '../db/repositories/migrations.js';
import * as recordsRepo from '../db/repositories/records.js';
import { listSources } from '../adapters/registry.js';
import { ENTITY_TYPES, type EntityType } from '../domain/entities.js';
import { ERROR_CODES, MigrationError } from '../domain/errors.js';
import { PermissionDeniedError } from '../domain/permissions.js';
import { IllegalStateTransitionError } from '../domain/states.js';
import { createLogger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import { renderTextReport } from '../reporting/report.js';
import type { MigrationService } from '../service/migration-service.js';
import { requireAuth } from './auth.js';
import { registerIngestionRoutes } from './routes/ingestion.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

/**
 * The migration service HTTP API (Guide §4, Scope §42).
 *
 * Route surface:
 *   /api/migrations/*            customer-facing control plane
 *   /internal/migration/*        bulk ingestion, called by n8n workers
 *   /admin/migrations/*          staff console (Scope §41)
 *   /webhooks/*                  vendor event inbox (Scope §52)
 */

export interface ServerOptions {
  service: MigrationService;
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

const uuidParam = z.object({ id: z.string().uuid() });

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });
  const service = options.service;
  const logger = createLogger({ level: options.logLevel ?? config().LOG_LEVEL });

  // --- error handling -----------------------------------------------------
  // Mapped centrally so every route returns the same error envelope, and so no
  // handler can accidentally leak a stack trace or a credential to a client.
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof PermissionDeniedError) {
      return reply.code(403).send({ error: { code: 'PERMISSION_ERROR', message: error.message, request_id: requestId } });
    }
    if (error instanceof IllegalStateTransitionError) {
      return reply.code(409).send({ error: { code: 'VALIDATION_ERROR', message: error.message, request_id: requestId } });
    }
    if (error instanceof MigrationError) {
      const status = error.code === 'SOURCE_NOT_FOUND' ? 404
        : error.code === 'VALIDATION_ERROR' ? 422
        : error.code === 'AUTHENTICATION_ERROR' ? 401
        : error.code === 'PERMISSION_ERROR' ? 403
        : 500;
      return reply.code(status).send({
        error: { code: error.code, message: error.message, retryable: error.retryable, request_id: requestId },
      });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          request_id: requestId,
        },
      });
    }

    logger.error('Unhandled API error', { request_id: requestId, error: (error as Error)?.message });
    return reply.code(500).send({
      error: { code: 'UNKNOWN_ERROR', message: 'An unexpected error occurred.', request_id: requestId },
    });
  });

  // --- health and observability -------------------------------------------
  app.get('/health', async () => {
    await getPool().query('SELECT 1');
    return { status: 'ok', destination_driver: config().DESTINATION_DRIVER };
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', 'text/plain; version=0.0.4');
    return metrics.render();
  });

  // --- Wizard step 1: source catalogue (Scope §32, §65) -------------------
  app.get('/api/migration-sources', async (request, reply) => {
    if (!requireAuth(request, reply)) return;
    return { sources: listSources() };
  });

  // --- POST /api/migrations ----------------------------------------------
  app.post('/api/migrations', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;

    const body = z.object({
      source_platform: z.enum(SOURCE_PLATFORMS),
      source_tenant_id: z.string().nullish(),
      configuration: z.record(z.string(), z.unknown()).optional(),
    }).parse(request.body);

    const migration = await service.create(principal, {
      sourcePlatform: body.source_platform,
      sourceTenantId: body.source_tenant_id ?? null,
      configuration: body.configuration,
    });

    return reply.code(201).send({ migration });
  });

  app.get('/api/migrations', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    return { migrations: await service.list(principal) };
  });

  app.get('/api/migrations/:id', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return { migration: await service.get(principal, id) };
  });

  // --- POST /api/migrations/{id}/connect ---------------------------------
  app.post('/api/migrations/:id/connect', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);

    const body = z.object({
      credential_type: z.enum(['api_key', 'oauth2', 'basic', 'file_upload', 'none']),
      label: z.string().optional(),
      // The secret is accepted, sealed, and never echoed back.
      secret: z.record(z.string(), z.string()).optional(),
      source_tenant_id: z.string().nullish(),
    }).parse(request.body);

    const migration = await service.get(principal, id);
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO migration_sources (migration_id, tenant_id, source_platform, source_tenant_id, label, connection_status)
       VALUES ($1,$2,$3,$4,$5,'UNTESTED') RETURNING id`,
      [id, principal.tenantId, migration.source_platform, body.source_tenant_id ?? null, body.label ?? null],
    );
    const sourceId = rows[0]?.id as string;

    if (body.secret && body.credential_type !== 'none') {
      const { storeCredential } = await import('../security/crypto.js');
      await storeCredential({
        migrationSourceId: sourceId,
        tenantId: principal.tenantId,
        credentialType: body.credential_type,
        secret: { type: body.credential_type, ...body.secret },
      });
    }

    await migrationsRepo.recordAudit(getPool(), {
      migrationId: id, tenantId: principal.tenantId, actorId: principal.userId,
      action: 'migration.source_connected',
      detail: { credential_type: body.credential_type, migration_source_id: sourceId },
    });

    // Scope §46: the response confirms storage; it never returns the secret.
    return { migration_source_id: sourceId, credential_stored: Boolean(body.secret) };
  });

  app.post('/api/migrations/:id/test-connection', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return { result: await service.testConnection(principal, id) };
  });

  // --- discovery ----------------------------------------------------------
  app.post('/api/migrations/:id/discover', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return { discovery: await service.discover(principal, id) };
  });

  app.get('/api/migrations/:id/discovery', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return { discovery: await service.getDiscovery(principal, id) };
  });

  // --- mappings -----------------------------------------------------------
  app.get('/api/migrations/:id/mappings', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return { mappings: await service.getMappings(principal, id) };
  });

  app.put('/api/migrations/:id/mappings', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    const body = z.record(z.string(), z.unknown()).parse(request.body);
    await service.putMappings(principal, id, body);
    return { mappings: await service.getMappings(principal, id) };
  });

  // --- preflight / lifecycle ---------------------------------------------
  app.get('/api/migrations/:id/preflight', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return await service.preflight(principal, id);
  });

  app.post('/api/migrations/:id/start', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    const body = z.object({ skip_preflight: z.boolean().optional() }).parse(request.body ?? {});

    const result = await service.start(principal, id, { skipPreflight: body.skip_preflight });
    // Preflight failure is a 409, not a 500: nothing broke, the migration is
    // simply not allowed to start yet, and the checks say why.
    if (!result.started) return reply.code(409).send({ started: false, preflight: result.preflight });
    return { started: true };
  });

  app.post('/api/migrations/:id/pause', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    await service.pause(principal, id);
    return { status: 'PAUSED' };
  });

  app.post('/api/migrations/:id/resume', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    await service.resume(principal, id);
    return { status: (await service.get(principal, id)).status };
  });

  app.post('/api/migrations/:id/cancel', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    await service.cancel(principal, id);
    return { status: 'CANCELLED' };
  });

  // --- status / errors / retry -------------------------------------------
  app.get('/api/migrations/:id/status', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return await service.status(principal, id);
  });

  app.get('/api/migrations/:id/errors', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);

    // Scope §35: the dashboard filters.
    const query = z.object({
      entity: z.enum(ENTITY_TYPES).optional(),
      error_code: z.enum(ERROR_CODES).optional(),
      source_id: z.string().optional(),
      retryable: z.coerce.boolean().optional(),
      resolution_status: z.string().optional(),
      limit: z.coerce.number().int().positive().max(1000).optional(),
      offset: z.coerce.number().int().nonnegative().optional(),
    }).parse(request.query ?? {});

    return await service.errors(principal, id, {
      entity: query.entity,
      errorCode: query.error_code,
      sourceId: query.source_id,
      retryable: query.retryable,
      resolutionStatus: query.resolution_status,
      limit: query.limit,
      offset: query.offset,
    });
  });

  app.post('/api/migrations/:id/retry', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    const body = z.object({
      entity: z.enum(ENTITY_TYPES).optional(),
      scope: z.enum(['failed_records', 'failed_batches', 'all']).optional(),
    }).parse(request.body ?? {});

    return await service.retry(principal, id, { entity: body.entity as EntityType | undefined, scope: body.scope });
  });

  // --- validate / report / accept ----------------------------------------
  app.post('/api/migrations/:id/validate', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return { validation: await service.validate(principal, id) };
  });

  app.get('/api/migrations/:id/report', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    const manifest = await service.report(principal, id);

    if ((request.query as { format?: string })?.format === 'text') {
      reply.header('content-type', 'text/plain; charset=utf-8');
      return renderTextReport(manifest);
    }
    return { report: manifest };
  });

  app.post('/api/migrations/:id/accept', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    await service.accept(principal, id);
    return { accepted: true };
  });

  // --- onboarding: passes, checklist, go-live readiness -------------------
  // Added for the Aug 21 delivery model: training runs alongside the
  // historical pass, then a final delta immediately before go-live.

  app.get('/api/migrations/:id/onboarding', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return await service.onboarding.goLiveReadiness(principal, id);
  });

  app.post('/api/migrations/:id/onboarding/checklist', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return { tasks: await service.onboarding.initializeChecklist(principal, id) };
  });

  app.patch('/api/migrations/:id/onboarding/tasks/:taskKey', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const params = z.object({ id: z.string().uuid(), taskKey: z.string().min(1) }).parse(request.params);
    const body = z.object({
      status: z.enum(['PENDING', 'IN_PROGRESS', 'DONE', 'NOT_APPLICABLE']).optional(),
      owner: z.string().nullish(),
      notes: z.string().nullish(),
    }).parse(request.body ?? {});

    return {
      task: await service.onboarding.updateTask(principal, params.id, params.taskKey, {
        status: body.status,
        owner: body.owner ?? null,
        notes: body.notes ?? null,
      }),
    };
  });

  app.get('/api/migrations/:id/passes', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    return { passes: await service.onboarding.listPasses(principal, id) };
  });

  /**
   * Run the final delta immediately before go-live. Distinct from a plain
   * start() so the intent is recorded, the right checklist item closes, and
   * the report can say which pass loaded what.
   */
  app.post('/api/migrations/:id/final-delta', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);

    const result = await service.start(principal, id, { skipPreflight: true, pass: 'FINAL_DELTA' });
    const readiness = await service.onboarding.goLiveReadiness(principal, id);
    return { started: result.started, readiness };
  });

  // --- duplicates (Scope §20 review queue) --------------------------------
  app.get('/api/migrations/:id/duplicates', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    await service.get(principal, id);
    return { candidates: await errorsRepo.listDuplicateCandidates(principal.tenantId, id) };
  });

  app.post('/api/migrations/:id/duplicates/:candidateId', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const params = z.object({ id: z.string().uuid(), candidateId: z.string().uuid() }).parse(request.params);
    const body = z.object({ decision: z.enum(['MERGE', 'CREATE_NEW', 'SKIP']) }).parse(request.body);

    await service.get(principal, params.id);
    await errorsRepo.resolveDuplicate(principal.tenantId, params.candidateId, body.decision, principal.userId);
    return { resolved: true };
  });

  // --- batches / checkpoints / audit --------------------------------------
  app.get('/api/migrations/:id/batches', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    await service.get(principal, id);
    return {
      batches: await recordsRepo.listBatches(principal.tenantId, id),
      checkpoints: await recordsRepo.listCheckpoints(principal.tenantId, id),
    };
  });

  app.get('/api/migrations/:id/audit', async (request, reply) => {
    const principal = requireAuth(request, reply);
    if (!principal) return;
    const { id } = uuidParam.parse(request.params);
    await service.get(principal, id);
    return { audit: await migrationsRepo.listAudit(principal.tenantId, id) };
  });

  registerIngestionRoutes(app);
  registerAdminRoutes(app, service);
  registerWebhookRoutes(app);

  return app;
}
