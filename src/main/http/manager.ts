// Runtime control of the embedded LAN server, so "phone access" can be a toggle
// in Settings instead of a boot-time env var. Starts/stops startHttpServer()
// live and persists the choice in device_config (http_enabled / http_host) so it
// survives a restart. The COUNTER_HTTP / COUNTER_HTTP_HOST env vars still work as
// an override (e.g. dev, or a kiosk that wants it forced on).

import type http from 'node:http';
import log from 'electron-log/main';
import type { Database as DB } from 'better-sqlite3';
import { startHttpServer, getAccessInfo, type HttpServerDeps } from './server.js';
import type { AccessInfoResponse } from '../../shared/types/ipc.js';

/** Everything startHttpServer needs except the host, which the toggle varies. */
export type HttpBaseDeps = Omit<HttpServerDeps, 'host'>;

let base: HttpBaseDeps | null = null;
let db: DB | null = null;
let server: http.Server | null = null;
let host = '127.0.0.1';

export interface HttpStatus {
  enabled: boolean;
  host: string;
  /** Reachable URLs + QR target once listening on the LAN; null otherwise. */
  access: AccessInfoResponse | null;
}

export function initHttpManager(deps: HttpBaseDeps, database: DB): void {
  base = deps;
  db = database;
}

function setCfg(key: string, value: string): void {
  db!.prepare(
    `INSERT INTO device_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
         set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(key, value);
}
function getCfg(key: string): string | undefined {
  return (db!.prepare('SELECT value FROM device_config WHERE key = ?').get(key) as
    | { value: string } | undefined)?.value;
}

export function httpStatus(): HttpStatus {
  return { enabled: server !== null, host, access: getAccessInfo() };
}

function startServer(h: string): void {
  if (!base) throw new Error('http manager not initialized');
  if (server) return;
  host = h;
  server = startHttpServer({ ...base, host: h });
}

function stopServer(): void {
  if (server) {
    server.close(); // stops accepting; mDNS + access info clear on the 'close' event
    server = null;
  }
}

/** Boot autostart: honour the persisted toggle, with the env var as override. */
export function autostartHttp(): void {
  const envOn = process.env['COUNTER_HTTP'] === '1';
  const persisted = getCfg('http_enabled') === '1';
  if (!envOn && !persisted) return;
  startServer(process.env['COUNTER_HTTP_HOST'] ?? getCfg('http_host') ?? '127.0.0.1');
}

/**
 * Runtime toggle from the UI. `lan` exposes on the LAN (0.0.0.0) for phone
 * access; otherwise loopback (this PC only). Persisted so it auto-starts next
 * launch. Returns the fresh status (with access info once listening).
 */
export async function setHttp(enabled: boolean, lan: boolean): Promise<HttpStatus> {
  if (enabled) {
    const h = lan ? '0.0.0.0' : '127.0.0.1';
    stopServer();
    startServer(h);
    setCfg('http_enabled', '1');
    setCfg('http_host', h);
    log.info(`[http] phone access enabled (${h}) via UI`);
    await new Promise((r) => setTimeout(r, 200)); // let listen() populate access info
  } else {
    stopServer();
    setCfg('http_enabled', '0');
    log.info('[http] phone access disabled via UI');
  }
  return httpStatus();
}
