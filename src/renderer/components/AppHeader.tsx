// Shared top header. Brand on the left, worker/shift status on the right.

import { useSession } from '../store/session';
import { formatMoneyWithCurrency } from '../../shared/lib/money';

export function AppHeader({ subtitle, onBack }: { subtitle?: string; onBack?: () => void }) {
  const worker = useSession((s) => s.workerName);
  const role = useSession((s) => s.workerRole);
  const shiftOpened = useSession((s) => s.shiftOpenedAt);
  const opening = useSession((s) => s.shiftOpeningCashPesewas);

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-border px-5 py-3 sm:px-8 sm:py-5 bg-bg-surface">
      <div className="flex items-center gap-3 sm:gap-4 min-w-0">
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back to home"
            title="Back to home (F9)"
            className="flex items-center gap-1.5 shrink-0 border border-border text-text-secondary hover:text-text-primary hover:bg-bg-elevated px-2.5 py-1.5 text-sm"
          >
            <span aria-hidden>←</span>
            <span className="hidden sm:inline">Back</span>
            <span className="kbd hidden sm:inline">F9</span>
          </button>
        )}
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-accent">Counter</h1>
          {subtitle && <span className="text-text-tertiary text-sm">{subtitle}</span>}
        </div>
      </div>
      {worker && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          {shiftOpened && opening !== null && (
            <div className="flex items-baseline gap-2">
              <span className="text-text-secondary uppercase tracking-wider text-xs">Shift</span>
              <span className="font-mono tnum text-text-primary">
                opened {new Date(shiftOpened).toLocaleTimeString()} · {formatMoneyWithCurrency(opening)}
              </span>
            </div>
          )}
          <div className="flex items-baseline gap-2">
            <span className="text-text-primary">{worker}</span>
            <span className="text-text-tertiary text-xs uppercase tracking-wider">{role}</span>
          </div>
        </div>
      )}
    </header>
  );
}
