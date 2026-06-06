// SyncHealthBanner — shown on HomeScreen, below the backup banner. Mirrors
// BackupHealthBanner: reads sync status over IPC, classifies with the pure
// describeSyncHealth, and shows a coloured banner when sync is stale or
// backlogged. Dismissible for the day via localStorage. Silent on shops that
// aren't provisioned for sync (the common single-shop case).

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { describeSyncHealth } from '../../shared/lib/syncHealth';
import type { Banner } from '../../shared/lib/backupHeartbeat';

const DISMISS_KEY = 'counter.syncBanner.dismissedUntil';

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const until = parseInt(raw, 10);
    return Number.isFinite(until) && Date.now() < until;
  } catch {
    return false;
  }
}

function dismissUntilTomorrow(): void {
  try {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(6, 0, 0, 0);
    localStorage.setItem(DISMISS_KEY, String(t.getTime()));
  } catch {
    /* ignore */
  }
}

export function SyncHealthBanner(): JSX.Element | null {
  const [banner, setBanner] = useState<Banner | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await counter.syncGetStatus();
      if (cancelled || !r.success) return; // fail open
      setBanner(describeSyncHealth(r.data));
    })();
    return () => { cancelled = true; };
  }, []);

  if (!banner || hidden || isDismissed()) return null;

  const tone = banner.severity === 'danger'
    ? 'border-danger bg-danger/10 text-danger'
    : 'border-warning bg-warning/10 text-warning';

  return (
    <div role="status" aria-live="polite" className={`border ${tone} rounded px-4 py-3 flex items-start gap-3`}>
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{banner.headline}</div>
        <div className="text-xs text-text-secondary mt-1">{banner.detail}</div>
      </div>
      <button
        type="button"
        onClick={() => { dismissUntilTomorrow(); setHidden(true); }}
        className="text-xs underline text-text-secondary hover:text-text-primary whitespace-nowrap"
      >
        Remind tomorrow
      </button>
    </div>
  );
}
