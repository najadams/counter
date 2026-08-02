import { useState, type FormEvent, type ReactNode } from 'react';
import { counter } from '../lib/ipc';
import { FeedbackBanner } from './FeedbackBanner';
import type { WorkerVerifyCurrentPinResponse } from '../../shared/types/ipc';

interface Props {
  title: string;
  description: string;
  children?: ReactNode;
  buttonLabel?: string;
  className?: string;
  onUnlocked?: () => void;
}

export function PinUnlockPanel({
  title,
  description,
  children,
  buttonLabel = 'Unlock',
  className = '',
  onUnlocked,
}: Props) {
  const [pin, setPin] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pin.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    const r = await counter.verifyCurrentPin(pin);
    setBusy(false);
    if (!r.success) {
      setError(r.error);
      return;
    }
    if (!r.data.ok) {
      setError(pinError(r.data));
      setPin('');
      return;
    }
    setUnlocked(true);
    setPin('');
    onUnlocked?.();
  }

  if (unlocked) return <>{children ?? null}</>;

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className={`bg-bg-surface border border-border p-5 flex flex-col gap-4 ${className}`}
    >
      <div>
        <div className="text-text-secondary uppercase tracking-wider text-xs">{title}</div>
        <p className="text-text-tertiary text-sm mt-2 max-w-2xl">{description}</p>
      </div>
      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      <div className="flex flex-wrap items-center gap-3">
        <input
          autoFocus
          type="password"
          inputMode="numeric"
          maxLength={6}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="PIN"
          className="bg-bg-input border border-border-strong px-3 py-2 font-mono tnum w-32"
        />
        <button
          type="submit"
          disabled={busy || pin.length < 4}
          className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light disabled:opacity-50"
        >
          {busy ? 'Checking...' : buttonLabel}
        </button>
      </div>
    </form>
  );
}

type FailedPinResponse = Extract<WorkerVerifyCurrentPinResponse, { ok: false }>;

function pinError(result: FailedPinResponse): string {
  switch (result.reason) {
    case 'INVALID_PIN':
      return `Wrong PIN. ${result.attemptsRemaining} attempt${result.attemptsRemaining === 1 ? '' : 's'} remaining.`;
    case 'LOCKED_OUT':
      return `Account locked until ${new Date(result.lockedUntil).toLocaleString()}.`;
    case 'UNKNOWN_WORKER':
      return 'This worker account is no longer active.';
    case 'SYSTEM_ROLE_REJECTED':
      return 'SYSTEM cannot unlock protected screens.';
  }
}
