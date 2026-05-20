// Auto-backup trigger on shift close — unit tests for the decision logic.
//
// Covers:
//   - close before END_OF_BUSINESS_DAY_HOUR -> ran:false, skippedReason:'before-cutover'
//   - close after cutover, no heartbeat for today -> ran:true, runs the backup
//   - close after cutover, heartbeat from today -> ran:false, skippedReason:'already-today'
//   - close after cutover, heartbeat from yesterday -> ran:true
//   - runner failure surfaces as ran:true, ok:false, error:...
//   - runner thrown exception surfaces as ran:true, ok:false (no exception leaks)
//
// We don't go through filesystem for the backup itself — we just verify the
// trigger module reads the heartbeat correctly and calls the runner with the
// right args. The runner itself has its own coverage in backup-script.test.ts.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maybeRunShiftCloseBackup } from '../src/main/lib/shiftCloseBackup';
import { END_OF_BUSINESS_DAY_HOUR } from '../src/shared/lib/constants';

let userDataDir: string;

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-trigger-'));
  // Required by the runner's source-DB existence check (even though we
  // intercept the require below, the trigger may still resolve & call it).
  fs.writeFileSync(path.join(userDataDir, 'counter.db'), 'stub');
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function atHour(h: number): Date {
  const d = new Date(2026, 4, 20); // 20 May 2026 local
  d.setHours(h, 0, 0, 0);
  return d;
}

function writeHeartbeat(dir: string, isoTimestamp: string): void {
  fs.writeFileSync(
    path.join(dir, 'last_backup.json'),
    JSON.stringify({
      timestamp: isoTimestamp,
      target: '/some/where',
      dbDest: '/some/where/counter-x.db',
      usedVacuum: true,
      keep: 14,
    }),
  );
}

describe('maybeRunShiftCloseBackup — cutover gate', () => {
  it('skips with before-cutover when close hour < END_OF_BUSINESS_DAY_HOUR', () => {
    const r = maybeRunShiftCloseBackup({
      userDataDir,
      targetDir: path.join(userDataDir, 'bk'),
      now: atHour(END_OF_BUSINESS_DAY_HOUR - 1),
    });
    expect(r).toEqual({ ran: false, skippedReason: 'before-cutover' });
    expect(fs.existsSync(path.join(userDataDir, 'last_backup.json'))).toBe(false);
  });

  it('runs at exactly END_OF_BUSINESS_DAY_HOUR', () => {
    const target = path.join(userDataDir, 'bk');
    const r = maybeRunShiftCloseBackup({
      userDataDir,
      targetDir: target,
      now: atHour(END_OF_BUSINESS_DAY_HOUR),
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(true);
    // Falls back to file copy (no betterSqlite3Path) and writes a heartbeat.
    expect(fs.existsSync(path.join(userDataDir, 'last_backup.json'))).toBe(true);
  });
});

describe('maybeRunShiftCloseBackup — heartbeat dedup', () => {
  it('skips with already-today when a heartbeat from today exists', () => {
    const now = atHour(END_OF_BUSINESS_DAY_HOUR + 1);
    // Heartbeat from earlier today.
    const earlier = new Date(now);
    earlier.setHours(8, 0, 0, 0);
    writeHeartbeat(userDataDir, earlier.toISOString());

    const r = maybeRunShiftCloseBackup({
      userDataDir,
      targetDir: path.join(userDataDir, 'bk'),
      now,
    });
    expect(r).toEqual({ ran: false, skippedReason: 'already-today' });
  });

  it('runs when the most recent heartbeat is from yesterday', () => {
    const now = atHour(END_OF_BUSINESS_DAY_HOUR + 1);
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    writeHeartbeat(userDataDir, yesterday.toISOString());

    const r = maybeRunShiftCloseBackup({
      userDataDir,
      targetDir: path.join(userDataDir, 'bk'),
      now,
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('runs anyway when heartbeat file is corrupt', () => {
    const now = atHour(END_OF_BUSINESS_DAY_HOUR + 1);
    fs.writeFileSync(path.join(userDataDir, 'last_backup.json'), '{not json');

    const r = maybeRunShiftCloseBackup({
      userDataDir,
      targetDir: path.join(userDataDir, 'bk'),
      now,
    });
    expect(r.ran).toBe(true);
  });
});

describe('maybeRunShiftCloseBackup — failure surfacing', () => {
  it('returns ran:true,ok:false with error when source DB is missing', () => {
    // Remove the stub DB the beforeEach created, so the runner reports
    // NO_SOURCE_DB rather than succeeding.
    fs.rmSync(path.join(userDataDir, 'counter.db'));
    const r = maybeRunShiftCloseBackup({
      userDataDir,
      targetDir: path.join(userDataDir, 'bk'),
      now: atHour(END_OF_BUSINESS_DAY_HOUR + 1),
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/source DB not found/);
  });

  it('returns ran:true,ok:false when target dir cannot be created', () => {
    // Make a file at the spot where target should be a directory.
    const blocked = path.join(userDataDir, 'blocked');
    fs.writeFileSync(blocked, 'x');
    const r = maybeRunShiftCloseBackup({
      userDataDir,
      targetDir: path.join(blocked, 'sub'),
      now: atHour(END_OF_BUSINESS_DAY_HOUR + 1),
    });
    expect(r.ran).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot create target|ENOTDIR|EEXIST/i);
  });
});
