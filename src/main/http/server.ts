// Phase 1 HTTP transport.
//
// Serves the built renderer and exposes every IPC channel over POST /api/<ch>,
// dispatching against the SAME HandlerRegistry the desktop uses — same db,
// same services, same wrap() envelope. The only transport-specific logic here
// is auth: login/logout/get-current go through the bearer-token store (never
// the desktop global), and every other request runs inside requestSession.run
// so requireWorker() sees the token's session.
//
// Phase 1 binds to loopback only; LAN exposure + TLS is Phase 2.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import log from 'electron-log/main';
import type { Database as DB } from 'better-sqlite3';
import { IPC_CHANNELS, type IpcResponse } from '../../shared/types/ipc.js';
import { verifyPin } from '../services/workers.js';
import {
  mintToken, resolveToken, revokeToken, requestSession, type Session,
} from '../ipc/session.js';
import type { HandlerRegistry } from '../ipc/registry.js';

const TOKEN_HEADER = 'x-counter-token';
const MAX_BODY_BYTES = 50 * 1024 * 1024; // generous: breakage photos ride along

export interface HttpServerDeps {
  db: DB;
  deviceId: string;
  registry: HandlerRegistry;
  /** Directory of the built renderer (dist/). Used when proxyTarget is unset. */
  distDir: string;
  host: string;
  port: number;
  /** Dev only: proxy non-API GETs to the vite dev server for one-origin HMR. */
  proxyTarget?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: IpcResponse<unknown>,
  extraHeaders?: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function bearer(req: http.IncomingMessage): string | undefined {
  const h = req.headers['authorization'];
  if (!h) return undefined;
  return h.replace(/^Bearer\s+/i, '');
}

/** Serve a file from distDir, with a path-traversal guard and SPA fallback to
 *  index.html for routes that don't map to a real file. */
function serveStatic(distDir: string, urlPath: string, res: http.ServerResponse): void {
  const rel = decodeURIComponent(urlPath.split('?')[0] || '/');
  const resolved = path.resolve(distDir, '.' + (rel === '/' ? '/index.html' : rel));
  // Containment check: resolved must live under distDir.
  if (resolved !== distDir && !resolved.startsWith(distDir + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const file = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    ? resolved
    : path.join(distDir, 'index.html'); // SPA fallback
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

/** Dev: proxy a GET to the vite dev server so the app and /api share one origin. */
function proxyGet(target: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', target);
  const client = url.protocol === 'https:' ? https : http;
  const upstream = client.request(url, { method: 'GET', headers: req.headers }, (up) => {
    res.writeHead(up.statusCode ?? 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', () => { res.writeHead(502).end('Dev server unreachable'); });
  upstream.end();
}

async function dispatchApi(
  deps: HttpServerDeps,
  channel: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const { db, deviceId, registry } = deps;
  const token = bearer(req);
  const payload = await readBody(req);

  // --- auth channels: owned by the token store, never the desktop global ---
  if (channel === IPC_CHANNELS.WORKER_LOGIN) {
    const { workerId, pin } = (payload ?? {}) as { workerId?: string; pin?: string };
    const result = verifyPin(db, workerId ?? '', pin ?? '', deviceId);
    if (result.ok) {
      const t = mintToken({ workerId: result.workerId, fullName: result.fullName, role: result.role });
      sendJson(res, 200, { success: true, data: result }, { [TOKEN_HEADER]: t });
    } else {
      // Mirror IPC: wrap() returns success:true with the result as data.
      sendJson(res, 200, { success: true, data: result });
    }
    return;
  }
  if (channel === IPC_CHANNELS.WORKER_LOGOUT) {
    revokeToken(token);
    sendJson(res, 200, { success: true, data: { ok: true } });
    return;
  }
  if (channel === IPC_CHANNELS.WORKER_GET_CURRENT) {
    const s = resolveToken(token);
    sendJson(res, 200, {
      success: true,
      data: s ? { workerId: s.workerId, fullName: s.fullName, role: s.role } : { workerId: null },
    });
    return;
  }

  // --- everything else: shared handler, run under the request's session ---
  const fn = registry.handlers.get(channel);
  if (!fn) {
    sendJson(res, 404, { success: false, error: `Unknown channel: ${channel}` });
    return;
  }
  const session: Session = resolveToken(token);
  const out = await requestSession.run({ session }, () =>
    (fn as (e: unknown, p: unknown) => Promise<IpcResponse<unknown>>)({}, payload),
  );
  sendJson(res, 200, out);
}

export function startHttpServer(deps: HttpServerDeps): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    void (async () => {
      try {
        if (req.method === 'POST' && url.startsWith('/api/')) {
          const channel = decodeURIComponent(url.slice('/api/'.length).split('?')[0] || '');
          await dispatchApi(deps, channel, req, res);
          return;
        }
        if (req.method === 'GET') {
          if (deps.proxyTarget) proxyGet(deps.proxyTarget, req, res);
          else serveStatic(deps.distDir, url, res);
          return;
        }
        res.writeHead(405).end('Method not allowed');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[http] ${req.method} ${url}: ${message}`);
        if (!res.headersSent) sendJson(res, 500, { success: false, error: message });
      }
    })();
  });
  server.listen(deps.port, deps.host, () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : deps.port;
    log.info(`[http] listening on http://${deps.host}:${boundPort}` +
      (deps.proxyTarget ? ` (proxying GET -> ${deps.proxyTarget})` : ` (serving ${deps.distDir})`));
  });
  return server;
}
