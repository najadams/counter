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
import { describeHeartbeat, type Banner } from '../../shared/lib/backupHeartbeat';

const DISMISS_KEY = 'counter.backupBanner.dismissedUntil';

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
      setBanner(describeHeartbeat(r.data));
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
