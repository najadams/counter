// Backup heartbeat severity classifier — covers all 4 buckets the
// renderer's BackupHealthBanner depends on. Pure unit tests; no DB.
//
// Ports the prior root-level _verify_backup_heartbeat.mjs scratch file
// into a proper vitest suite. The original scratch script also covered
// the on-disk JSON shape written by scripts/backup.cjs — that's a script
// concern and is left out here; describeHeartbeat operates on the parsed
// BackupHeartbeat IPC type.

import { describe, expect, it } from 'vitest';
import { describeHeartbeat, DAY_MS } from '../src/shared/lib/backupHeartbeat';
import type { BackupHeartbeat } from '../src/shared/types/ipc';

const NOW = new Date('2026-05-19T10:00:00.000Z').getTime();

function heartbeatAt(daysAgo: number): BackupHeartbeat {
  return {
    lastBackupAt: new Date(NOW - daysAgo * DAY_MS).toISOString(),
    target: '/Users/u/CounterBackups/counter-2026-05-15.db',
    usedVacuum: true,
    neverBackedUp: false,
  };
}

describe('describeHeartbeat', () => {
  it('returns danger when neverBackedUp is true', () => {
    const b = describeHeartbeat({
      lastBackupAt: null, target: null, usedVacuum: null, neverBackedUp: true,
    }, NOW);
    expect(b?.severity).toBe('danger');
    expect(b?.headline).toMatch(/No off-site backup/i);
  });

  it('returns danger when lastBackupAt is null (defensive)', () => {
    const b = describeHeartbeat({
      lastBackupAt: null, target: null, usedVacuum: null, neverBackedUp: false,
    }, NOW);
    expect(b?.severity).toBe('danger');
  });

  it('returns null when backup is fresh (<= 72h)', () => {
    expect(describeHeartbeat(heartbeatAt(0), NOW)).toBeNull();
    expect(describeHeartbeat(heartbeatAt(1), NOW)).toBeNull();
    expect(describeHeartbeat(heartbeatAt(3), NOW)).toBeNull();
  });

  it('returns warn for 72h–7d window', () => {
    const b = describeHeartbeat(heartbeatAt(4), NOW);
    expect(b?.severity).toBe('warn');
    expect(b?.headline).toMatch(/4 days/);
  });

  it('returns warn at the 7-day boundary (exactly 7d → still warn)', () => {
    // 7 * DAY_MS is exactly the boundary; only > 7d trips danger.
    const b = describeHeartbeat(heartbeatAt(7), NOW);
    expect(b?.severity).toBe('warn');
  });

  it('returns danger when > 7 days old', () => {
    const b = describeHeartbeat(heartbeatAt(8), NOW);
    expect(b?.severity).toBe('danger');
    expect(b?.headline).toMatch(/at risk/i);
  });

  it('returns danger when > 30 days old', () => {
    const b = describeHeartbeat(heartbeatAt(30), NOW);
    expect(b?.severity).toBe('danger');
    expect(b?.headline).toMatch(/30 days/);
  });

  it('formats age in hours when less than a day', () => {
    // 4-day-ish boundary uses hours arithmetic; check 3d+1h still warn-formatted.
    const ts = new Date(NOW - (3 * DAY_MS + 3_600_000)).toISOString();
    const b = describeHeartbeat({
      lastBackupAt: ts, target: 't', usedVacuum: true, neverBackedUp: false,
    }, NOW);
    expect(b?.severity).toBe('warn');
    expect(b?.headline).toMatch(/3 days/);
  });
});
