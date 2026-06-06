// Contract tests for the central store. These exercise the real Postgres logic
// (ingest, gap-aware ack, catalog distribution, auth), so they only run when a
// DATABASE_URL is provided — otherwise they skip, keeping `npm test` green on a
// machine with no database.
//
//   docker compose up -d
//   DATABASE_URL=postgres://counter:counter@localhost:5432/counter_central npm test
//
// The suite migrates the schema and truncates between tests, so point it at a
// throwaway database, never production.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HAS_DB = Boolean(process.env['DATABASE_URL']);
const d = HAS_DB ? describe : describe.skip;

d('central store contract', () => {
  // Imported lazily so the module's pool (which requires DATABASE_URL) is only
  // constructed when we actually have a database.
  let pool: typeof import('../src/db.js')['pool'];
  let ingestBatch: typeof import('../src/ingest.js')['ingestBatch'];
  let fetchCatalog: typeof import('../src/catalog.js')['fetchCatalog'];
  let authenticate: typeof import('../src/auth.js')['authenticate'];
  let hashToken: typeof import('../src/auth.js')['hashToken'];

  beforeAll(async () => {
    ({ pool } = await import('../src/db.js'));
    ({ ingestBatch } = await import('../src/ingest.js'));
    ({ fetchCatalog } = await import('../src/catalog.js'));
    ({ authenticate, hashToken } = await import('../src/auth.js'));
    const here = path.dirname(fileURLToPath(import.meta.url));
    const sql = fs.readFileSync(path.join(here, '..', 'src', 'schema.sql'), 'utf8');
    await pool.query(sql);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE shops, sync_ingest_log, ingested_rows, catalog');
    await pool.query("ALTER SEQUENCE catalog_cursor_seq RESTART WITH 1");
    await pool.query(
      `INSERT INTO shops (shop_id, name, token_hash, role) VALUES
         ('osu', 'Osu', $1, 'SHOP'),
         ('hq',  'HQ',  $2, 'HQ')`,
      [hashToken('osu-token'), hashToken('hq-token')],
    );
  });

  const ev = (seq: number, id: string) => ({
    seq, table: 'audit_log', op: 'INSERT' as const, data: { id, action: 'TEST' },
  });

  it('authenticates a valid token and rejects bad/revoked ones', async () => {
    expect(await authenticate('Bearer osu-token')).toEqual({ shopId: 'osu', role: 'SHOP' });
    expect(await authenticate('Bearer nope')).toBeNull();
    expect(await authenticate(undefined)).toBeNull();
    await pool.query("UPDATE shops SET active = false WHERE shop_id = 'osu'");
    expect(await authenticate('Bearer osu-token')).toBeNull();
  });

  it('ingests events idempotently and acks the contiguous seq', async () => {
    const shop = { shopId: 'osu', role: 'SHOP' as const };
    expect(await ingestBatch(shop, [ev(1, 'a'), ev(2, 'b'), ev(3, 'c')])).toBe(3);
    // Re-sending the same batch is a no-op and acks the same watermark.
    expect(await ingestBatch(shop, [ev(1, 'a'), ev(2, 'b'), ev(3, 'c')])).toBe(3);
    const rows = await pool.query("SELECT COUNT(*)::int AS c FROM ingested_rows WHERE shop_id='osu'");
    expect(rows.rows[0].c).toBe(3);
  });

  it('does not ack past a gap', async () => {
    const shop = { shopId: 'osu', role: 'SHOP' as const };
    // seq 3 is missing -> ack stays at 2 even though 4 arrived.
    expect(await ingestBatch(shop, [ev(1, 'a'), ev(2, 'b'), ev(4, 'd')])).toBe(2);
    // The hole fills -> ack jumps to the new contiguous max.
    expect(await ingestBatch(shop, [ev(3, 'c')])).toBe(4);
  });

  it('routes HQ master rows to the catalog and serves them by cursor', async () => {
    const hq = { shopId: 'hq', role: 'HQ' as const };
    const product = { seq: 1, table: 'products', op: 'INSERT' as const, data: { id: 'p1', name: 'Star' } };
    await ingestBatch(hq, [product]);
    const page = await fetchCatalog(0, 500);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({ table: 'products', data: { id: 'p1', name: 'Star' } });
    expect(page.cursor).toBeGreaterThan(0);
    // Pulling past the cursor returns nothing new.
    expect((await fetchCatalog(page.cursor, 500)).rows).toHaveLength(0);
  });

  it('an HQ master UPDATE re-publishes the row with a newer cursor', async () => {
    const hq = { shopId: 'hq', role: 'HQ' as const };
    await ingestBatch(hq, [{ seq: 1, table: 'products', op: 'INSERT', data: { id: 'p1', name: 'Star' } }]);
    const first = (await fetchCatalog(0, 500)).cursor;
    await ingestBatch(hq, [{ seq: 2, table: 'products', op: 'UPDATE', data: { id: 'p1', name: 'Star Lager' } }]);
    const page = await fetchCatalog(first, 500);
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]!.data).toMatchObject({ name: 'Star Lager' });
  });

  it('ignores master rows pushed by a non-HQ shop (seq still logged)', async () => {
    const shop = { shopId: 'osu', role: 'SHOP' as const };
    expect(await ingestBatch(shop, [{ seq: 1, table: 'products', op: 'INSERT', data: { id: 'x' } }])).toBe(1);
    expect((await fetchCatalog(0, 500)).rows).toHaveLength(0);
  });
});
