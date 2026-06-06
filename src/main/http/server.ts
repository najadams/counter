// Phase 1/2 HTTP transport.
//
// Serves the built renderer and exposes every IPC channel over POST /api/<ch>,
// dispatching against the SAME HandlerRegistry the desktop uses — same db,
// same services, same wrap() envelope. The only transport-specific logic here
// is auth: login/logout/get-current go through the bearer-token store (never
// the desktop global), and every other request runs inside requestSession.run
// so requireWorker() sees the token's session.
//
// Phase 2 hardening: optional LAN bind (with reachable-address logging and a
// cleartext warning), per-IP login rate limiting, per-remote-device PIN
// lockout scoping, and opt-in TLS.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import log from 'electron-log/main';
import type { Database as DB } from 'better-sqlite3';
import { IPC_CHANNELS, type IpcResponse, type AccessInfoResponse } from '../../shared/types/ipc.js';
import { verifyPin } from '../services/workers.js';
import {
  mintToken, resolveToken, revokeToken, requestSession, type Session,
} from '../ipc/session.js';
import type { HandlerRegistry } from '../ipc/registry.js';
import { SlidingWindowLimiter } from './rateLimit.js';
import { Bonjour } from 'bonjour-service';

const TOKEN_HEADER = 'x-counter-token';
const DEVICE_HEADER = 'x-counter-device';
const MAX_BODY_BYTES = 50 * 1024 * 1024; // generous: breakage photos ride along

// Login throttle per client IP: blunts worker-name enumeration and one-PIN-
// many-workers spraying that the per-(worker,device) lockout can't see.
const LOGIN_MAX_PER_WINDOW = 10;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;

// mDNS: advertise a stable name so phones can use http://<name>.local:PORT
// regardless of the DHCP-assigned IP. Configurable for multi-host LANs.
const MDNS_NAME = process.env['COUNTER_MDNS_NAME'] ?? 'counter';

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
  /** Opt-in TLS. When present an https server is created instead of http. */
  tls?: { key: Buffer; cert: Buffer };
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

/** The remote client's self-assigned device id (persisted in its localStorage)
 *  so PIN lockout and audit scope per device, not per host. Validated to a
 *  conservative shape; anything odd is dropped so it can't poison keys. */
function deviceHeader(req: http.IncomingMessage): string | undefined {
  const raw = req.headers[DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value && /^[A-Za-z0-9._-]{8,128}$/.test(value)) return value;
  return undefined;
}

function clientIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
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
  loginLimiter: SlidingWindowLimiter,
  channel: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const { db, registry } = deps;
  const token = bearer(req);
  // Remote device id scopes lockout/audit; fall back to the host id if absent.
  const deviceId = deviceHeader(req) ?? deps.deviceId;
  const payload = await readBody(req);

  // --- auth channels: owned by the token store, never the desktop global ---
  if (channel === IPC_CHANNELS.WORKER_LOGIN) {
    if (!loginLimiter.check(clientIp(req))) {
      sendJson(res, 429, { success: false, error: 'Too many login attempts. Wait a few minutes and try again.' });
      return;
    }
    const { workerId, pin } = (payload ?? {}) as { workerId?: string; pin?: string };
    const result = verifyPin(db, workerId ?? '', pin ?? '', deviceId);
    if (result.ok) {
      const t = mintToken({ workerId: result.workerId, fullName: result.fullName, role: result.role }, deviceId);
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
  const out = await requestSession.run({ session, deviceId }, () =>
    (fn as (e: unknown, p: unknown) => Promise<IpcResponse<unknown>>)({}, payload),
  );
  sendJson(res, 200, out);
}

/** Build reachable URLs from a list of IPs. Pure; unit-tested. */
export function accessUrls(scheme: string, addrs: string[], port: number): string[] {
  return addrs.map((ip) => `${scheme}://${ip}:${port}`);
}

// Snapshot of how the running server can be reached, for the renderer's
// "scan to join" QR. Null until listening; reset on close.
let currentAccessInfo: AccessInfoResponse | null = null;
export function getAccessInfo(): AccessInfoResponse | null {
  return currentAccessInfo;
}

/** Reachable IPv4 addresses for operator-facing "open this URL" logging. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}

export function startHttpServer(deps: HttpServerDeps): http.Server {
  const loginLimiter = new SlidingWindowLimiter(LOGIN_MAX_PER_WINDOW, LOGIN_WINDOW_MS);
  const sweep = setInterval(() => loginLimiter.sweep(), LOGIN_WINDOW_MS);
  sweep.unref?.();
  // `Bonjour` is exported as a value (constructor) via `export =`, so annotate
  // the instance with InstanceType rather than using the binding as a type.
  let bonjour: InstanceType<typeof Bonjour> | undefined;

  const onRequest = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = req.url ?? '/';
    void (async () => {
      try {
        if (req.method === 'POST' && url.startsWith('/api/')) {
          const channel = decodeURIComponent(url.slice('/api/'.length).split('?')[0] || '');
          await dispatchApi(deps, loginLimiter, channel, req, res);
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
  };

  const scheme = deps.tls ? 'https' : 'http';
  const server = deps.tls
    ? https.createServer({ key: deps.tls.key, cert: deps.tls.cert }, onRequest)
    : http.createServer(onRequest);
  server.on('close', () => {
    clearInterval(sweep);
    currentAccessInfo = null;
    try { bonjour?.unpublishAll(() => bonjour?.destroy()); } catch { /* noop */ }
    bonjour = undefined;
  });

  server.listen(deps.port, deps.host, () => {
    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : deps.port;
    const exposed = deps.host === '0.0.0.0' || deps.host === '::';
    log.info(`[http] listening on ${scheme}://${deps.host}:${boundPort}` +
      (deps.proxyTarget ? ` (proxying GET -> ${deps.proxyTarget})` : ` (serving ${deps.distDir})`));

    const urls = exposed ? accessUrls(scheme, lanAddresses(), boundPort) : [];
    let mdnsUrl: string | undefined;

    if (exposed) {
      for (const url of urls) log.info(`[http] reachable on LAN at ${url}`);
      if (!deps.tls) {
        log.warn('[http] bound to the LAN over plain HTTP — PINs and data travel ' +
          'UNENCRYPTED. Use a trusted private network, or supply TLS (COUNTER_HTTPS_KEY/CERT).');
      }
      // Advertise a stable mDNS name so the URL survives DHCP IP changes.
      // Non-fatal: if mDNS can't start, the IP URLs above still work.
      try {
        bonjour = new Bonjour();
        bonjour.publish({ name: 'Counter', type: 'http', port: boundPort, host: `${MDNS_NAME}.local` });
        mdnsUrl = `${scheme}://${MDNS_NAME}.local:${boundPort}`;
        log.info(`[http] mDNS advertising ${mdnsUrl}`);
      } catch (err) {
        log.warn('[http] mDNS advertise failed (non-fatal); use the IP URL:', err);
        bonjour = undefined;
      }
    }

    currentAccessInfo = { exposed, scheme, port: boundPort, urls, mdnsUrl };
  });
  return server as http.Server;
}
