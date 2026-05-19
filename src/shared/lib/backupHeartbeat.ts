// Backup heartbeat severity classifier. Pure — no DOM, no React, safe to
// import from tests. The renderer's BackupHealthBanner consumes this to
// decide what to show.
//
// Buckets per CLAUDE.md §4:
//   never backed up         → danger
//   > 7 days since backup   → danger
//   > 72h (3d) since backup → warning
//   ≤ 72h                   → null (healthy, no banner)

import type { BackupHeartbeat } from '../types/ipc';

const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export type Severity = 'warn' | 'danger';

export interface Banner {
  severity: Severity;
  headline: string;
  detail: string;
}

export function describeHeartbeat(
  heartbeat: BackupHeartbeat,
  now: number = Date.now(),
): Banner | null {
  if (heartbeat.neverBackedUp || !heartbeat.lastBackupAt) {
    return {
      severity: 'danger',
      headline: 'No off-site backup yet',
      detail:
        'Run the backup script and copy the latest .db file to a USB stick. Without an off-site copy a fire or theft loses everything.',
    };
  }
  const ageMs = now - new Date(heartbeat.lastBackupAt).getTime();
  if (ageMs > 7 * DAY_MS) {
    return {
      severity: 'danger',
      headline: `Last off-site backup: ${formatAge(ageMs)} ago — at risk`,
      detail: 'Backups have not run for over a week. Plug the USB in and run the backup tonight.',
    };
  }
  if (ageMs > 3 * DAY_MS) {
    return {
      severity: 'warn',
      headline: `Last off-site backup: ${formatAge(ageMs)} ago`,
      detail: 'Take the USB stick home tonight. Recommended cadence is daily.',
    };
  }
  return null;
}

export function formatAge(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  if (days >= 1) return days === 1 ? '1 day' : `${days} days`;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}
