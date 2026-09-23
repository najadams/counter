// Shared top header. Brand on the left, worker/shift status on the right.
//
// `onBack` adds the return button. Its label must describe where it goes:
// the default is "Home" (every HomeScreen child); callers that return
// somewhere else pass `backLabel` (e.g. "Back to customers"). F9 stays the
// keyboard shortcut either way — the screens own that handler.

import { ArrowLeftIcon } from 'lucide-react';
import { useSession } from '../store/session';
import { formatMoneyWithCurrency } from '../../shared/lib/money';
import { FRIENDLY_UI_ENABLED } from '../../shared/lib/buildFlags';
import { TaskIllustration } from './friendly/TaskIllustration';
import { Button } from './ui/button';

export function AppHeader({ subtitle, onBack, backLabel = 'Home', backDisabled = false }: {
  subtitle?: string;
  onBack?: () => void;
  /** Where the return button goes. Defaults to "Home". */
  backLabel?: string;
  backDisabled?: boolean;
}) {
  const worker = useSession((s) => s.workerName);
  const role = useSession((s) => s.workerRole);
  const shiftOpened = useSession((s) => s.shiftOpenedAt);
  const opening = useSession((s) => s.shiftOpeningCashPesewas);
  const goesHome = backLabel === 'Home';

  if (FRIENDLY_UI_ENABLED) {
    return (
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border px-4 py-3 sm:px-8 bg-bg-surface">
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              disabled={backDisabled}
              title={`${backLabel} (F9)`}
              className="flex items-center gap-3 shrink-0 min-h-14 rounded-2xl border-2 border-accent bg-bg-elevated text-text-primary pl-2 pr-4 py-1.5 text-xl font-semibold hover:bg-bg-deep"
            >
              {goesHome
                ? <TaskIllustration name="home" size={44} />
                : <ArrowLeftIcon aria-hidden="true" className="size-8 mx-1.5" />}
              <span>{backLabel}</span>
              <span aria-hidden className="hidden sm:inline-flex"><span className="kbd">F9</span></span>
            </button>
          )}
          <div className="flex flex-wrap items-baseline gap-3 min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-accent">Counter</h1>
            {subtitle && <span className="text-text-secondary text-lg first-letter:uppercase">{subtitle}</span>}
          </div>
        </div>
        {worker && (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-base">
            {shiftOpened && (
              <span className="text-text-secondary">
                Shift open since <span className="text-text-primary tnum">{new Date(shiftOpened).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </span>
            )}
            <span className="flex items-center gap-2 text-text-primary font-semibold">
              <TaskIllustration name="person" size={32} />
              {worker}
            </span>
          </div>
        )}
      </header>
    );
  }

  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-border px-5 py-3 sm:px-8 sm:py-5 bg-bg-surface">
      <div className="flex items-center gap-3 sm:gap-4 min-w-0">
        {onBack && (
          <Button size="sm" className="shrink-0 text-text-secondary"
            onClick={onBack}
              disabled={backDisabled}
            aria-label={goesHome ? 'Back to home' : backLabel}
            title={`${goesHome ? 'Back to home' : backLabel} (F9)`}>
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
            <span className="hidden sm:inline">{goesHome ? 'Back' : backLabel}</span>
            <span className="kbd hidden sm:inline">F9</span>
          </Button>
        )}
        <div className="flex flex-wrap items-baseline gap-3 min-w-0">
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
