#!/usr/bin/env node
// scripts/backup.cjs — nightly database backup with rolling retention.
//
// Uses SQLite VACUUM INTO to write a consistent snapshot of the live DB
// even if Counter is running. Also copies the photos/ folder. Keeps the
// last 14 backups; older ones are deleted.
//
// Usage:
//   node scripts/backup.cjs                       # default target dir
//   node scripts/backup.cjs C:\Backups            # custom target
//   node scripts/backup.cjs --keep 30 D:\Backups  # custom retention
//
// Schedule via Windows Task Scheduler nightly. Recommend rotating a USB
// stick for off-site storage — local-only backups don't survive theft or fire.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let DEFAULT_KEEP = 14;
let target;
let keep = DEFAULT_KEEP;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--keep' || a === '-k') {
    keep = parseInt(argv[++i], 10);
    if (!Number.isInteger(keep) || keep < 1) {
      console.error(`backup: --keep must be a positive integer`);
      process.exit(2);
    }
  } else if (a === '--help' || a === '-h') {
    console.log(`Usage: node scripts/backup.cjs [--keep N] [target-dir]`);
    process.exit(0);
  } else if (!target) {
    target = a;
  } else {
    console.error(`backup: unexpected argument '${a}'`);
    process.exit(2);
  }
}

target = target || path.join(os.homedir(), 'CounterBackups');

// Live DB path. In production Electron stores the DB at <userData>/counter.db.
// The userData directory varies by OS:
//   Windows  C:\Users\<user>\AppData\Roaming\Counter\counter.db
//   macOS    ~/Library/Application Support/Counter/counter.db
//   Linux    ~/.config/Counter/counter.db
function userDataDir() {
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Counter');
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Counter');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Counter');
  }
}

const sourceDir = userDataDir();
const sourceDb = path.join(sourceDir, 'counter.db');
const sourcePhotos = path.join(sourceDir, 'photos');

if (!fs.existsSync(sourceDb)) {
  console.error(`backup: source DB not found at ${sourceDb}`);
  console.error(`        is Counter installed and has it been launched at least once?`);
  process.exit(1);
}

if (!fs.existsSync(target)) {
  fs.mkdirSync(target, { recursive: true });
}

const ts = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
const dbDest = path.join(target, `counter-${ts}.db`);
const photosDest = path.join(target, `photos-${ts}`);

console.log(`backup: source ${sourceDb}`);
console.log(`backup: target ${dbDest}`);

// 1. SQLite VACUUM INTO via better-sqlite3 (preferred) or fall back to
//    plain file copy if the native module is unavailable for any reason.
let usedVacuum = false;
try {
  const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));
  const db = new Database(sourceDb, { readonly: true });
  // Remove any prior file at dbDest — VACUUM INTO refuses to overwrite.
  if (fs.existsSync(dbDest)) fs.unlinkSync(dbDest);
  db.exec(`VACUUM INTO '${dbDest.replace(/'/g, "''")}'`);
  db.close();
  usedVacuum = true;
} catch (err) {
  console.warn(`backup: VACUUM INTO failed (${err && err.message}), falling back to file copy`);
  fs.copyFileSync(sourceDb, dbDest);
  // The -wal and -shm files may hold uncommitted writes — copy them too.
  for (const ext of ['-wal', '-shm']) {
    const src = sourceDb + ext;
    if (fs.existsSync(src)) fs.copyFileSync(src, dbDest + ext);
  }
}

// 2. Copy photos/ recursively.
if (fs.existsSync(sourcePhotos)) {
  copyDirSync(sourcePhotos, photosDest);
  console.log(`backup: copied photos -> ${photosDest}`);
} else {
  console.log(`backup: no photos directory at ${sourcePhotos}, skipping`);
}

// 3. Rolling retention. Keep the N most recent counter-*.db files (and
//    matching photos-*) and remove anything older.
const entries = fs.readdirSync(target).filter(n => /^counter-\d{4}-\d{2}-\d{2}\.db$/.test(n));
entries.sort();   // ISO date strings sort chronologically
const stale = entries.slice(0, Math.max(0, entries.length - keep));
for (const name of stale) {
  const full = path.join(target, name);
  try {
    fs.unlinkSync(full);
    console.log(`backup: pruned old ${name}`);
  } catch {}
  // Matching photo bundle.
  const stamp = name.slice('counter-'.length, -'.db'.length);
  const photoBundle = path.join(target, `photos-${stamp}`);
  if (fs.existsSync(photoBundle)) {
    rmDirSync(photoBundle);
    console.log(`backup: pruned old photos-${stamp}`);
  }
}

// 4. Write the heartbeat file. The renderer reads this at boot to tell the
//    user when the last off-site backup ran. Path is fixed to <userData>/last_backup.json
//    so the running app can find it without any config.
try {
  const heartbeat = path.join(sourceDir, 'last_backup.json');
  fs.writeFileSync(
    heartbeat,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        target,
        dbDest,
        usedVacuum,
        keep,
      },
      null,
      2,
    ),
  );
  console.log(`backup: heartbeat -> ${heartbeat}`);
} catch (err) {
  console.warn(`backup: failed to write heartbeat (${err && err.message})`);
}

console.log(`backup: done (${usedVacuum ? 'VACUUM INTO' : 'file copy'}, retention ${keep} days)`);

// --- helpers --------------------------------------------------------------

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
  // node 14+ has fs.rmSync; older versions need rmdirSync recursive.
  if (typeof fs.rmSync === 'function') fs.rmSync(dir, { recursive: true, force: true });
  else fs.rmdirSync(dir, { recursive: true });
}
