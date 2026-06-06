// Sync-health severity classifier. Pure — no DOM, no React, importable from
// tests. The renderer's SyncHealthBanner consumes this. Mirrors the backup
// heartbeat (CLAUDE.md §4) and the sync-health buckets in §10 / design B10:
//   not configured            → null (don't nag an un-provisioned shop)
//   provisioned, never synced  → warn only if there is a backlog
//   > 72h since last sync      → danger
//   > 24h since last sync      → warning
//   <= 24h                     → null (healthy)

import type { SyncStatus } from '../types/ipc';
import { formatAge, type Banner } from './backupHeartbeat';

const HOUR_MS = 3_600_000;

function mostRecent(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

export function describeSyncHealth(status: SyncStatus, now: number = Date.now()): Banner | null {
  if (!status.configured) return null;

  const last = mostRecent(status.lastPushAt, status.lastPullAt);
  if (!last) {
    if (status.pendingCount > 0) {
      return {
        severity: 'warn',
        headline: 'Sync has not run yet',
        detail: `${status.pendingCount} change(s) are waiting to reach the central store. Check this shop's internet connection.`,
      };
    }
    return null;
  }

  const ageMs = now - new Date(last).getTime();
  if (ageMs > 72 * HOUR_MS) {
    return {
      severity: 'danger',
      headline: `Last sync ${formatAge(ageMs)} ago — at risk`,
      detail: 'Nothing has reached the central store for over 3 days. Check the connection so reporting stays current.',
    };
  }
  if (ageMs > 24 * HOUR_MS) {
    return {
      severity: 'warn',
      headline: `Last sync ${formatAge(ageMs)} ago`,
      detail: 'Sync is falling behind. Check the connection when convenient.',
    };
  }
  return null;
}
