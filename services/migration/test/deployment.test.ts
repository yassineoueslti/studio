import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/**
 * Deployment surface.
 *
 * Everything in this file guards a failure that a green test suite could not
 * see, because the suite runs from source with configuration supplied by the
 * runner. The gap is the gap between "the code is correct" and "an operator
 * can follow the README and end up with a running service" -- and every one of
 * these started as a real defect found by doing exactly that.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');

describe('.env.example', () => {
  /**
   * Parse the example file the way an operator uses it: copy verbatim, start
   * the service. Anything the schema rejects means the documented setup
   * cannot boot.
   *
   * This is not hypothetical -- `.env.example` shipped
   * `DESTINATION_DRIVER=in-memory` against a schema accepting only
   * `sandbox | http`, so following the README produced a service that refused
   * to start on the very first run.
   */
  function parseExample(): Record<string, string> {
    const text = readFileSync(join(repoRoot, '.env.example'), 'utf8');
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    return out;
  }

  it('is accepted verbatim by the configuration schema', () => {
    const example = parseExample();
    expect(Object.keys(example).length).toBeGreaterThan(5);
    // Pass an isolated object, not process.env, so the ambient test
    // configuration cannot paper over a bad example value.
    expect(() => loadConfig(example as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('documents every setting that has no safe default', () => {
    const example = parseExample();
    // A key the operator must set but that the file never mentions is
    // invisible until the service misbehaves in production.
    for (const required of ['DATABASE_URL', 'MIGRATION_SECRET_KEY', 'DESTINATION_DRIVER']) {
      expect(Object.keys(example)).toContain(required);
    }
  });

  it('never ships a real secret', () => {
    const example = parseExample();
    // The example is committed; a populated key here would be a leak.
    expect(example['MIGRATION_SECRET_KEY']).toBe('');
    expect(example['BUILDERLYNC_API_TOKEN']).toBe('');
    expect(example['N8N_MIGRATION_API_TOKEN']).toBe('');
  });
});

describe('.env loading', () => {
  /**
   * The README instructs `cp .env.example services/migration/.env`. For a long
   * time nothing read that file, so every value the operator configured was
   * silently ignored in favour of schema defaults -- a wrong database, and no
   * credential encryption key.
   *
   * Run in a child process: the loader is process-global and caches, so
   * asserting on it in-process would be asserting on whatever the runner
   * already loaded.
   */
  function configIn(envFile: string, extraEnv: Record<string, string> = {}): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
    const path = join(dir, '.env');
    writeFileSync(path, envFile);
    try {
      const script =
        `import { loadConfig } from ${JSON.stringify(join(packageRoot, 'src/config.js'))};` +
        `process.stdout.write(JSON.stringify(loadConfig()));`;
      const out = execFileSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script],
        {
          cwd: packageRoot,
          encoding: 'utf8',
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: process.env['HOME'] ?? '',
            ENV_FILE: path,
            ...extraEnv,
          },
        },
      );
      return JSON.parse(out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('reads settings out of a .env file', () => {
    const config = configIn('DATABASE_URL=postgres://from-file@localhost:5432/db\nPORT=4321\n');
    expect(config['DATABASE_URL']).toBe('postgres://from-file@localhost:5432/db');
    expect(config['PORT']).toBe(4321);
  });

  it('lets a real environment variable win over the file', () => {
    // A container injects its database URL as an environment variable. A
    // stale .env baked into the image must never override it.
    const config = configIn('DATABASE_URL=postgres://from-file@localhost:5432/db\n', {
      DATABASE_URL: 'postgres://from-env@localhost:5432/db',
    });
    expect(config['DATABASE_URL']).toBe('postgres://from-env@localhost:5432/db');
  });

  it('still starts when the file supplies nothing', () => {
    // The container case: everything comes from real environment variables.
    const config = configIn('', { PORT: '5599' });
    expect(config['PORT']).toBe(5599);
  });

  it('fails loudly when ENV_FILE names a file that is not there', () => {
    // Silently falling back to defaults would start the service against the
    // wrong database rather than telling the operator they typed a bad path.
    const dir = mkdtempSync(join(tmpdir(), 'env-test-'));
    let stderr = '';
    try {
      execFileSync(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `import { loadConfig } from ${JSON.stringify(join(packageRoot, 'src/config.js'))};loadConfig();`,
        ],
        {
          cwd: packageRoot,
          encoding: 'utf8',
          stdio: 'pipe',
          env: {
            PATH: process.env['PATH'] ?? '',
            HOME: process.env['HOME'] ?? '',
            ENV_FILE: join(dir, 'does-not-exist'),
          },
        },
      );
      throw new Error('expected loadConfig() to reject a missing ENV_FILE');
    } catch (err) {
      stderr = String((err as { stderr?: string }).stderr ?? '');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(stderr).toMatch(/does not exist/);
  });
});

describe('production configuration', () => {
  const base = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://u:p@db:5432/migration',
    MIGRATION_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
    DESTINATION_DRIVER: 'http',
    BUILDERLYNC_API_BASE_URL: 'https://api.builderlync.example',
  } as unknown as NodeJS.ProcessEnv;

  it('accepts a correctly configured production environment', () => {
    expect(() => loadConfig(base)).not.toThrow();
  });

  it('refuses to run the sandbox destination in production', () => {
    // The sandbox writes into local Postgres tables. Running it in production
    // would accept a customer's entire migration and put it nowhere real.
    expect(() => loadConfig({ ...base, DESTINATION_DRIVER: 'sandbox' })).toThrow(/sandbox/i);
  });

  it('refuses plain HTTP to the destination in production', () => {
    expect(() =>
      loadConfig({ ...base, BUILDERLYNC_API_BASE_URL: 'http://api.builderlync.example' }),
    ).toThrow(/https/i);
  });

  it('refuses to start in production without a credential encryption key', () => {
    const { MIGRATION_SECRET_KEY: _omitted, ...withoutKey } = base as Record<string, string>;
    expect(() => loadConfig(withoutKey as NodeJS.ProcessEnv)).toThrow(/MIGRATION_SECRET_KEY/);
  });

  it('rejects a key that is the wrong length at startup rather than at first use', () => {
    // Encryption only happens when a customer connects a source, which can be
    // hours after deploy.
    expect(() =>
      loadConfig({ ...base, MIGRATION_SECRET_KEY: Buffer.alloc(16, 7).toString('base64') }),
    ).toThrow(/32 bytes/);
  });
});

describe('build artifact', () => {
  /**
   * `package.json` points `main` and `start` at `dist/index.js`. The build
   * previously emitted `dist/src/index.js` -- so `pnpm start` could never work,
   * and the test suite never noticed because everything local runs through
   * `tsx` from source.
   */
  it('builds an entrypoint at the path package.json starts', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.scripts.start).toBe('node dist/index.js');

    // Only assert on a build that exists; `pnpm verify` builds before testing,
    // and a bare `vitest run` should not be forced to compile first.
    if (!existsSync(join(packageRoot, 'dist'))) return;

    expect(existsSync(join(packageRoot, 'dist/index.js'))).toBe(true);
    // Test and demo code must not reach a production artifact.
    expect(existsSync(join(packageRoot, 'dist/test'))).toBe(false);
    expect(existsSync(join(packageRoot, 'dist/scripts'))).toBe(false);
  });

  it('ships the schema migrations the built service reads at startup', () => {
    if (!existsSync(join(packageRoot, 'dist'))) return;
    // migrate.ts resolves its SQL directory relative to the compiled module,
    // and tsc does not copy .sql files. Without the bundling step the service
    // starts and then dies on its first query with ENOENT.
    const source = readFileSync(join(packageRoot, 'src/db/sql/001_init.sql'), 'utf8');
    const shipped = readFileSync(join(packageRoot, 'dist/db/sql/001_init.sql'), 'utf8');
    expect(shipped).toBe(source);
  });
});
