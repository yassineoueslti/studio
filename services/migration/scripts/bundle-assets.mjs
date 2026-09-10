/**
 * Copy non-TypeScript build assets into dist, then assert the artifact is
 * actually runnable.
 *
 * tsc only emits JavaScript. The schema migrations are .sql files read from
 * disk at startup, resolved relative to the *compiled* module
 * (src/db/migrate.ts: `join(dirname(fileURLToPath(import.meta.url)), 'sql')`),
 * so a build without them produces a service that compiles, starts, and then
 * dies on its first query with ENOENT -- in production, on deploy day.
 *
 * The verification at the bottom is the point of this script as much as the
 * copy is: a build that is missing its entrypoint or its migrations should
 * fail here, loudly, on the build machine, rather than in a container three
 * steps later.
 */
import { cp, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcSql = join(packageRoot, 'src', 'db', 'sql');
const distSql = join(packageRoot, 'dist', 'db', 'sql');
const entrypoint = join(packageRoot, 'dist', 'index.js');

await cp(srcSql, distSql, { recursive: true });

const expected = (await readdir(srcSql)).filter((f) => f.endsWith('.sql')).sort();
const shipped = (await readdir(distSql)).filter((f) => f.endsWith('.sql')).sort();

const missing = expected.filter((f) => !shipped.includes(f));
if (missing.length > 0) {
  throw new Error(`build is missing schema migrations: ${missing.join(', ')}`);
}

try {
  await access(entrypoint, constants.R_OK);
} catch {
  throw new Error(
    `build produced no entrypoint at dist/index.js -- package.json "main" and "start" ` +
      `point there. Check rootDir in tsconfig.build.json.`,
  );
}

process.stdout.write(`build ok: dist/index.js + ${shipped.length} schema migration(s)\n`);
