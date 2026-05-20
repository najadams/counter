// shiftCloseBackup.ts — decides whether to fire the auto-backup after a
// shift close, and runs it.
//
// Trigger conditions (all must hold):
//   1. Close time (local) hour >= END_OF_BUSINESS_DAY_HOUR. This excludes
//      mid-day/morning closes — only the evening close of the day counts as
//      "the close that wraps up business."
//   2. No backup heartbeat for today's local calendar date. Dedupes if the
//      nightly cron already ran, or if the cashier somehow closes twice in
//      the evening (split shift unusual but possible).
//
// On any failure (backup throws, heartbeat unreadable, etc.) we return a
// ShiftCloseBackupResult — we never throw. The SHIFT_CLOSE IPC handler
// MUST NOT let a backup problem abort the shift close: the live DB already
// has the cash reconciliation written.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { END_OF_BUSINESS_DAY_HOUR } from '../../shared/lib/constants.js';
import type { ShiftCloseBackupResult } from '../../shared/types/ipc.js';

// CommonJS interop — the runner is a .cjs module so the CLI and main share it.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const runner = require('../../../scripts/lib/backup-runner.cjs') as {
  runBackup: (opts: {
    sourceDir: string;
    target: string;
    keep?: number;
    betterSqlite3Path?: string;
    now?: Date;
    logger?: { log: (m: string) => void; warn: (m: string) => void };
  }) => {
    ok: true;
    dbDest: string;
    photosDest: string | null;
    sizeBytes: number;
    usedVacuum: boolean;
    timestamp: string;
    prunedCount: number;
  } | { ok: false; error: string; code?: string };
  defaultBackupTarget: () => string;
};

/**
 * Inputs the trigger needs from the runtime environment. Kept narrow so
 * tests can supply fakes without faking all of Electron.
 */
export interface ShiftCloseBackupDeps {
  /** Counter's userData dir. heartbeat lives at <userData>/last_backup.json. */
  userDataDir: string;
  /** Where backups should land. Default ~/CounterBackups. */
  targetDir?: string;
  /** Absolute path to the better-sqlite3 module for VACUUM INTO. */
  betterSqlite3Path?: string;
  /** Clock injection for tests. */
  now?: Date;
  /** Logger injection. Falls back to console. */
  logger?: { log: (m: string) => void; warn: (m: string) => void };
}

/**
 * Decide + execute. Returns a structured result; never throws.
 */
export function maybeRunShiftCloseBackup(
  deps: ShiftCloseBackupDeps,
): ShiftCloseBackupResult {
  const now = deps.now ?? new Date();

  // 1. Cutover check.
  if (now.getHours() < END_OF_BUSINESS_DAY_HOUR) {
    return { ran: false, skippedReason: 'before-cutover' };
  }

  // 2. Dedup against today's heartbeat.
  if (heartbeatExistsForDate(deps.userDataDir, localDateKey(now))) {
    return { ran: false, skippedReason: 'already-today' };
  }

  // 3. Run.
  const target = deps.targetDir ?? defaultTarget();
  let result: ReturnType<typeof runner.runBackup>;
  try {
    result = runner.runBackup({
      sourceDir: deps.userDataDir,
      target,
      betterSqlite3Path: deps.betterSqlite3Path,
      now,
      logger: deps.logger ?? { log: () => {}, warn: () => {} },
    });
  } catch (err) {
    // The runner is documented not to throw, but defend in depth — a backup
    // failure must not bubble into the shift-close transaction.
    return {
      ran: true,
      ok: false,
      error: errMsg(err),
    };
  }

  if (!result.ok) {
    return { ran: true, ok: false, error: result.error };
  }
  return {
    ran: true,
    ok: true,
    dbDest: result.dbDest,
    sizeBytes: result.sizeBytes,
    target: target,
  };
}

/** Local YYYY-MM-DD for dedup. Uses local time so the cashier's idea of
 *  "today" matches the calendar on the wall, not UTC. */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function heartbeatExistsForDate(userDataDir: string, dateKey: string): boolean {
  const file = path.join(userDataDir, 'last_backup.json');
  if (!fs.existsSync(file)) return false;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as { timestamp?: string };
    if (!parsed.timestamp) return false;
    // Compare on local date, not UTC — the heartbeat's timestamp is ISO
    // (UTC); convert via Date for the local comparison.
    const hbDate = new Date(parsed.timestamp);
    return localDateKey(hbDate) === dateKey;
  } catch {
    // Corrupt heartbeat → treat as "no backup today" so we re-run. Worst
    // case the user gets one extra backup; best case we recover.
    return false;
  }
}

function defaultTarget(): string {
  return runner.defaultBackupTarget();
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
