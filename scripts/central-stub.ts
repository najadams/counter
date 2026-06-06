// Dev-only central ingest stub for Phase 3b push sync. NOT production — the
// real central store is Postgres (see docs/phase3-network-and-sync.md, B6).
// This mimics the contract so you can exercise the shop-side push worker end to
// end on one machine:
//
//   POST /ingest  { shopId, rows: [{ seq, table, op, data }] }
//     -> upserts idempotently by (shopId, table, data.id), records the max seq
//        per shop, returns { ackedSeq }.
//   GET  /state   -> a JSON dump of what's been ingested (for eyeballing).
//
// Run: npx tsx scripts/central-stub.ts   (listens on :4500)

import http from 'node:http';
import { SYNCED_MASTER_TABLES } from '../src/shared/sync.js';

const PORT = Number(process.env['PORT'] ?? 4500);

// shopId -> table -> id -> row   (idempotent: re-ingesting an id is a no-op)
const store = new Map<string, Map<string, Map<string, unknown>>>();
const maxSeq = new Map<string, number>();
// Catalog distribution: every master-table row ingested (from HQ) gets a
// global, monotonic central cursor and is served to shops via GET /catalog.
const MASTER = new Set<string>(SYNCED_MASTER_TABLES);
const catalog: Array<{ cursor: number; table: string; data: { id: string } }> = [];
let catalogSeq = 0;

function ingest(body: { shopId: string; rows: Array<{ seq: number; table: string; data: { id: string } }> }): number {
  const { shopId, rows } = body;
  let shop = store.get(shopId);
  if (!shop) { shop = new Map(); store.set(shopId, shop); }
  let acked = maxSeq.get(shopId) ?? 0;
  for (const r of rows) {
    let tbl = shop.get(r.table);
    if (!tbl) { tbl = new Map(); shop.set(r.table, tbl); }
    if (!tbl.has(r.data.id)) tbl.set(r.data.id, r.data); // upsert-by-id; dup = no-op
    if (MASTER.has(r.table)) catalog.push({ cursor: ++catalogSeq, table: r.table, data: r.data });
    if (r.seq > acked) acked = r.seq;
  }
  maxSeq.set(shopId, acked);
  return acked;
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/ingest') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const ackedSeq = ingest(body);
        // eslint-disable-next-line no-console
        console.log(`[central] shop ${body.shopId}: +${body.rows.length} rows, acked seq ${ackedSeq}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ackedSeq }));
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/catalog')) {
    const u = new URL(req.url, 'http://localhost');
    const since = Number(u.searchParams.get('since') ?? '0');
    const limit = Number(u.searchParams.get('limit') ?? '500');
    const rows = catalog.filter((c) => c.cursor > since).slice(0, limit);
    const cursor = rows.length ? rows[rows.length - 1]!.cursor : since;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rows, cursor }));
    return;
  }
  if (req.method === 'GET' && req.url === '/state') {
    const dump: Record<string, Record<string, number>> = {};
    for (const [shop, tables] of store) {
      dump[shop] = {};
      for (const [t, rows] of tables) dump[shop][t] = rows.size;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rowsByShopTable: dump, maxSeq: Object.fromEntries(maxSeq) }, null, 2));
    return;
  }
  res.writeHead(404).end('Not found');
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`central-stub: POST http://127.0.0.1:${PORT}/ingest  (GET /state to inspect)`);
});
