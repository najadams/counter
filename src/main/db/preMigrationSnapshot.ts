// Pre-migration snapshot. Before an upgrade applies new migrations to an
// existing database, copy the database aside so a migration that commits but
// mangles data (a table rebuild that drops a column's values, say) can be
// undone by restoring one file.
//
// A migration that *throws* already rolls back (see migrations.ts), so this
// guards the other case: the one that succeeds and is wrong. Shops can't be
// relied on to take a manual backup before installing an update.
//
// Snapshots live beside the database in <userData>/pre-migration-backups/, not
// in the configured backup target: that may be a USB stick that isn't plugged
// in at boot. This is an undo file, not an off-site backup, so it deliberately
// does NOT write the last_backup.json heartbeat.
//
// Never throws. A failed snapshot must not stop the till from starting — the
// caller logs it and migrates anyway, which is no worse than before this
// existed.

import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as DB } from 'better-sqlite3';

export const PRE_MIGRATION_SNAPSHOT_KEEP = 3;

const SNAPSHOT_PREFIX = 'counter-before-';

export type PreMigrationSnapshotResult =
  | { ok: true; path: string; sizeBytes: number; pruned: number }
  | { ok: false; error: string };

export interface PreMigrationSnapshotOptions {
  /** Directory to write into. Created if missing. */
  dir: string;
  /** Filename of the first migration about to run, e.g. 0055_foo.sql. */
  firstPending: string;
  /** How many snapshots to retain, newest first. */
  keep?: number;
  /** Clock injection for tests. */
  now?: Date;
}

export function snapshotBeforeMigrations(
  db: DB,
  opts: PreMigrationSnapshotOptions,
): PreMigrationSnapshotResult {
  const keep = opts.keep ?? PRE_MIGRATION_SNAPSHOT_KEEP;
  const stem = path.basename(opts.firstPending, '.sql');
  const dest = path.join(opts.dir, `${SNAPSHOT_PREFIX}${stem}-${localStamp(opts.now ?? new Date())}.db`);

  try {
    fs.mkdirSync(opts.dir, { recursive: true });
    if (fs.existsSync(dest)) fs.unlinkSync(dest); // VACUUM INTO won't overwrite
    // VACUUM INTO reads through the live connection, so committed WAL pages
    // are included and the copy is consistent without closing the DB.
    db.prepare('VACUUM INTO ?').run(dest);
    assertSnapshotReadable(dest);
  } catch (err) {
    // Don't leave a truncated file behind looking like a good restore point.
    try { fs.rmSync(dest, { force: true }); } catch { /* best effort */ }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const sizeBytes = fs.statSync(dest).size;
  return { ok: true, path: dest, sizeBytes, pruned: pruneSnapshots(opts.dir, keep) };
}

function assertSnapshotReadable(file: string): void {
  const copy = new Database(file, { readonly: true });
  try {
    const result = copy.pragma('quick_check', { simple: true });
    if (result !== 'ok') throw new Error(`snapshot failed quick_check: ${String(result)}`);
  } finally {
    copy.close();
  }
}

// Names sort chronologically: the migration number only ever grows, and the
// timestamp orders repeat attempts at the same migration.
function pruneSnapshots(dir: string, keep: number): number {
  const snapshots = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith('.db'))
    .sort();
  const stale = snapshots.slice(0, Math.max(0, snapshots.length - keep));
  let pruned = 0;
  for (const f of stale) {
    try {
      fs.unlinkSync(path.join(dir, f));
      pruned++;
    } catch {
      // A locked file (antivirus scan on Windows) is retried next upgrade.
    }
  }
  return pruned;
}

/** Local YYYYMMDD-HHMMSS, so the name matches the clock on the shop wall. */
function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
