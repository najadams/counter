// Pure severity classifier for the sync-health banner.

import { describe, it, expect } from 'vitest';
import { describeSyncHealth } from '../src/shared/lib/syncHealth';
import type { SyncStatus } from '../src/shared/types/ipc';

const HOUR = 3_600_000;
const now = Date.parse('2026-06-05T12:00:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const base: SyncStatus = {
  configured: true, role: 'SHOP', shopId: 'osu', centralUrl: 'http://c',
  lastPushAt: null, lastPullAt: null, pendingCount: 0,
};

describe('describeSyncHealth', () => {
  it('is silent when not configured', () => {
    expect(describeSyncHealth({ ...base, configured: false }, now)).toBeNull();
  });
  it('is silent when configured, never synced, no backlog', () => {
    expect(describeSyncHealth(base, now)).toBeNull();
  });
  it('warns when never synced but there is a backlog', () => {
    expect(describeSyncHealth({ ...base, pendingCount: 5 }, now)?.severity).toBe('warn');
  });
  it('is healthy when the last sync was recent (<24h)', () => {
    expect(describeSyncHealth({ ...base, lastPushAt: ago(2 * HOUR) }, now)).toBeNull();
  });
  it('warns after 24h', () => {
    expect(describeSyncHealth({ ...base, lastPushAt: ago(30 * HOUR) }, now)?.severity).toBe('warn');
  });
  it('is danger after 72h', () => {
    expect(describeSyncHealth({ ...base, lastPullAt: ago(96 * HOUR) }, now)?.severity).toBe('danger');
  });
  it('uses the most recent of push/pull', () => {
    // push is old but a recent pull keeps it healthy
    expect(describeSyncHealth({ ...base, lastPushAt: ago(96 * HOUR), lastPullAt: ago(HOUR) }, now)).toBeNull();
  });
});
