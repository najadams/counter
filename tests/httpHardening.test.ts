// Phase 2 HTTP hardening: per-IP login rate limiting and per-remote-device
// PIN lockout scoping. Each test gets a fresh server (fresh limiter) and a
// fresh db (clean pin_attempts) so the two concerns don't bleed together.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { PIN_MAX_ATTEMPTS } from '../src/shared/lib/constants';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const DEVICE = 'host-device';

let db: ReturnType<typeof Database>;
let server: Server;
let base: string;
let distDir: string;

function login(pin: string, device?: string): Promise<Response> {
  return fetch(`${base}/api/${IPC_CHANNELS.WORKER_LOGIN}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(device ? { 'x-counter-device': device } : {}),
    },
    body: JSON.stringify({ workerId: 'dev-counter-1', pin }),
  });
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });

  const registry = new HandlerRegistry();
  registerIpcHandlers(registry, db, DEVICE, { getPath: () => os.tmpdir() });

  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-dist-'));
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>');

  server = startHttpServer({ db, deviceId: DEVICE, registry, distDir, host: '127.0.0.1', port: 0 });
  await new Promise<void>((res) => { if (server.listening) res(); else server.once('listening', () => res()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(() => {
  server?.close();
  db?.close();
  if (distDir) fs.rmSync(distDir, { recursive: true, force: true });
});

describe('login rate limiting', () => {
  it('429s once the per-IP login budget is exhausted', async () => {
    // The limiter is 10/window. Drive past it with a device that never locks
    // out at the PIN layer (a long random device id keeps attempts spread —
    // but lockout is irrelevant here; we assert the HTTP 429 path).
    let saw429 = false;
    for (let i = 0; i < 15; i++) {
      const res = await login('0000', `rl-device-${i}`);
      if (res.status === 429) { saw429 = true; break; }
    }
    expect(saw429).toBe(true);
  });
});

describe('per-remote-device PIN lockout', () => {
  it('locks the offending device but leaves another device able to try', async () => {
    // Exhaust device A's PIN attempts.
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await login('0000', 'device-A');
    }
    // Device A is now locked, even with the right PIN.
    const aLocked = await (await login('1234', 'device-A')).json();
    expect(aLocked.data.ok).toBe(false);
    expect(aLocked.data.reason).toBe('LOCKED_OUT');

    // Device B has its own attempt budget — a wrong PIN is INVALID, not LOCKED.
    const bTry = await (await login('0000', 'device-B')).json();
    expect(bTry.data.ok).toBe(false);
    expect(bTry.data.reason).toBe('INVALID_PIN');

    // ...and device B can still log in with the correct PIN.
    const bOk = await login('1234', 'device-B');
    expect((await bOk.json()).data.ok).toBe(true);
    expect(bOk.headers.get('x-counter-token')).toBeTruthy();
  });
});
