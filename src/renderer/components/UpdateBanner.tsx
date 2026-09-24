// UpdateBanner — on HomeScreen for owners and supervisors, beside the backup
// and sync banners. Shown when the main process's last update check found a
// newer release (Settings → About has the details). "Remind tomorrow" hides it
// for a day, per version: a newer release shows straight away.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import type { AppAboutResponse } from '../../shared/types/ipc';
import { Button } from './ui/button';

const DISMISS_KEY = 'counter.updateBanner.dismissed';

function dismissedFor(version: string): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? 'null') as { version: string; until: number } | null;
    return !!raw && raw.version === version && Date.now() < raw.until;
  } catch {
    return false;
  }
}

function dismissUntilTomorrow(version: string): void {
  try {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    t.setHours(6, 0, 0, 0);
    localStorage.setItem(DISMISS_KEY, JSON.stringify({ version, until: t.getTime() }));
  } catch {
    /* ignore */
  }
}

export function UpdateBanner(): JSX.Element | null {
  const [about, setAbout] = useState<AppAboutResponse | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await counter.appAbout();
      if (!cancelled && r.success) setAbout(r.data); // fail quiet
    })();
    return () => { cancelled = true; };
  }, []);

  const update = about?.update;
  if (!about || !update || update.status !== 'AVAILABLE' || !update.latestVersion) return null;
  if (hidden || dismissedFor(update.latestVersion)) return null;
  const latest = update.latestVersion;

  return (
    <div role="status" aria-live="polite" className="border border-accent bg-accent/10 rounded px-4 py-3 flex flex-wrap items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm text-accent">
          {about.editionName} {latest} is available. This till runs {update.currentVersion}.
        </div>
        <div className="text-xs text-text-secondary mt-1">
          Install it after closing the day{update.installerName ? ` (${update.installerName})` : ''}. Sales, stock and settings stay as they are. Settings → About has the steps.
        </div>
        {error && <div className="text-xs text-danger mt-1">{error}</div>}
      </div>
      <div className="flex items-center gap-3">
        {about.canOpenDownloadPage && (
          <Button size="sm" variant="primary" type="button"
            onClick={async () => { const r = await counter.appOpenDownloadPage(); if (!r.success) setError(r.error); }}>
            Download page
          </Button>
        )}
        <Button variant="link" className="text-text-secondary hover:text-text-primary whitespace-nowrap text-xs"
          type="button"
          onClick={() => { dismissUntilTomorrow(latest); setHidden(true); }}>
          Remind tomorrow
        </Button>
      </div>
    </div>
  );
}
