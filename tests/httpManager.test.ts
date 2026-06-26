// The "Phone access" toggle: the http manager starts/stops the LAN server at
// runtime and persists the choice in device_config. Bound to an ephemeral
// loopback port (host 127.0.0.1, port 0) so the test never conflicts or trips a
// firewall prompt.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import type { HandlerRegistry } from '../src/main/ipc/registry';
import { initHttpManager, autostartHttp, setHttp, httpStatus } from '../src/main/http/manager';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  initHttpManager(
    { db, deviceId: 'test', registry: { handlers: new Map() } as unknown as HandlerRegistry, distDir: '/tmp', port: 0 },
    db,
  );
});
afterEach(async () => { await setHttp(false, false); db.close(); });

const cfg = (k: string): string | undefined =>
  (db.prepare('SELECT value FROM device_config WHERE key = ?').get(k) as { value: string } | undefined)?.value;

describe('http manager (Phone access toggle)', () => {
  it('starts off', () => {
    expect(httpStatus().enabled).toBe(false);
  });

  it('enable starts the server and persists the flag; disable stops it', async () => {
    const on = await setHttp(true, false); // loopback
    expect(on.enabled).toBe(true);
    expect(cfg('http_enabled')).toBe('1');
    expect(cfg('http_host')).toBe('127.0.0.1');

    const off = await setHttp(false, false);
    expect(off.enabled).toBe(false);
    expect(cfg('http_enabled')).toBe('0');
  });

  it('autostart honours the persisted flag', async () => {
    db.prepare(
      `INSERT INTO device_config(key,value) VALUES ('http_enabled','1'),('http_host','127.0.0.1')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    ).run();
    autostartHttp();
    await new Promise((r) => setTimeout(r, 200));
    expect(httpStatus().enabled).toBe(true);
  });

  it('autostart stays off when the flag is not set', () => {
    autostartHttp();
    expect(httpStatus().enabled).toBe(false);
  });
});
