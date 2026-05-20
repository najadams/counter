// scripts/lib/backup-runner.cjs — pure backup logic, no CLI parsing.
//
// Extracted from scripts/backup.cjs so the Electron main process can call
// the same routine in-process (on shift close) without spawning a Node
// child. The CLI script remains the entry point for cron/Task Scheduler
// runs and is now a thin wrapper around runBackup().
//
// Contract:
//   runBackup({ sourceDir, target, keep, betterSqlite3Path?, now?, logger? })
//   -> { ok: true,  dbDest, photosDest, sizeBytes, usedVacuum, timestamp, prunedCount }
//      { ok: false, error: string, code?: string }
//
// Never throws. Always returns. The caller decides whether to surface the
// failure to the user (shift-close UI) or just log it (nightly cron).

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {{
 *   sourceDir: string,         // e.g. <userData>; expects counter.db + photos/ underneath
 *   target: string,            // backup destination directory
 *   keep?: number,             // retention count, default 14
 *   betterSqlite3Path?: string,// absolute path to better-sqlite3 module (so the
 *                              //   Electron main process can pass its own copy).
 *                              //   If omitted, falls back to plain file copy.
 *   now?: Date,                // injectable clock for tests
 *   logger?: { log: (m: string) => void, warn: (m: string) => void }
 * }} opts
 */
function runBackup(opts) {
  const sourceDir = opts.sourceDir;
  const target = opts.target;
  const keep = Number.isInteger(opts.keep) && opts.keep > 0 ? opts.keep : 14;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const log = (opts.logger && opts.logger.log) || (() => {});
  const warn = (opts.logger && opts.logger.warn) || (() => {});

  if (!sourceDir || typeof sourceDir !== 'string') {
    return { ok: false, error: 'sourceDir is required', code: 'BAD_ARGS' };
  }
  if (!target || typeof target !== 'string') {
    return { ok: false, error: 'target is required', code: 'BAD_ARGS' };
  }

  const sourceDb = path.join(sourceDir, 'counter.db');
  const sourcePhotos = path.join(sourceDir, 'photos');

  if (!fs.existsSync(sourceDb)) {
    return {
      ok: false,
      error: `source DB not found at ${sourceDb}`,
      code: 'NO_SOURCE_DB',
    };
  }

  try {
    if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `cannot create target ${target}: ${errMsg(err)}`,
      code: 'TARGET_UNWRITABLE',
    };
  }

  const ts = isoDate(now); // YYYY-MM-DD
  const dbDest = path.join(target, `counter-${ts}.db`);
  const photosDest = path.join(target, `photos-${ts}`);

  log(`backup: source ${sourceDb}`);
  log(`backup: target ${dbDest}`);

  // 1. SQLite VACUUM INTO via better-sqlite3 (preferred) or fall back to a
  //    plain file copy if the native module isn't available (e.g. the caller
  //    didn't pass betterSqlite3Path, or the module failed to load).
  let usedVacuum = false;
  try {
    if (opts.betterSqlite3Path) {
      const Database = require(opts.betterSqlite3Path);
      const db = new Database(sourceDb, { readonly: true });
      if (fs.existsSync(dbDest)) fs.unlinkSync(dbDest); // VACUUM INTO won't overwrite
      db.exec(`VACUUM INTO '${dbDest.replace(/'/g, "''")}'`);
      db.close();
      usedVacuum = true;
    } else {
      throw new Error('betterSqlite3Path not provided');
    }
  } catch (err) {
    warn(`backup: VACUUM INTO unavailable (${errMsg(err)}), falling back to file copy`);
    try {
      fs.copyFileSync(sourceDb, dbDest);
      // -wal and -shm may hold uncommitted writes; copy them too.
      for (const ext of ['-wal', '-shm']) {
        const src = sourceDb + ext;
        if (fs.existsSync(src)) fs.copyFileSync(src, dbDest + ext);
      }
    } catch (copyErr) {
      return {
        ok: false,
        error: `failed to copy DB: ${errMsg(copyErr)}`,
        code: 'COPY_FAILED',
      };
    }
  }

  // 1b. Integrity check the snapshot. A "successful" VACUUM INTO that wrote
  //     a truncated file (disk full, USB yanked mid-write) would otherwise
  //     leave a corrupt .db on disk and a green heartbeat. PRAGMA quick_check
  //     opens the destination read-only and walks the b-tree; ~10ms on a
  //     small DB, a few seconds on a huge one.
  //
  //     Skipped only when betterSqlite3Path isn't supplied (test scenarios
  //     and the legacy file-copy-only path). Production callers always pass
  //     it, so production always verifies.
  if (opts.betterSqlite3Path) {
    const integrity = verifyBackup(dbDest, opts.betterSqlite3Path);
    if (!integrity.ok) {
      // Delete the corrupt file so a future run isn't fooled by the date stamp.
      try { fs.unlinkSync(dbDest); } catch { /* ignore */ }
      warn(`backup: integrity check failed (${integrity.error}) — destination deleted`);
      return {
        ok: false,
        error: `backup integrity check failed: ${integrity.error}`,
        code: 'INTEGRITY_FAILED',
      };
    }
    log('backup: integrity ok (quick_check)');
  } else {
    warn('backup: integrity check skipped (no betterSqlite3Path supplied)');
  }

  // 2. Copy photos/ recursively (best effort — a photo copy failure shouldn't
  //    invalidate an otherwise-good DB backup).
  if (fs.existsSync(sourcePhotos)) {
    try {
      copyDirSync(sourcePhotos, photosDest);
      log(`backup: copied photos -> ${photosDest}`);
    } catch (err) {
      warn(`backup: photos copy failed (${errMsg(err)}) — continuing without photos`);
    }
  } else {
    log(`backup: no photos directory at ${sourcePhotos}, skipping`);
  }

  // 3. Rolling retention: keep the N most recent counter-*.db (+ matching
  //    photos-*); delete the rest. Best effort — a prune failure doesn't
  //    fail the backup.
  let prunedCount = 0;
  try {
    const entries = fs
      .readdirSync(target)
      .filter((n) => /^counter-\d{4}-\d{2}-\d{2}\.db$/.test(n));
    entries.sort(); // ISO date strings sort chronologically
    const stale = entries.slice(0, Math.max(0, entries.length - keep));
    for (const name of stale) {
      const full = path.join(target, name);
      try {
        fs.unlinkSync(full);
        prunedCount++;
        log(`backup: pruned old ${name}`);
      } catch (e) {
        warn(`backup: prune failed for ${name}: ${errMsg(e)}`);
      }
      const stamp = name.slice('counter-'.length, -'.db'.length);
      const photoBundle = path.join(target, `photos-${stamp}`);
      if (fs.existsSync(photoBundle)) {
        try {
          rmDirSync(photoBundle);
          log(`backup: pruned old photos-${stamp}`);
        } catch (e) {
          warn(`backup: prune failed for photos-${stamp}: ${errMsg(e)}`);
        }
      }
    }
  } catch (err) {
    warn(`backup: retention sweep failed (${errMsg(err)}) — backup itself is fine`);
  }

  // 4. Heartbeat file at <userData>/last_backup.json. The renderer reads this
  //    to clear the home-screen banner.
  //
  //    Atomic write: stage to .tmp then rename. rename() is atomic on the
  //    same filesystem, so readers either see the prior heartbeat or the
  //    new one — never a truncated half-write. This matters because the
  //    shift-close dedup logic treats a parse failure as "no backup today"
  //    and would re-run, which is harmless but wasteful.
  const timestamp = now.toISOString();
  const heartbeatPath = path.join(sourceDir, 'last_backup.json');
  const heartbeatTmp = heartbeatPath + '.tmp';
  try {
    fs.writeFileSync(
      heartbeatTmp,
      JSON.stringify(
        { timestamp, target, dbDest, usedVacuum, keep },
        null,
        2,
      ),
    );
    fs.renameSync(heartbeatTmp, heartbeatPath);
    log(`backup: heartbeat -> ${heartbeatPath}`);
  } catch (err) {
    // A missing heartbeat means the banner stays on, but the backup itself
    // is on disk — we don't fail the whole operation. Surface in the result
    // so the caller can flag it.
    try { fs.unlinkSync(heartbeatTmp); } catch { /* ignore */ }
    warn(`backup: failed to write heartbeat (${errMsg(err)})`);
  }

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(dbDest).size;
  } catch {
    /* non-fatal */
  }

  log(`backup: done (${usedVacuum ? 'VACUUM INTO' : 'file copy'}, retention ${keep} days)`);

  return {
    ok: true,
    dbDest,
    photosDest: fs.existsSync(photosDest) ? photosDest : null,
    sizeBytes,
    usedVacuum,
    timestamp,
    prunedCount,
  };
}

/**
 * Resolve the OS default backup target dir: ~/CounterBackups
 */
function defaultBackupTarget() {
  const os = require('node:os');
  return path.join(os.homedir(), 'CounterBackups');
}

/**
 * Resolve the OS default Counter userData dir. Mirrors Electron's
 * app.getPath('userData') for each platform.
 */
function defaultUserDataDir() {
  const os = require('node:os');
  switch (process.platform) {
    case 'win32':
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
        'Counter',
      );
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Counter');
    default:
      return path.join(
        process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
        'Counter',
      );
  }
}

// --- helpers --------------------------------------------------------------

/**
 * Opens the just-written backup read-only and runs PRAGMA quick_check.
 * A passing check confirms the b-tree is internally consistent — the file
 * is a valid SQLite database with no obvious corruption. Cheap (~10ms) on
 * small DBs.
 *
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function verifyBackup(dbPath, betterSqlite3Path) {
  let Database;
  try {
    Database = require(betterSqlite3Path);
  } catch (err) {
    return { ok: false, error: `cannot load better-sqlite3: ${errMsg(err)}` };
  }
  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { ok: false, error: `cannot open backup: ${errMsg(err)}` };
  }
  try {
    const row = db.prepare('PRAGMA quick_check').get();
    const value = row && (row.quick_check || row['quick_check']);
    if (value === 'ok') return { ok: true };
    return { ok: false, error: `quick_check: ${value || 'unknown result'}` };
  } catch (err) {
    return { ok: false, error: `quick_check threw: ${errMsg(err)}` };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function errMsg(e) {
  return (e && (e.message || String(e))) || 'unknown error';
}

function copyDirSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rmDirSync(dir) {
  if (typeof fs.rmSync === 'function') fs.rmSync(dir, { recursive: true, force: true });
  else fs.rmdirSync(dir, { recursive: true });
}

module.exports = {
  runBackup,
  defaultBackupTarget,
  defaultUserDataDir,
};
