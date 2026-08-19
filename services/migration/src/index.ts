import { buildServer } from './api/server.js';
import { grantAll } from './api/auth.js';
import { createAdapter } from './adapters/registry.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './observability/logger.js';
import { purgeExpiredRawPayloads } from './db/repositories/records.js';
import { MigrationService } from './service/migration-service.js';

/**
 * Service entry point.
 *
 * Applies pending schema migrations, wires the service, starts the API, and
 * schedules the raw-payload retention sweep (Scope §30).
 */

const logger = createLogger({ level: config().LOG_LEVEL });

async function main(): Promise<void> {
  await runMigrations({ silent: true });

  const service = new MigrationService({
    logger,
    // Real adapters are constructed with credentials loaded from the secrets
    // layer; that wiring lands with the first vendor connector. Until then the
    // registry returns the declared-but-unimplemented PlannedAdapter, which
    // reports its own status rather than pretending to work.
    adapterFor: (platform) => createAdapter(platform),
  });

  const app = buildServer({ service });

  if (config().NODE_ENV === 'development') {
    // A development token so the API is usable from curl immediately. Never
    // registered outside development.
    grantAll('dev-user', 'dev-tenant', 'dev-token');
    logger.info('Development bearer token registered: dev-token (tenant: dev-tenant)');
  }

  const retentionSweep = setInterval(() => {
    purgeExpiredRawPayloads()
      .then((purged) => {
        if (purged > 0) logger.info('Purged expired raw source payloads', { purged });
      })
      .catch((err) => logger.error('Raw payload retention sweep failed', { error: (err as Error).message }));
  }, 60 * 60 * 1000);
  retentionSweep.unref();

  await app.listen({ port: config().PORT, host: '0.0.0.0' });
  logger.info('Migration service listening', {
    port: config().PORT,
    destination_driver: config().DESTINATION_DRIVER,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('Shutting down', { signal });
    clearInterval(retentionSweep);
    await app.close();
    await closePool();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('Failed to start migration service', { error: (err as Error).message });
  process.exit(1);
});
