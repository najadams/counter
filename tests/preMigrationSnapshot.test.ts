// Pre-migration snapshot — an existing DB is copied aside before pending
// migrations run, so a migration that commits but loses data can be undone
// by restoring one file. See src/main/db/preMigrationSnapshot.ts.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';

const realMigrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');

let tmp: string;
let migrationsDir: string;
let snapshotDir: string;
let db: ReturnType<typeof Database>;

function writeMigration(name: string, sql: string): void {
  fs.writeFileSync(path.join(migrationsDir, name), sql);
}

function snapshots(): string[] {
  return fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir).sort() : [];
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-premig-'));
  migrationsDir = path.join(tmp, 'migrations');
  snapshotDir = path.join(tmp, 'pre-migration-backups');
  fs.mkdirSync(migrationsDir);
  db = new Database(path.join(tmp, 'counter.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pre-migration snapshot', () => {
  it('skips a brand-new database — there is nothing to lose', () => {
    writeMigration('0001_items.sql', 'CREATE TABLE items (id INTEGER PRIMARY KEY, price INTEGER);');

    const result = runMigrations(db, migrationsDir, { snapshotDir });

    expect(result.applied).toEqual(['0001_items.sql']);
    expect(result.snapshot).toBeUndefined();
    expect(fs.existsSync(snapshotDir)).toBe(false);
  });

  it('skips when the database is already up to date', () => {
    writeMigration('0001_items.sql', 'CREATE TABLE items (id INTEGER PRIMARY KEY, price INTEGER);');
    runMigrations(db, migrationsDir, { snapshotDir });

    const result = runMigrations(db, migrationsDir, { snapshotDir });

    expect(result.applied).toEqual([]);
    expect(result.snapshot).toBeUndefined();
    expect(snapshots()).toEqual([]);
  });

  it('keeps the data a committed-but-wrong migration destroyed', () => {
    writeMigration('0001_items.sql', 'CREATE TABLE items (id INTEGER PRIMARY KEY, price INTEGER);');
    runMigrations(db, migrationsDir);
    db.prepare('INSERT INTO items (id, price) VALUES (1, 850), (2, 2200)').run();

    // A table rebuild that forgets to copy the prices across. It succeeds, so
    // the transaction commits — rollback can't help here, only the snapshot.
    writeMigration('0002_rebuild_items.sql', `
      CREATE TABLE items_new (id INTEGER PRIMARY KEY, price INTEGER, sku TEXT);
      INSERT INTO items_new (id) SELECT id FROM items;
      DROP TABLE items;
      ALTER TABLE items_new RENAME TO items;
    `);
    const now = new Date(2026, 8, 23, 7, 5, 9);
    const result = runMigrations(db, migrationsDir, { snapshotDir, now });

    expect(result.applied).toEqual(['0002_rebuild_items.sql']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM items WHERE price IS NULL').get()).toEqual({ n: 2 });

    expect(result.snapshot).toMatchObject({ ok: true, pruned: 0 });
    const file = path.join(snapshotDir, 'counter-before-0002_rebuild_items-20260923-070509.db');
    expect(result.snapshot?.ok && result.snapshot.path).toBe(file);

    const restored = new Database(file, { readonly: true });
    try {
      expect(restored.prepare('SELECT id, price FROM items ORDER BY id').all())
        .toEqual([{ id: 1, price: 850 }, { id: 2, price: 2200 }]);
      expect(restored.prepare('SELECT filename FROM schema_migrations').all())
        .toEqual([{ filename: '0001_items.sql' }]);
    } finally {
      restored.close();
    }
  });

  it('keeps only the three newest snapshots', () => {
    writeMigration('0001_items.sql', 'CREATE TABLE items (id INTEGER PRIMARY KEY);');
    runMigrations(db, migrationsDir);

    for (let n = 2; n <= 6; n++) {
      const name = `000${n}_step.sql`;
      writeMigration(name, `CREATE TABLE step_${n} (id INTEGER);`);
      runMigrations(db, migrationsDir, { snapshotDir, now: new Date(2026, 8, n, 9, 0, 0) });
    }

    expect(snapshots()).toEqual([
      'counter-before-0004_step-20260904-090000.db',
      'counter-before-0005_step-20260905-090000.db',
      'counter-before-0006_step-20260906-090000.db',
    ]);
  });

  it('still migrates when the snapshot cannot be written', () => {
    writeMigration('0001_items.sql', 'CREATE TABLE items (id INTEGER PRIMARY KEY);');
    runMigrations(db, migrationsDir);
    writeMigration('0002_more.sql', 'CREATE TABLE more (id INTEGER);');
    // A file where the directory should be makes mkdir fail.
    fs.writeFileSync(snapshotDir, 'not a directory');

    const result = runMigrations(db, migrationsDir, { snapshotDir });

    expect(result.snapshot?.ok).toBe(false);
    expect(result.applied).toEqual(['0002_more.sql']);
  });

  it('snapshots a real shop schema before the next shipped migration', () => {
    const shipped = fs.readdirSync(realMigrationsDir).filter((f) => f.endsWith('.sql')).sort();
    const last = shipped[shipped.length - 1]!;
    for (const f of shipped.slice(0, -1)) {
      fs.copyFileSync(path.join(realMigrationsDir, f), path.join(migrationsDir, f));
    }
    runMigrations(db, migrationsDir);
    fs.copyFileSync(path.join(realMigrationsDir, last), path.join(migrationsDir, last));

    const result = runMigrations(db, migrationsDir, { snapshotDir });

    expect(result.applied).toEqual([last]);
    expect(result.snapshot?.ok).toBe(true);
    const copy = new Database(result.snapshot?.ok ? result.snapshot.path : '', { readonly: true });
    try {
      const recorded = copy.prepare('SELECT filename FROM schema_migrations').all() as Array<{ filename: string }>;
      expect(recorded).toHaveLength(shipped.length - 1);
      expect(recorded.map((r) => r.filename)).not.toContain(last);
    } finally {
      copy.close();
    }
  });
});
