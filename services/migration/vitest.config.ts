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
  },
});
