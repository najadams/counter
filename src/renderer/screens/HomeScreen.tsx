// HomeScreen: lands here when a shift is open.
//   F1   Sale screen
//   F2   Cash drop modal
//   F3   Consumption (drink log)
//   F4   Stocktake
//   F5   Daily summary
//   F7   Breakage
//   F8   Stock receipt
//   F10  Close shift
//   F11  Recent sales / void
//   F12  Settings

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { AppHeader } from '../components/AppHeader';
import { CashDropModal } from '../components/CashDropModal';
import { ExpenseModal } from '../components/ExpenseModal';
import { BackupHealthBanner } from '../components/BackupHealthBanner';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import SaleScreen from './SaleScreen';
import VoidSaleScreen from './VoidSaleScreen';
import BreakageScreen from './BreakageScreen';
import ConsumptionScreen from './ConsumptionScreen';
import StockReceiveScreen from './StockReceiveScreen';
import SettingsScreen from './SettingsScreen';
import StocktakeScreen from './StocktakeScreen';
import DailySummaryScreen from './DailySummaryScreen';
import CustomersScreen from './CustomersScreen';
import ReportsScreen from './ReportsScreen';

type View = 'home' | 'sale' | 'void' | 'breakage' | 'consumption' | 'stock' | 'settings' | 'stocktake' | 'summary' | 'customers' | 'reports';

export default function HomeScreen() {
  const shiftId = useSession((s) => s.shiftId);
  const opening = useSession((s) => s.shiftOpeningCashPesewas);
  const clearShift = useSession((s) => s.clearShift);
  const logout = useSession((s) => s.logout);

  const [view, setView] = useState<View>('home');
  const [showCashDrop, setShowCashDrop] = useState(false);
  const [showExpense, setShowExpense] = useState(false);
  const [closing, setClosing] = useState(false);
  const [step, setStep] = useState<'idle' | 'count' | 'reconciled'>('idle');
  const [pendingReprints, setPendingReprints] = useState<Array<{ id: string; saleId: string; saleTotalPesewas: number; reason: string }>>([]);
  const [reprintAck, setReprintAck] = useState(false);

  // Reset the "close anyway" acknowledgement whenever the pending list
  // changes — a successful reprint or discard alters the count, and the
  // user should re-affirm against the new state rather than coast on a
  // stale checkbox.
  useEffect(() => {
    setReprintAck(false);
  }, [pendingReprints.length]);

  async function refreshReprints() {
    const r = await counter.listPendingReprints();
    if (r.success) {
      setPendingReprints(r.data.reprints.map((x) => ({
        id: x.id, saleId: x.saleId, saleTotalPesewas: x.saleTotalPesewas, reason: x.reason,
      })));
    }
  }

  // When we open the count step, refresh the reprint list. Doing it here keeps
  // the call cheap (one query) and avoids polling.
  useEffect(() => {
    if (step === 'count') void refreshReprints();
  }, [step]);

  async function retryOneReprint(id: string) {
    const r = await counter.retryReprint({ reprintId: id });
    if (r.success && r.data.printed) await refreshReprints();
  }
  async function discardOneReprint(id: string) {
    const reason = prompt('Discard reason (logged):') ?? '';
    if (!reason.trim()) return;
    const r = await counter.discardReprint({ reprintId: id, reason: reason.trim() });
    if (r.success) await refreshReprints();
  }
  const [counted, setCounted] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [reconciled, setReconciled] = useState<{
    countedPesewas: number; expectedPesewas: number; variancePesewas: number;
    totalSalesPesewas: number; totalBreakageValuePesewas: number;
  } | null>(null);

  useEffect(() => {
    if (view !== 'home' || step !== 'idle' || showCashDrop) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F1') { e.preventDefault(); setView('sale'); }
      else if (e.key === 'F2') { e.preventDefault(); setShowCashDrop(true); }
      else if (e.key === 'F3') { e.preventDefault(); setView('consumption'); }
      else if (e.key === 'F4') { e.preventDefault(); setView('stocktake'); }
      else if (e.key === 'F5') { e.preventDefault(); setView('summary'); }
      else if (e.key === 'F6') { e.preventDefault(); setView('customers'); }
      else if (e.key === 'F7') { e.preventDefault(); setView('breakage'); }
      else if (e.key === 'F8') { e.preventDefault(); setView('stock'); }
      else if (e.key === 'F10') { e.preventDefault(); setStep('count'); setError(null); }
      else if (e.key === 'F11') { e.preventDefault(); setView('void'); }
      else if (e.key === 'F12') { e.preventDefault(); setView('settings'); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, step, showCashDrop]);

  if (view === 'sale') return <SaleScreen onExit={() => setView('home')} />;
  if (view === 'void') return <VoidSaleScreen onExit={() => setView('home')} onDuplicate={() => setView('sale')} />;
  if (view === 'breakage') return <BreakageScreen onExit={() => setView('home')} />;
  if (view === 'consumption') return <ConsumptionScreen onExit={() => setView('home')} />;
  if (view === 'stock') return <StockReceiveScreen onExit={() => setView('home')} />;
  if (view === 'settings') return <SettingsScreen onExit={() => setView('home')} />;
  if (view === 'stocktake') return <StocktakeScreen onExit={() => setView('home')} />;
  if (view === 'summary') return <DailySummaryScreen onExit={() => setView('home')} />;
  if (view === 'customers') return <CustomersScreen onExit={() => setView('home')} />;
  if (view === 'reports') return (
    <ReportsScreen
      onExit={() => setView('home')}
      onOpenCustomers={() => setView('customers')}
      onOpenSummary={() => setView('summary')}
      onOpenStocktake={() => setView('stocktake')}
      onOpenSupplierPayments={() => setView('settings')}
      onOpenReorder={() => setView('settings')}
    />
  );

  async function submitCountAndClose() {
    if (!shiftId) return;
    const pesewas = parseCedisToPesewas(counted);
    if (pesewas === null) { setError('Enter a non-negative number with up to 2 decimals.'); return; }
    setClosing(true); setError(null);
    const sub = await counter.submitClosingCount(shiftId, pesewas);
    if (!sub.success) { setError(sub.error); setClosing(false); return; }
    const close = await counter.closeShift(shiftId);
    setClosing(false);
    if (!close.success) { setError(close.error); return; }
    setReconciled(close.data); setStep('reconciled');
  }
  function finishReconciled() {
    setReconciled(null); setStep('idle'); setCounted(''); clearShift();
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="home" />
      <main className="flex-1 max-w-4xl w-full mx-auto px-12 py-10 flex flex-col gap-4">
        {step === 'idle' && (
          <>
            {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}
            <BackupHealthBanner />

            <ActionRow kind="primary" label="Sale" hot="F1" caption="Search SKUs, build cart, take payment." onClick={() => setView('sale')} />
            <div className="grid grid-cols-2 gap-4">
              <ActionRow label="Cash drop" hot="F2" caption="Hand cash to owner, safe, or supplier." onClick={() => setShowCashDrop(true)} />
              <ActionRow label="Expense" caption="Pay a bill or runner from the till (water, transport, etc.)." onClick={() => setShowExpense(true)} />
              <ActionRow label="Drink" hot="F3" caption="Log worker consumption." onClick={() => setView('consumption')} />
              <ActionRow label="Stocktake" hot="F4" caption="Physical count + shrinkage measure." onClick={() => setView('stocktake')} />
              <ActionRow label="Reports" caption="Overview dashboard: revenue, margin, cash, who owes you." onClick={() => setView('reports')} />
              <ActionRow label="Daily summary" hot="F5" caption="Revenue, margin, shrinkage, alerts." onClick={() => setView('summary')} />
              <ActionRow label="Customers" hot="F6" caption="Debts, take payments, aging." onClick={() => setView('customers')} />
              <ActionRow label="Breakage" hot="F7" caption="Report broken/leaked stock with photo." onClick={() => setView('breakage')} />
              <ActionRow label="Stock receipt" hot="F8" caption="Goods arrived from supplier." onClick={() => setView('stock')} />
              <ActionRow label="Recent sales" hot="F11" caption="Review and void if needed." onClick={() => setView('void')} />
              <ActionRow label="Settings" hot="F12" caption="Workers admin, change PIN." onClick={() => setView('settings')} />
            </div>
            <ActionRow kind="warn" label="Close shift" hot="F10" caption="Two-step blind cash count." onClick={() => { setStep('count'); setError(null); }} />

            <div className="mt-auto pt-6 border-t border-border flex justify-between items-center">
              <button onClick={() => void logout()} className="text-text-tertiary hover:text-text-primary text-sm">Sign out</button>
              {opening !== null && (
                <span className="text-text-tertiary text-xs">Opening cash: {formatMoneyWithCurrency(opening)}</span>
              )}
            </div>
          </>
        )}

        {step === 'count' && (
          <div className="flex flex-col gap-4">
            {pendingReprints.length > 0 && (
              <div className="bg-warning/10 border border-warning rounded p-4 space-y-2">
                <div className="text-warning font-semibold">
                  {pendingReprints.length} receipt(s) still queued from this shift
                </div>
                <div className="text-xs text-text-secondary">
                  Print or discard them before closing — otherwise they hang
                  over into the next shift and the cashier may forget which
                  customer they belonged to.
                </div>
                <ul className="text-sm">
                  {pendingReprints.map((r) => (
                    <li key={r.id} className="flex items-center gap-2 py-1">
                      <span className="font-mono text-xs">#{r.saleId.slice(-6)}</span>
                      <span className="font-mono">{formatMoneyWithCurrency(r.saleTotalPesewas)}</span>
                      <span className="text-text-tertiary text-xs flex-1">{r.reason}</span>
                      <button onClick={() => void retryOneReprint(r.id)}
                        className="text-xs px-2 py-1 border border-border hover:bg-bg-elevated">
                        Print now
                      </button>
                      <button onClick={() => void discardOneReprint(r.id)}
                        className="text-xs px-2 py-1 border border-border hover:bg-bg-elevated text-danger">
                        Discard
                      </button>
                    </li>
                  ))}
                </ul>
                <label className="flex items-center gap-2 text-sm pt-2 border-t border-warning/30">
                  <input type="checkbox" checked={reprintAck} onChange={(e) => setReprintAck(e.target.checked)} />
                  Close anyway. I accept that {pendingReprints.length} receipt(s) are still pending.
                </label>
              </div>
            )}
            <h2 className="text-text-secondary uppercase tracking-wider text-xs">Closing cash count (blind)</h2>
            <p className="text-text-tertiary text-sm">
              Count the cash in the till. Type the total. You will not see the expected amount until you confirm — invariant 9.
            </p>
            <div className="flex items-baseline gap-3">
              <span className="text-text-secondary text-xl">GHS</span>
              <input type="text" inputMode="decimal" autoFocus value={counted}
                onChange={(e) => setCounted(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitCountAndClose(); }}
                disabled={closing} placeholder="0.00"
                className="flex-1 bg-bg-input border border-border-strong px-5 py-4 text-4xl font-mono tnum text-right focus:outline-none focus:border-accent" />
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setStep('idle'); setCounted(''); setError(null); }}
                className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
              <button onClick={() => void submitCountAndClose()}
                disabled={closing || (pendingReprints.length > 0 && !reprintAck)}
                title={pendingReprints.length > 0 && !reprintAck ? 'Resolve pending receipts or acknowledge first' : ''}
                className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed">
                {closing ? 'Reconciling…' : 'Confirm count'}
              </button>
            </div>
            {error && <div className="bg-bg-surface border border-danger px-5 py-3 text-danger text-sm">{error}</div>}
          </div>
        )}

        {step === 'reconciled' && reconciled && (
          <div className="flex flex-col gap-4">
            <h2 className="text-text-secondary uppercase tracking-wider text-xs">Reconciliation</h2>
            <div className="bg-bg-surface border border-border divide-y divide-border">
              <Row label="Counted"  value={formatMoneyWithCurrency(reconciled.countedPesewas)} />
              <Row label="Expected" value={formatMoneyWithCurrency(reconciled.expectedPesewas)} />
              <Row label="Variance"
                value={`${reconciled.variancePesewas >= 0 ? '+' : ''}${formatMoney(reconciled.variancePesewas)}`}
                tone={reconciled.variancePesewas === 0 ? 'ok' : reconciled.variancePesewas > 0 ? 'warn' : 'bad'} />
              <Row label="Total sales" value={formatMoneyWithCurrency(reconciled.totalSalesPesewas)} />
              <Row label="Breakage value" value={formatMoneyWithCurrency(reconciled.totalBreakageValuePesewas)} />
            </div>
            <button onClick={finishReconciled}
              className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light self-start">Done</button>
          </div>
        )}
      </main>

      {showCashDrop && shiftId && (
        <CashDropModal
          shiftId={shiftId}
          onClose={() => setShowCashDrop(false)}
          onDone={() => { setShowCashDrop(false); setInfo('Cash drop recorded.'); setTimeout(() => setInfo(null), 4000); }}
        />
      )}
      {showExpense && shiftId && (
        <ExpenseModal
          onCancel={() => setShowExpense(false)}
          onDone={() => { setShowExpense(false); setInfo('Expense recorded.'); setTimeout(() => setInfo(null), 4000); }}
        />
      )}
    </div>
  );
}

function ActionRow({ kind = 'default', label, hot, caption, onClick }: {
  kind?: 'default' | 'primary' | 'warn'; label: string; hot?: string; caption: string; onClick: () => void;
}) {
  const cls =
    kind === 'primary' ? 'bg-accent text-ink hover:bg-accent-light'
    : kind === 'warn'  ? 'bg-bg-deep border border-warning text-warning hover:bg-bg-elevated'
    : 'bg-bg-surface border border-border text-text-primary hover:bg-bg-elevated';
  return (
    <button onClick={onClick}
      className={`flex items-center justify-between px-6 py-5 text-left ${cls}`}>
      <div>
        <div className={`uppercase tracking-wider text-xs ${kind === 'primary' ? 'opacity-80' : 'text-text-secondary'}`}>{label}</div>
        <div className={`mt-1 text-base ${kind === 'primary' ? '' : 'text-text-primary'}`}>{caption}</div>
      </div>
      {hot && <span className={`kbd ${kind === 'primary' ? 'bg-bg-deep text-accent border-accent' : ''}`}>{hot}</span>}
    </button>
  );
}

function Row({ label, value, tone = 'ok' }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  const c = tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning' : 'text-text-primary';
  return (
    <div className="flex items-center justify-between px-6 py-4">
      <span className="text-text-secondary uppercase tracking-wider text-xs">{label}</span>
      <span className={`font-mono tnum text-lg ${c}`}>{value}</span>
    </div>
  );
}
