// OpenShiftScreen: capture opening cash count, open a shift.
// F2 confirms.

import { useEffect, useRef, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { AppHeader } from '../components/AppHeader';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import { FeedbackBanner } from '../components/FeedbackBanner';
import VoidApprovalsScreen from './VoidApprovalsScreen';
import VarianceCasesScreen from './VarianceCasesScreen';
import StockReceiptApprovalsScreen from './StockReceiptApprovalsScreen';

export default function OpenShiftScreen() {
  const [raw, setRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showApprovals, setShowApprovals] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [showVarianceCases, setShowVarianceCases] = useState(false);
  const [openVariances, setOpenVariances] = useState(0);
  const [showStockApprovals, setShowStockApprovals] = useState(false);
  const [pendingStockApprovals, setPendingStockApprovals] = useState(0);
  const setOpenShift = useSession((s) => s.setOpenShift);
  const role = useSession((s) => s.workerRole);
  const isSenior = role === 'SUPERVISOR' || role === 'OWNER' || role === 'FOUNDER';
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!isSenior) return;
    let cancelled = false;
    async function refresh() {
      const result = await counter.saleVoidRequestPendingCount();
      if (!cancelled && result.success) setPendingApprovals(result.data.reviewablePendingCount);
      const variances = await counter.varianceCasePendingCount();
      if (!cancelled && variances.success) setOpenVariances(variances.data.openCount);
      const stock = await counter.stockReceiptRequestPendingCount();
      if (!cancelled && stock.success) setPendingStockApprovals(stock.data.reviewablePendingCount);
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [isSenior, showApprovals]);

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

  if (showApprovals) return <VoidApprovalsScreen onExit={() => setShowApprovals(false)} />;
  if (showVarianceCases) return <VarianceCasesScreen onExit={() => setShowVarianceCases(false)} />;
  if (showStockApprovals) return <StockReceiptApprovalsScreen onExit={() => setShowStockApprovals(false)} />;

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="open shift" />
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 sm:px-12 py-12 flex flex-col gap-6">
        <section className="panel p-6 sm:p-8 flex flex-col gap-5">
        <div><div className="eyebrow">Start of shift</div><h2 className="text-2xl font-semibold mt-1">Opening cash in till</h2></div>
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
            className="flex-1 min-w-0 bg-bg-input border border-border-strong px-5 py-4 text-4xl font-mono tnum text-right focus:outline-none focus:border-accent"
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
            className="btn btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {submitting ? 'Opening shift…' : 'Open shift'} <span className="kbd">F2</span>
          </button>
          {valid && pesewas !== null && (
            <span className="text-text-secondary text-sm">→ Cash counted: <span className="font-mono tnum">GHS {formatMoney(pesewas)}</span></span>
          )}
        </div>
        {error && (
          <FeedbackBanner>{error}</FeedbackBanner>
        )}
        </section>
        {isSenior && (
          <section className="panel p-5 mt-4 flex flex-wrap items-center justify-between gap-3">
            <div><div className="eyebrow">Management access</div><div className="mt-1">Review void requests without opening an artificial till shift.</div></div>
            <button className={pendingApprovals > 0 ? 'btn border-warning text-warning' : 'btn btn-quiet'} onClick={() => setShowApprovals(true)}>
              Void approvals{pendingApprovals > 0 ? ` · ${pendingApprovals}` : ''}
            </button>
            <button className={openVariances > 0 ? 'btn border-warning text-warning' : 'btn btn-quiet'} onClick={() => setShowVarianceCases(true)}>
              Variance cases{openVariances > 0 ? ` · ${openVariances}` : ''}
            </button>
            <button className={pendingStockApprovals > 0 ? 'btn border-warning text-warning' : 'btn btn-quiet'} onClick={() => setShowStockApprovals(true)}>
              Stock approvals{pendingStockApprovals > 0 ? ` · ${pendingStockApprovals}` : ''}
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
