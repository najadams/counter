// Postgres access: a shared pool, a typed query helper, and a transaction
// wrapper. node-pg returns bigint as a string to avoid precision loss; callers
// that need a JS number (seqs, cursors — all well within Number.MAX_SAFE_INTEGER
// at this app's scale) Number() it explicitly.

import pg from 'pg';
import { requireDatabaseUrl } from './config.js';

const { Pool } = pg;

export const pool = new Pool({ connectionString: requireDatabaseUrl() });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

/** Run `fn` inside a single transaction; COMMIT on success, ROLLBACK on throw. */
export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
