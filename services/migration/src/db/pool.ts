import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export type Sql = pg.Pool | pg.PoolClient;

let pool: pg.Pool | null = null;

/**
 * Postgres numeric/bigint columns arrive as strings by default so that large
 * values survive. Migration counters are bounded well inside Number.MAX_SAFE_
 * INTEGER, and downstream arithmetic (reconciliation) expects numbers, so the
 * two count-bearing types are parsed here rather than at every call site.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number.parseInt(v, 10));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number.parseFloat(v));

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config().DATABASE_URL,
      max: 12,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      // A pooled idle client dying is not fatal; the next checkout reconnects.
      process.stderr.write(`${JSON.stringify({ severity: 'warn', message: 'pg idle client error', error: err.message })}\n`);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Run `fn` inside a transaction. Used wherever a state change must be atomic --
 * most importantly the "claim the batch, write the records, advance the
 * checkpoint" sequence that makes resume-after-crash safe (Scope §27).
 */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the pool will discard it.
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: Sql,
  text: string,
  params: readonly unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return sql.query<T>(text, params as unknown[]);
}
