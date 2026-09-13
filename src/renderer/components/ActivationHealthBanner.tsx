// ActivationHealthBanner — shown on HomeScreen alongside the backup and sync
// banners. Surfaces the activation enforcement state (see activation.ts):
//
//   GRACE         real mismatch, counting down. Warning tone, dismissible.
//   RESTRICTED    grace expired, read-only. Danger tone, NOT dismissible —
//                 the shop cannot sell, so hiding the reason helps nobody.
//   INCONCLUSIVE  something is off but the evidence is not trustworthy enough
//                 to act on. Warning tone, dismissible, no countdown, and it
//                 never escalates to read-only.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import type { ActivationStatusResponse } from '../../shared/types/ipc';

const DISMISS_KEY = 'counter.activationBanner.dismissedUntil';

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

export function ActivationHealthBanner({
  onReactivate,
}: {
  onReactivate?: () => void;
}): JSX.Element | null {
  const [status, setStatus] = useState<ActivationStatusResponse | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await counter.activationStatus();
      if (cancelled || !r.success) return; // fail open
      setStatus(r.data);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!status) return null;
  const { state } = status;
  if (state === 'OK' || state === 'UNACTIVATED') return null;

  const restricted = state === 'RESTRICTED';
  // A read-only till is not something to hide behind "remind tomorrow".
  const dismissible = !restricted;
  if (dismissible && (hidden || isDismissed())) return null;

  const tone = restricted
    ? 'border-danger bg-danger/10 text-danger'
    : 'border-warning bg-warning/10 text-warning';

  const headline = restricted
    ? 'Read-only — Counter cannot ring up new sales'
    : state === 'GRACE'
      ? `Activation key does not match this PC — ${status.graceDaysLeft} day${
          status.graceDaysLeft === 1 ? '' : 's'
        } left`
      : 'Could not confirm this PC against the activation key';

  const detail = restricted
    ? 'Shift close, reports and export still work, so you can finish the day and get your books out. To sell again, send the machine code below to your supplier and enter the replacement key.'
    : state === 'GRACE'
      ? 'Counter is working normally for now. When the countdown runs out it goes read-only — no new sales, though shift close and reports keep working. Send the machine code below to your supplier for a replacement key.'
      : 'This PC’s hardware id could not be read, so Counter cannot tell whether the key is genuinely on the wrong machine. Nothing is restricted, and nothing will be.';

  return (
    <div
      role={restricted ? 'alert' : 'status'}
      aria-live="polite"
      className={`border ${tone} rounded px-4 py-3 flex items-start gap-3`}
    >
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-sm">{headline}</div>
        <div className="text-xs text-text-secondary mt-1">{detail}</div>
        <div className="text-xs mt-2">
          Machine code <span className="font-mono font-semibold">{status.machineCode}</span>
        </div>
      </div>
      <div className="flex flex-col gap-2 items-end">
        {onReactivate && (
          <button
            type="button"
            onClick={onReactivate}
            className="text-xs font-semibold underline whitespace-nowrap"
          >
            Enter new key
          </button>
        )}
        {dismissible && (
          <button
            type="button"
            onClick={() => { dismissUntilTomorrow(); setHidden(true); }}
            className="text-xs underline text-text-secondary hover:text-text-primary whitespace-nowrap"
          >
            Remind tomorrow
          </button>
        )}
      </div>
    </div>
  );
}
