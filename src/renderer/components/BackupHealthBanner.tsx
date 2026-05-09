// BackupHealthBanner — shown on HomeScreen above the action grid.
//
// Reads the heartbeat written by scripts/backup.cjs at <userData>/last_backup.json
// and shows a coloured banner if the most recent backup is stale or missing
// entirely. The user can dismiss it for the day with "remind tomorrow"; that
// preference lives in localStorage so it doesn't survive an app reinstall.
//
// Color rules:
//   never backed up         danger  (red)
//   > 7 days since backup   danger  (red)
//   > 72h since backup      warning (amber)
//   <= 72h                  no banner shown
//
// Wave B.2.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import type { BackupHeartbeat } from '../../shared/types/ipc';

const DISMISS_KEY = 'counter.backupBanner.dismissedUntil';

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

type Severity = 'warn' | 'danger';
interface Banner {
  severity: Severity;
  headline: string;
  detail: string;
}

function describe(heartbeat: BackupHeartbeat): Banner | null {
  if (heartbeat.neverBackedUp || !heartbeat.lastBackupAt) {
    return {
      severity: 'danger',
      headline: 'No off-site backup yet',
      detail:
        'Run the backup script and copy the latest .db file to a USB stick. Without an off-site copy a fire or theft loses everything.',
    };
  }
  const ageMs = Date.now() - new Date(heartbeat.lastBackupAt).getTime();
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
  return null; // healthy, no banner
}

function formatAge(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  if (days >= 1) return days === 1 ? '1 day' : `${days} days`;
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const until = parseInt(raw, 10);
    if (!Number.isFinite(until)) return false;
    return Date.now() < until;
  } catch {
    return false;
  }
}

function dismissUntilTomorrow(): void {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(6, 0, 0, 0); // re-show after 6am the next day
    localStorage.setItem(DISMISS_KEY, String(tomorrow.getTime()));
  } catch {
    /* ignore */
  }
}

export function BackupHealthBanner(): JSX.Element | null {
  const [banner, setBanner] = useState<Banner | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await counter.backupGetHeartbeat();
      if (cancelled) return;
      if (!r.success) return; // fail open — don't pester user with internal errors
      setBanner(describe(r.data));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!banner || hidden || isDismissed()) return null;

  const tone =
    banner.severity === 'danger'
      ? 'border-danger bg-danger/10 text-danger'
      : 'border-warning bg-warning/10 text-warning';

  return (
    <div
      role="status"
      aria-live="polite"
      className={`border ${tone} rounded px-4 py-3 flex items-start gap-3`}
    >
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{banner.headline}</div>
        <div className="text-xs text-text-secondary mt-1">{banner.detail}</div>
      </div>
      <button
        type="button"
        onClick={() => {
          dismissUntilTomorrow();
          setHidden(true);
        }}
        className="text-xs underline text-text-secondary hover:text-text-primary self-start"
        title="Hide this banner until tomorrow morning"
      >
        Remind tomorrow
      </button>
    </div>
  );
}

export default BackupHealthBanner;
