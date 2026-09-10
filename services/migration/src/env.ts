import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load a `.env` file into the process environment, if one exists.
 *
 * The README tells an operator to `cp .env.example services/migration/.env`,
 * generate a MIGRATION_SECRET_KEY into it, and start the service. Nothing in
 * the codebase read that file. Following the documented setup exactly produced
 * a service that ignored every value the operator had just configured and fell
 * back to the schema defaults -- connecting to the wrong database with no
 * password, and with credential encryption unconfigured.
 *
 * The failure was invisible in CI, because CI passes its configuration through
 * real environment variables, which is the one path that always worked.
 *
 * Precedence is deliberate and matches Node's own `--env-file`: a variable
 * already present in the real environment always wins over the file. A
 * container's injected secrets are never overridden by a `.env` that happened
 * to get baked into an image, and the test suite -- which sets its database
 * through vitest's `env` block -- cannot be redirected by a developer's local
 * `.env` into truncating their development database.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations, nearest first.
 *
 * `here` is `src/` under tsx and `dist/` under a build, so the package root is
 * one level up in both cases. The repo root is included because a single-service
 * checkout is the common case and operators reasonably put `.env` there.
 */
function candidates(): string[] {
  // An explicit ENV_FILE is authoritative: if an operator names a file, that
  // file is the configuration, and quietly falling back to a `.env` they did
  // not mean to use is worse than any error we could raise.
  const explicit = process.env['ENV_FILE'];
  if (explicit) return [explicit];

  const packageRoot = resolve(here, '..');
  const repoRoot = resolve(packageRoot, '..', '..');
  return [join(packageRoot, '.env'), join(repoRoot, '.env')];
}

let checked = false;
let loaded: string | null = null;

/** Returns the path that was loaded, or null when no `.env` was found. */
export function loadDotEnv(): string | null {
  if (checked) return loaded;
  checked = true;

  const explicit = process.env['ENV_FILE'];

  for (const path of candidates()) {
    if (!existsSync(path)) {
      if (explicit) {
        throw new Error(`ENV_FILE points at ${path}, which does not exist.`);
      }
      continue;
    }
    try {
      process.loadEnvFile(path);
      loaded = path;
      return loaded;
    } catch (err) {
      // A malformed .env is an operator error worth surfacing immediately --
      // the alternative is booting with silently-missing configuration.
      throw new Error(`Failed to read ${path}: ${(err as Error).message}`, { cause: err });
    }
  }

  return null;
}

/** Test seam: forget which file was loaded so a new one can be picked up. */
export function resetDotEnvCache(): void {
  checked = false;
  loaded = null;
}
