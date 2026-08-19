import { z } from 'zod';

/**
 * Process configuration. Every secret arrives through the environment and is
 * never echoed back through an API response or a log line (Scope §46).
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().min(1).default('postgres://postgres@localhost:5432/builderlync_migration'),

  MIGRATION_SECRET_KEY: z.string().default(''),

  DESTINATION_DRIVER: z.enum(['sandbox', 'http']).default('sandbox'),
  BUILDERLYNC_API_BASE_URL: z.string().default(''),
  BUILDERLYNC_API_TOKEN: z.string().default(''),
  BUILDERLYNC_DESTINATION_API_VERSION: z.string().default('sandbox-v1'),

  RAW_PAYLOAD_RETENTION_DAYS: z.coerce.number().int().nonnegative().default(14),
  FILE_STORAGE_ROOT: z.string().default('./storage'),

  N8N_BASE_URL: z.string().default('http://localhost:5678'),
  N8N_MIGRATION_API_TOKEN: z.string().default(''),

  /** Default records per batch (Scope §28). Adapters may lower this. */
  DEFAULT_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  /** Default concurrent asset transfers (Scope §22). */
  DEFAULT_FILE_CONCURRENCY: z.coerce.number().int().positive().default(4),
});

export type Config = z.infer<typeof schema>;

let cached: Config | null = null;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const config = parsed.data;

  if (config.NODE_ENV === 'production') {
    if (!config.MIGRATION_SECRET_KEY) {
      throw new Error('MIGRATION_SECRET_KEY is required in production (Guide §19: encrypt source credentials at rest).');
    }
    if (config.DESTINATION_DRIVER === 'sandbox') {
      throw new Error('DESTINATION_DRIVER=sandbox is a development/test stand-in and must not run in production.');
    }
  }

  return config;
}

export function config(): Config {
  cached ??= loadConfig();
  return cached;
}

export function resetConfigCache(): void {
  cached = null;
}
