// Database connection. One singleton per process.
//
// Why better-sqlite3: synchronous, in-process, no native bindings drama on
// macOS/Windows for the v1 install footprint. WAL gives us all the read
// concurrency we need on a single counter PC.
//
// Logging: console only at this layer, so tests and scripts can import this
// without dragging in Electron. The Electron main entry wires electron-log.

import Database, { type Database as DB } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let db: DB | null = null;

export interface ConnectOptions {
  /** Absolute file path. Pass ':memory:' for tests. */
  filePath: string;
  /** When true, prints every SQL statement. Dev only. */
  verbose?: boolean;
}

export function connect(opts: ConnectOptions): DB {
  if (db) return db;

  if (opts.filePath !== ':memory:') {
    const dir = path.dirname(opts.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(opts.filePath, {
    verbose: opts.verbose ? (msg: unknown) => console.debug('[sql]', String(msg)) : undefined,
  });

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');

  return db;
}

export function getDb(): DB {
  if (!db) throw new Error('DB not connected. Call connect() first.');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function defaultDbPath(userDataDir: string): string {
  return path.join(userDataDir, 'counter.db');
}

/** Resolve the migrations directory regardless of how this file was loaded.
 *  Works for vite-bundled main, tsx scripts, and vitest. */
export function defaultMigrationsDir(): string {
  const startUrl = typeof __dirname === 'string'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
  let cursor = startUrl;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(cursor, 'migrations');
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`Could not locate migrations/ directory from ${startUrl}`);
}
