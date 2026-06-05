// OpenShiftScreen: capture opening cash count, open a shift.
// F2 confirms.

import { useEffect, useRef, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { AppHeader } from '../components/AppHeader';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';

export default function OpenShiftScreen() {
  const [raw, setRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setOpenShift = useSession((s) => s.setOpenShift);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pesewas = parseCedisToPesewas(raw);
  const valid = pesewas !== null;

  async function submit() {
    if (!valid || pesewas === null) return;
    setSubmitting(true);
    setError(null);
    const res = await counter.openShift(pesewas, 'COUNTER');
    setSubmitting(false);
    if (!res.success) {
      setError(res.error);
      return;
    }
    // Reload the open-shift cache and let the router move us forward.
    const open = await counter.getOpenShift();
    if (open.success && open.data.open) {
      setOpenShift(open.data.shiftId, open.data.openedAt, open.data.openingCashPesewas);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="open shift" />
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 sm:px-12 py-12 flex flex-col gap-6">
        <h2 className="text-text-secondary uppercase tracking-wider text-xs">Opening cash in till</h2>
        <p className="text-text-tertiary text-sm">
          Count the cash in the till before any sale. Type the amount in cedis (e.g. 250.00). The shift is auditable from this number — if you fudge it, you'll wear the variance at close.
        </p>
        <div className="flex items-baseline gap-3">
          <span className="text-text-secondary text-xl">GHS</span>
          <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={submitting}
            placeholder="0.00"
            className="flex-1 bg-bg-input border border-border-strong px-5 py-4 text-4xl font-mono tnum text-right focus:outline-none focus:border-accent"
          />
        </div>
        {!valid && raw.length > 0 && (
          <div className="text-danger text-xs">
            Enter a non-negative number with up to 2 decimals.
          </div>
        )}
        <div className="flex items-center gap-4 mt-4">
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!valid || submitting}
            className="bg-accent text-ink px-6 py-3 font-semibold tracking-wide hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Opening shift…' : 'Open shift'} <span className="kbd">F2</span>
          </button>
          {valid && pesewas !== null && (
            <span className="text-text-secondary text-sm">→ Cash counted: <span className="font-mono tnum">GHS {formatMoney(pesewas)}</span></span>
          )}
        </div>
        {error && (
          <div className="bg-bg-surface border border-danger px-5 py-3 text-danger text-sm">{error}</div>
        )}
      </main>
    </div>
  );
}
