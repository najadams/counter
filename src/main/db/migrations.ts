// Migration runner. Reads numbered .sql files in lexical order, applies any
// not yet recorded in schema_migrations.
//
// Each migration is wrapped in a transaction. If any statement fails, the
// transaction rolls back and no schema_migrations row is recorded — so the
// next run picks up where we left off.
//
// With `snapshotDir` set, an existing database is copied aside before any
// pending migration runs (see preMigrationSnapshot.ts). A brand-new database
// has nothing to lose, so first-run setup skips it.

import fs from 'node:fs';
import path from 'node:path';
import type { Database as DB } from 'better-sqlite3';
import { snapshotBeforeMigrations, type PreMigrationSnapshotResult } from './preMigrationSnapshot.js';

const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  checksum TEXT NOT NULL
);
`;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  /** Set only when a snapshot was attempted. */
  snapshot?: PreMigrationSnapshotResult;
}

export interface RunMigrationsOptions {
  /** Snapshot an existing DB into this directory before applying migrations. */
  snapshotDir?: string;
  /** Clock injection for tests. */
  now?: Date;
}

export function runMigrations(
  db: DB,
  migrationsDir: string,
  opts: RunMigrationsOptions = {},
): MigrationResult {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }

  db.exec(SCHEMA_MIGRATIONS_DDL);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const appliedSet = new Set(
    db
      .prepare('SELECT filename FROM schema_migrations')
      .all()
      .map((row) => (row as { filename: string }).filename),
  );

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  const firstPending = files.find((f) => !appliedSet.has(f));
  const snapshot = opts.snapshotDir && firstPending && appliedSet.size > 0
    ? snapshotBeforeMigrations(db, { dir: opts.snapshotDir, firstPending, now: opts.now })
    : undefined;

  for (const file of files) {
    if (appliedSet.has(file)) {
      alreadyApplied.push(file);
      continue;
    }

    const fullPath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(fullPath, 'utf8');
    const checksum = simpleChecksum(sql);

    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        'INSERT INTO schema_migrations (filename, checksum) VALUES (?, ?)',
      ).run(file, checksum);
    });

    try {
      tx();
      applied.push(file);
    } catch (err) {
      throw new Error(
        `Migration failed: ${file}. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { applied, alreadyApplied, snapshot };
}

function simpleChecksum(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
