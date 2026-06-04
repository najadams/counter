// End-to-end Phase 1 HTTP transport: the embedded server dispatching real
// handlers against a real (in-memory) db, with bearer-token sessions. Proves
// the same wrap() envelope, auth special-casing, and requireWorker() path the
// desktop uses also work over fetch.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { HandlerRegistry } from '../src/main/ipc/registry';
import { registerIpcHandlers } from '../src/main/ipc/handlers';
import { startHttpServer } from '../src/main/http/server';
import { IPC_CHANNELS } from '../src/shared/types/ipc';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const DEVICE = 'http-test-device';

let db: ReturnType<typeof Database>;
let server: Server;
let base: string;
let distDir: string;

async function api(channel: string, payload?: unknown, token?: string): Promise<Response> {
  return fetch(`${base}/api/${channel}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload ?? {}),
  });
}

beforeAll(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });

  const registry = new HandlerRegistry(); // headless: no ipcMain, just the map
  registerIpcHandlers(registry, db, DEVICE, { getPath: () => os.tmpdir() });

  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><title>Counter</title>');

  server = startHttpServer({ db, deviceId: DEVICE, registry, distDir, host: '127.0.0.1', port: 0 });
  await new Promise<void>((res) => {
    if (server.listening) res(); else server.once('listening', () => res());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => {
  server?.close();
  db?.close();
  if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
});

describe('HTTP transport', () => {
  it('serves the SPA shell for GET /', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Counter');
  });

  it('handles an unauthenticated channel (ping)', async () => {
    const res = await api(IPC_CHANNELS.PING, { echo: 'hi' });
    const body = await res.json();
    expect(body).toMatchObject({ success: true, data: { pong: true, echo: 'hi' } });
  });

  it('rejects an authed channel with no token', async () => {
    const res = await api(IPC_CHANNELS.WORKER_ADMIN_LIST, {});
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Not authenticated/);
  });

  it('logs in, issues a token in a header, and resolves the session', async () => {
    const res = await api(IPC_CHANNELS.WORKER_LOGIN, { workerId: 'dev-counter-1', pin: '1234' });
    const body = await res.json();
    expect(body).toMatchObject({ success: true, data: { ok: true, workerId: 'dev-counter-1' } });
    const token = res.headers.get('x-counter-token');
    expect(token).toBeTruthy();

    // get-current resolves the token to the worker
    const cur = await (await api(IPC_CHANNELS.WORKER_GET_CURRENT, {}, token!)).json();
    expect(cur.data.workerId).toBe('dev-counter-1');

    // an authed channel now succeeds with the token
    const list = await (await api(IPC_CHANNELS.WORKER_ADMIN_LIST, {}, token!)).json();
    expect(list.success).toBe(true);
    expect(Array.isArray(list.data.workers)).toBe(true);
  });

  it('does not leak the session to a tokenless request (no desktop global)', async () => {
    // After the login above, a request WITHOUT the token must still be anon.
    const cur = await (await api(IPC_CHANNELS.WORKER_GET_CURRENT, {})).json();
    expect(cur.data.workerId).toBeNull();
  });

  it('a bad PIN returns ok:false and no token (mirrors IPC wrap)', async () => {
    const res = await api(IPC_CHANNELS.WORKER_LOGIN, { workerId: 'dev-counter-1', pin: '0000' });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.ok).toBe(false);
    expect(res.headers.get('x-counter-token')).toBeNull();
  });

  it('logout revokes the token', async () => {
    const login = await api(IPC_CHANNELS.WORKER_LOGIN, { workerId: 'dev-counter-1', pin: '1234' });
    const token = login.headers.get('x-counter-token')!;
    await api(IPC_CHANNELS.WORKER_LOGOUT, {}, token);
    const cur = await (await api(IPC_CHANNELS.WORKER_GET_CURRENT, {}, token)).json();
    expect(cur.data.workerId).toBeNull();
  });

  it('404s an unknown channel', async () => {
    const res = await api('does:not-exist', {});
    expect(res.status).toBe(404);
    expect((await res.json()).success).toBe(false);
  });
});
