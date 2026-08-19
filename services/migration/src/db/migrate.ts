import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './pool.js';

/**
 * Minimal forward-only SQL migration runner. Files in src/db/sql are applied in
 * filename order and recorded in schema_migrations so re-running is a no-op.
 */

const SQL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'sql');

export async function runMigrations(options: { silent?: boolean } = {}): Promise<string[]> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(SQL_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await pool.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(SQL_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      newlyApplied.push(file);
      if (!options.silent) process.stdout.write(`applied ${file}\n`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }

  if (!options.silent && newlyApplied.length === 0) {
    process.stdout.write('schema up to date\n');
  }
  return newlyApplied;
}

/**
 * Delete all migration and destination-sandbox data. Test-support only; it
 * refuses to run against a production configuration.
 */
export async function truncateAll(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('truncateAll() must never run in production');
  }
  const pool = getPool();
  const { rows } = await pool.query<{ tablename: string }>(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND (tablename LIKE 'migration%' OR tablename LIKE 'bl_%')
  `);
  if (rows.length === 0) return;
  const list = rows.map((r) => `"${r.tablename}"`).join(', ');
  await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

const isEntryPoint = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isEntryPoint) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      process.stderr.write(`${(err as Error).message}\n`);
      process.exit(1);
    });
}
