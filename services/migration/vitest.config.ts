import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The engine's correctness guarantees (idempotency, checkpoint resume) are
    // stateful and share one Postgres database, so suites run serially.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },

    // A fresh clone must be able to run `pnpm test` with nothing but Postgres
    // running.
    //
    // Without this the suites inherit config()'s *development* defaults: they
    // connect to `builderlync_migration` (the dev database) rather than the
    // test one, and every suite dies in beforeAll with a driver-level error
    // -- "client password must be a string" -- that says nothing about the
    // actual cause. Worse, on a machine where the dev database happens to be
    // reachable, the tests would silently TRUNCATE it.
    //
    // Pinning them here makes the test database the only one the suite can
    // ever reach, and makes the whole thing reproducible from a clean
    // checkout. TEST_DATABASE_URL remains the override for CI.
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgres://builderlync:builderlync@localhost:5432/builderlync_migration_test',
      // Dev-only fixed key so the credential-encryption paths are exercised
      // deterministically. Decodes to exactly 32 bytes. Never used outside tests.
      MIGRATION_SECRET_KEY:
        process.env.TEST_MIGRATION_SECRET_KEY ??
        'dGVzdC1vbmx5LWtleS1kby1ub3QtdXNlLWluLXByb2Q=',
      DESTINATION_DRIVER: 'sandbox',
    },
  },
});
