// Settings → About: which Counter this is, and whether a newer one is out.
//
// The check itself runs in the main process against the project's GitHub
// releases (src/main/services/updateCheck.ts). Nothing is downloaded here: the
// owner opens the release page on the shop PC, gets the installer for this
// edition and runs it over the old one (CLAUDE.md §16).

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import type { AppAboutResponse, AppUpdateInfo } from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';

const PLATFORM_NAMES: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function AboutTab() {
  const [about, setAbout] = useState<AppAboutResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await counter.appAbout();
      if (r.success) setAbout(r.data); else setError(r.error);
    })();
  }, []);

  async function checkNow() {
    setChecking(true); setError(null);
    const r = await counter.appCheckForUpdate();
    setChecking(false);
    if (!r.success) { setError(r.error); return; }
    setAbout((a) => (a ? { ...a, update: r.data } : a));
  }

  async function openDownloadPage() {
    const r = await counter.appOpenDownloadPage();
    if (!r.success) setError(r.error);
  }

  if (!about) {
    return error ? <FeedbackBanner>{error}</FeedbackBanner> : <p className="text-sm text-text-tertiary">Loading…</p>;
  }
  const update = about.update;

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{about.editionName}</CardTitle>
          <CardDescription>The till software on this computer.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-text-secondary">Version</dt>
            <dd className="font-mono tnum">{about.version}</dd>
            <dt className="text-text-secondary">Computer</dt>
            <dd>{PLATFORM_NAMES[about.platform] ?? about.platform} ({about.arch})</dd>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Updates <UpdateBadge update={update} />
          </CardTitle>
          <CardDescription>
            Counter looks for a new version twice a day when the computer is online. It downloads nothing by itself.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {update?.status === 'AVAILABLE' && update.latestVersion ? (
            <div className="flex flex-col gap-3">
              <p className="text-base font-semibold">
                Version <span className="font-mono tnum">{update.latestVersion}</span> is available
                {update.releasedAt ? ` (released ${new Date(update.releasedAt).toLocaleDateString([], { dateStyle: 'medium' })})` : ''}.
                This till runs <span className="font-mono tnum">{update.currentVersion}</span>.
              </p>
              <ol className="list-decimal space-y-1 pl-5 text-sm text-text-secondary">
                <li>Close the day and back up (Backups tab). Copy the backup to a USB stick.</li>
                <li>
                  On the download page, get{' '}
                  {update.installerName
                    ? <span className="font-mono text-text-primary">{update.installerName}</span>
                    : <>the {about.editionName} installer for {PLATFORM_NAMES[about.platform] ?? about.platform}</>}
                  .
                </li>
                <li>Close Counter, run the installer, then open Counter again.</li>
              </ol>
              <p className="text-sm text-text-secondary">
                Sales, stock, customers and settings stay as they are. Counter saves a copy of the database before it updates it.
              </p>
              {about.canOpenDownloadPage
                ? <Button variant="primary" className="self-start" onClick={() => void openDownloadPage()}>Open download page</Button>
                : <p className="text-sm text-text-tertiary">Open the download page on the shop PC.</p>}
              {update.notes && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-text-secondary">Release notes</summary>
                  <p className="mt-2 whitespace-pre-line text-text-secondary">{update.notes}</p>
                </details>
              )}
            </div>
          ) : update?.status === 'UP_TO_DATE' ? (
            <p className="text-sm">This is the latest version.</p>
          ) : (
            <p className="text-sm text-text-secondary">
              {update?.error
                ? 'Couldn’t check for updates. The computer may be offline; Counter will try again later.'
                : 'Not checked yet. Counter checks shortly after it starts.'}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-text-tertiary">
            <Button size="sm" onClick={() => void checkNow()} disabled={checking}>
              {checking ? 'Checking…' : 'Check now'}
            </Button>
            <span>Last checked {formatWhen(update?.checkedAt ?? null)}</span>
            {update?.error && <span>· last attempt: {update.error}</span>}
          </div>
          {error && <FeedbackBanner>{error}</FeedbackBanner>}
        </CardContent>
      </Card>
    </div>
  );
}

function UpdateBadge({ update }: { update: AppUpdateInfo | null }) {
  if (update?.status === 'AVAILABLE') return <Badge tone="accent">Update available</Badge>;
  if (update?.status === 'UP_TO_DATE') return <Badge tone="success">Up to date</Badge>;
  return <Badge>Not known</Badge>;
}
