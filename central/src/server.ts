// The central sync HTTP server. Endpoints match the shop-side transport
// (src/main/sync/httpTransport.ts) exactly, so a real shop talks to this with
// no code change from the dev stub:
//
//   POST /ingest   Bearer <token>  { shopId, rows: [{ seq, table, op, data }] }
//                  -> { ackedSeq }   (highest gap-free seq for the shop)
//   GET  /catalog  Bearer <token>  ?since=<cursor>&limit=<n>
//                  -> { rows: [{ cursor, table, data }], cursor }
//   GET  /health                    -> per-shop last-seen + seq-gap dashboard
//   GET  /                          -> liveness
//
// Connections always originate from the shop; central never dials out. TLS is
// best terminated at a reverse proxy, or set CENTRAL_TLS_KEY/CERT for direct.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { config } from './config.js';
import { authenticate } from './auth.js';
import { ingestBatch, type IngestRow } from './ingest.js';
import { fetchCatalog } from './catalog.js';
import { shopHealth } from './health.js';
import { closePool } from './db.js';

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX = 16 * 1024 * 1024; // 16 MiB cap; batches are ≤500 rows
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

interface IngestRequest { shopId?: string; rows?: unknown }

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/ingest') {
    const shop = await authenticate(req.headers.authorization);
    if (!shop) { send(res, 401, { error: 'unauthorized' }); return; }
    const body = JSON.parse(await readBody(req)) as IngestRequest;
    if (body.shopId && body.shopId !== shop.shopId) {
      send(res, 403, { error: 'shopId does not match authenticated shop' });
      return;
    }
    if (!Array.isArray(body.rows)) { send(res, 400, { error: 'rows[] required' }); return; }
    const ackedSeq = await ingestBatch(shop, body.rows as IngestRow[]);
    send(res, 200, { ackedSeq });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/catalog') {
    const shop = await authenticate(req.headers.authorization);
    if (!shop) { send(res, 401, { error: 'unauthorized' }); return; }
    const since = Number(url.searchParams.get('since') ?? '0');
    const limit = Number(url.searchParams.get('limit') ?? '500');
    send(res, 200, await fetchCatalog(since, limit));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    send(res, 200, { shops: await shopHealth() });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    send(res, 200, { service: 'counter-central', ok: true });
    return;
  }

  send(res, 404, { error: 'not found' });
}

export function createServer(): http.Server {
  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) send(res, 500, { error: message });
    });
  };
  if (config.tls) {
    const opts = { key: fs.readFileSync(config.tls.key), cert: fs.readFileSync(config.tls.cert) };
    return https.createServer(opts, onRequest);
  }
  return http.createServer(onRequest);
}

// Start when run directly (tsx src/server.ts or node dist/server.js).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const server = createServer();
  server.listen(config.port, () => {
    const scheme = config.tls ? 'https' : 'http';
    // eslint-disable-next-line no-console
    console.log(`counter-central listening on ${scheme}://0.0.0.0:${config.port}  (POST /ingest, GET /catalog, GET /health)`);
  });
  const shutdown = (): void => {
    server.close(() => { void closePool().finally(() => process.exit(0)); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
