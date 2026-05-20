#!/usr/bin/env node
// scripts/backup.cjs — nightly database backup CLI.
//
// Thin wrapper around scripts/lib/backup-runner.cjs. The actual logic
// (VACUUM INTO, photos copy, retention, heartbeat) lives in the runner so
// the Electron main process can call it directly on shift close without
// spawning a Node child.
//
// Usage:
//   node scripts/backup.cjs                       # default target dir
//   node scripts/backup.cjs C:\Backups            # custom target
//   node scripts/backup.cjs --keep 30 D:\Backups  # custom retention
//
// Schedule via Task Scheduler (Windows) / launchd (macOS) / cron (Linux).
// USB sticks should be rotated for off-site storage — a backup that lives
// on the same machine as the DB does not survive theft or fire.

'use strict';

const path = require('node:path');
const { runBackup, defaultBackupTarget, defaultUserDataDir } = require('./lib/backup-runner.cjs');

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

target = target || defaultBackupTarget();

const result = runBackup({
  sourceDir: defaultUserDataDir(),
  target,
  keep,
  // Use the project's locally-installed better-sqlite3 so VACUUM INTO works.
  betterSqlite3Path: path.join(__dirname, '..', 'node_modules', 'better-sqlite3'),
  logger: { log: console.log, warn: console.warn },
});

if (!result.ok) {
  console.error(`backup: ${result.error}`);
  if (result.code === 'NO_SOURCE_DB') {
    console.error(`        is Counter installed and has it been launched at least once?`);
  }
  process.exit(1);
}
