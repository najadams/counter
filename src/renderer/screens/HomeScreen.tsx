// HomeScreen: lands here when a shift is open.
//   F1   Sale screen
//   F2   Cash drop modal
//   F3   Consumption (drink log)
//   F4   Stocktake
//   F5   Daily summary
//   F7   Breakage
//   F8   Stock receipt
//        Paper receipts
//   F10  Close shift
//   F11  Recent sales / void
//   F12  Settings

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { counter, isDesktopHost } from '../lib/ipc';
import { useSession } from '../store/session';
import { AppHeader } from '../components/AppHeader';
import { BackupHealthBanner } from '../components/BackupHealthBanner';
import { SyncHealthBanner } from '../components/SyncHealthBanner';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import type {
  ShiftCloseBackupResult, AccessInfoResponse, ManagementHomeWarningsResponse,
} from '../../shared/types/ipc';
import SaleScreen from './SaleScreen';
import VoidSaleScreen from './VoidSaleScreen';
import PendingOrdersScreen from './PendingOrdersScreen';
import BreakageScreen from './BreakageScreen';
import ConsumptionScreen from './ConsumptionScreen';
import StockReceiveScreen from './StockReceiveScreen';
import SettingsScreen from './SettingsScreen';
import StocktakeScreen from './StocktakeScreen';
import DailySummaryScreen from './DailySummaryScreen';
import CustomersScreen from './CustomersScreen';
import ReportsScreen from './ReportsScreen';
import MoneyOutScreen from './MoneyOutScreen';
import PaperReceiptsScreen from './PaperReceiptsScreen';
import VoidApprovalsScreen from './VoidApprovalsScreen';
import VarianceCasesScreen from './VarianceCasesScreen';
import StockReceiptApprovalsScreen from './StockReceiptApprovalsScreen';
import { FeedbackBanner } from '../components/FeedbackBanner';

type View = 'home' | 'sale' | 'void' | 'voidApprovals' | 'varianceCases' | 'stockApprovals' | 'breakage' | 'consumption' | 'stock' | 'settings' | 'stocktake' | 'summary' | 'customers' | 'reports' | 'pendingOrders' | 'moneyOut' | 'paperReceipts';

export default function HomeScreen() {
  const shiftId = useSession((s) => s.shiftId);
  const opening = useSession((s) => s.shiftOpeningCashPesewas);
  const clearShift = useSession((s) => s.clearShift);
  const logout = useSession((s) => s.logout);
  const workerRole = useSession((s) => s.workerRole);

  const [view, setView] = useState<View>('home');
  const [closing, setClosing] = useState(false);
  const [step, setStep] = useState<'idle' | 'count' | 'reconciled'>('idle');
  const [pendingReprints, setPendingReprints] = useState<Array<{ id: string; saleId: string; saleTotalPesewas: number; reason: string }>>([]);
  const [reprintAck, setReprintAck] = useState(false);
  const [pendingOrderCount, setPendingOrderCount] = useState(0);
  const [obligationWarnings, setObligationWarnings] = useState<ManagementHomeWarningsResponse | null>(null);
  const [voidCounts, setVoidCounts] = useState({ minePendingCount: 0, reviewablePendingCount: 0, currentShiftPendingCount: 0 });
  const [varianceCounts, setVarianceCounts] = useState({ openCount: 0, overdueCount: 0, unresolvedPesewas: 0 });
  const [stockRequestCounts, setStockRequestCounts] = useState({ minePendingCount: 0, reviewablePendingCount: 0 });
  const isSenior = workerRole === 'SUPERVISOR' || workerRole === 'OWNER' || workerRole === 'FOUNDER';

  useEffect(() => {
    let cancelled = false;
    async function refreshVoidCounts() {
      const result = await counter.saleVoidRequestPendingCount();
      if (!cancelled && result.success) setVoidCounts(result.data);
    }
    void refreshVoidCounts();
    const interval = window.setInterval(() => void refreshVoidCounts(), 10_000);
    const onFocus = () => void refreshVoidCounts();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, [view]);

  useEffect(() => {
    let cancelled = false;
    async function refresh() { const result = await counter.stockReceiptRequestPendingCount(); if (!cancelled && result.success) setStockRequestCounts(result.data); }
    void refresh(); const interval = window.setInterval(() => void refresh(), 10_000);
    const onFocus = () => void refresh(); window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.clearInterval(interval); window.removeEventListener('focus', onFocus); };
  }, [view]);

  useEffect(() => {
    if (!isSenior) return;
    let cancelled = false;
    async function refresh() { const result = await counter.varianceCasePendingCount(); if (!cancelled && result.success) setVarianceCounts(result.data); }
    void refresh(); const interval = window.setInterval(() => void refresh(), 10_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [isSenior, view]);

  useEffect(() => {
    if (workerRole !== 'OWNER' && workerRole !== 'FOUNDER') return;
    let cancelled = false;
    async function refresh() {
      const result = await counter.managementHomeWarnings();
      if (!cancelled && result.success) setObligationWarnings(result.data);
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [workerRole, view]);

  // Polled rather than pushed — the pull worker writes pending_orders in the
  // background on its own interval; this just reflects whatever landed since
  // the last check. 20s matches PendingOrdersScreen's own poll so the count
  // on the menu button doesn't visibly lag the screen you'd land on.
  useEffect(() => {
    let cancelled = false;
    async function refreshPendingOrderCount() {
      const r = await counter.pendingOrdersList();
      if (!cancelled && r.success) setPendingOrderCount(r.data.orders.length);
    }
    void refreshPendingOrderCount();
    const interval = window.setInterval(() => void refreshPendingOrderCount(), 20_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [view]);

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
  const [reconciled, setReconciled] = useState<{
    countedPesewas: number; expectedPesewas: number; variancePesewas: number;
    totalSalesPesewas: number; totalBreakageValuePesewas: number;
    backup: ShiftCloseBackupResult;
  } | null>(null);
  // Cashier must acknowledge a failed backup before the reconciled screen
  // can be dismissed — see the red banner below.
  const [backupAcked, setBackupAcked] = useState(false);

  useEffect(() => {
    if (view !== 'home' || step !== 'idle') return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F1') { e.preventDefault(); setView('sale'); }
      else if (e.key === 'F2') { e.preventDefault(); setView('moneyOut'); }
      else if (e.key === 'F3') { e.preventDefault(); setView('consumption'); }
      else if (e.key === 'F4') { e.preventDefault(); setView('stocktake'); }
      else if (e.key === 'F5') { e.preventDefault(); setView('summary'); }
      else if (e.key === 'F6') { e.preventDefault(); setView('customers'); }
      else if (e.key === 'F7') { e.preventDefault(); setView('breakage'); }
      else if (e.key === 'F8') { e.preventDefault(); setView('stock'); }
      // No hot key: F9 is reserved everywhere in this app as "back to home"
      // from a child screen (see PendingOrdersScreen and every sibling) —
      // Home's own keydown listener stays mounted underneath a child screen,
      // so binding F9 here too would race the child's own F9 "back" handler.
      else if (e.key === 'F10') { e.preventDefault(); setStep('count'); setError(null); }
      else if (e.key === 'F11') { e.preventDefault(); setView('void'); }
      else if (e.key === 'F12') { e.preventDefault(); setView('settings'); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, step]);

  if (view === 'sale') return <SaleScreen onExit={() => setView('home')} />;
  if (view === 'void') return <VoidSaleScreen onExit={() => setView('home')} onDuplicate={() => setView('sale')} />;
  if (view === 'voidApprovals') return <VoidApprovalsScreen onExit={() => setView('home')} />;
  if (view === 'varianceCases') return <VarianceCasesScreen onExit={() => setView('home')} />;
  if (view === 'stockApprovals') return <StockReceiptApprovalsScreen onExit={() => setView('home')} />;
  if (view === 'breakage') return <BreakageScreen onExit={() => setView('home')} />;
  if (view === 'consumption') return <ConsumptionScreen onExit={() => setView('home')} />;
  if (view === 'stock') return <StockReceiveScreen onExit={() => setView('home')} />;
  if (view === 'settings') return <SettingsScreen onExit={() => setView('home')} />;
  if (view === 'stocktake') return <StocktakeScreen onExit={() => setView('home')} />;
  if (view === 'summary') return <DailySummaryScreen onExit={() => setView('home')} />;
  if (view === 'customers') return <CustomersScreen onExit={() => setView('home')} />;
  if (view === 'moneyOut' && shiftId) return <MoneyOutScreen shiftId={shiftId} onExit={() => setView('home')} />;
  if (view === 'paperReceipts') {
    return <PaperReceiptsScreen onExit={() => setView('home')} onOpenAtTill={() => setView('sale')} />;
  }
  if (view === 'pendingOrders') {
    return (
      <PendingOrdersScreen
        onExit={() => setView('home')}
        onAccept={() => setView('sale')}
      />
    );
  }
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
    setReconciled(null); setBackupAcked(false); setStep('idle'); setCounted(''); clearShift();
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="home" />
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 py-6 sm:px-12 sm:py-10 flex flex-col gap-4">
        {step === 'idle' && (
          <>
            <BackupHealthBanner />
            <SyncHealthBanner />
            {obligationWarnings
              && (obligationWarnings.overdueCount > 0
                || obligationWarnings.dueNext7DaysCount > 0
                || obligationWarnings.missingDueDateCount > 0) && (
              <FeedbackBanner>
                {obligationWarnings.overdueCount > 0
                  ? `${obligationWarnings.overdueCount} overdue obligation(s), ${formatMoneyWithCurrency(obligationWarnings.overduePesewas)} outstanding. `
                  : ''}
                {obligationWarnings.dueNext7DaysCount > 0
                  ? `${obligationWarnings.dueNext7DaysCount} due within seven days (${formatMoneyWithCurrency(obligationWarnings.dueNext7DaysPesewas)}). `
                  : ''}
                {obligationWarnings.missingDueDateCount > 0
                  ? `${obligationWarnings.missingDueDateCount} open obligation(s) have no due date.`
                  : ''}
              </FeedbackBanner>
            )}
            <LanJoinCard />

            <ActionRow kind="primary" label="Sale" hot="F1" caption="Search SKUs, build cart, take payment." onClick={() => setView('sale')} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <ActionRow
                kind={pendingOrderCount > 0 ? 'warn' : 'default'}
                label="WhatsApp orders"
                caption={pendingOrderCount > 0
                  ? `${pendingOrderCount} order${pendingOrderCount === 1 ? '' : 's'} waiting on your decision.`
                  : 'Accept or decline orders the agent confirmed with customers.'}
                onClick={() => setView('pendingOrders')}
              />
              <ActionRow label="Money out" hot="F2" caption="Expenses, drawings, supplier payments, tax payments." onClick={() => setView('moneyOut')} />
              <ActionRow label="Drink" hot="F3" caption="Log worker consumption." onClick={() => setView('consumption')} />
              <ActionRow label="Stocktake" hot="F4" caption="Physical count + shrinkage measure." onClick={() => setView('stocktake')} />
              <ActionRow label="Reports" caption="Overview dashboard: revenue, margin, cash, who owes you." onClick={() => setView('reports')} />
              <ActionRow label="Daily summary" hot="F5" caption="Revenue, margin, shrinkage, alerts." onClick={() => setView('summary')} />
              <ActionRow label="Customers" hot="F6" caption="Debts, take payments, aging." onClick={() => setView('customers')} />
              <ActionRow label="Breakage" hot="F7" caption="Report broken/leaked stock with photo." onClick={() => setView('breakage')} />
              <ActionRow label="Stock receipt" hot="F8" kind={stockRequestCounts.minePendingCount > 0 ? 'warn' : 'default'} caption={stockRequestCounts.minePendingCount > 0 ? `${stockRequestCounts.minePendingCount} of your receipt request(s) await approval.` : 'Record a delivery and submit it for approval.'} onClick={() => setView('stock')} />
              <ActionRow label="Paper receipts" caption="Review photographed receipts before posting sales." onClick={() => setView('paperReceipts')} />
              <ActionRow label="Recent sales" hot="F11" kind={voidCounts.minePendingCount > 0 ? 'warn' : 'default'} caption={voidCounts.minePendingCount > 0 ? `${voidCounts.minePendingCount} of your void request(s) await a decision.` : 'Review receipts and submit same-day void requests.'} onClick={() => setView('void')} />
              {isSenior && <ActionRow label="Void approvals" kind={voidCounts.reviewablePendingCount > 0 ? 'warn' : 'default'} caption={voidCounts.reviewablePendingCount > 0 ? `${voidCounts.reviewablePendingCount} request(s) waiting for your decision.` : 'Review pending requests and decision history.'} onClick={() => setView('voidApprovals')} />}
              {isSenior && <ActionRow label="Variance cases" kind={varianceCounts.overdueCount > 0 ? 'warn' : 'default'} caption={varianceCounts.openCount > 0 ? `${varianceCounts.openCount} open · ${varianceCounts.overdueCount} overdue · ${formatMoneyWithCurrency(varianceCounts.unresolvedPesewas)} unresolved.` : 'Investigate cash, stock, account, and customer differences.'} onClick={() => setView('varianceCases')} />}
              {isSenior && <ActionRow label="Stock approvals" kind={stockRequestCounts.reviewablePendingCount > 0 ? 'warn' : 'default'} caption={stockRequestCounts.reviewablePendingCount > 0 ? `${stockRequestCounts.reviewablePendingCount} receipt request(s) waiting for review.` : 'Approve supplier deliveries before inventory and payables change.'} onClick={() => setView('stockApprovals')} />}
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
            {voidCounts.currentShiftPendingCount > 0 && (
              <div className="notice notice-warning">
                <div className="font-semibold">Unresolved void requests block this shift from closing</div>
                <p className="text-xs mt-1">Resolve or withdraw every request first. Sales and expected cash remain unchanged while requests are pending.</p>
                <button className="btn btn-quiet mt-3" onClick={() => setView(isSenior ? 'voidApprovals' : 'void')}>{isSenior ? 'Review requests' : 'View my requests'}</button>
              </div>
            )}
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
                className="flex-1 min-w-0 bg-bg-input border border-border-strong px-5 py-4 text-4xl font-mono tnum text-right focus:outline-none focus:border-accent" />
            </div>
            <div className="flex gap-3">
              <button onClick={() => { setStep('idle'); setCounted(''); setError(null); }}
                className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
              <button onClick={() => void submitCountAndClose()}
                disabled={closing || voidCounts.currentShiftPendingCount > 0 || (pendingReprints.length > 0 && !reprintAck)}
                title={pendingReprints.length > 0 && !reprintAck ? 'Resolve pending receipts or acknowledge first' : ''}
                className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed">
                {closing ? 'Reconciling…' : 'Confirm count'}
              </button>
            </div>
            {error && <FeedbackBanner>{error}</FeedbackBanner>}
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

            <BackupResultBlock backup={reconciled.backup} acked={backupAcked} onAck={() => setBackupAcked(true)} />

            <button onClick={finishReconciled}
              disabled={reconciled.backup.ran && reconciled.backup.ok === false && !backupAcked}
              className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light self-start disabled:opacity-50 disabled:cursor-not-allowed">Done</button>
          </div>
        )}
      </main>

    </div>
  );
}


function BackupResultBlock({
  backup,
  acked,
  onAck,
}: {
  backup: ShiftCloseBackupResult;
  acked: boolean;
  onAck: () => void;
}) {
  // Silent on the skip paths — backup doesn't need to advertise itself
  // every time the cashier closes a mid-day shift. The home-screen
  // BackupHealthBanner is the long-term feedback channel.
  if (!backup.ran) return null;

  if (backup.ok) {
    const dest = backup.dbDest ?? '';
    const fname = dest.split(/[\\/]/).pop() ?? dest;
    const size = backup.sizeBytes ? formatBytes(backup.sizeBytes) : '';
    if (backup.fellBackToDefault) {
      return (
        <div className="border border-warning bg-warning/10 text-warning px-4 py-3 text-sm space-y-1">
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold">Backup saved locally — configured target was unavailable</div>
            {backup.dbDest && <RevealLink path={backup.dbDest} />}
          </div>
          <div className="text-xs text-text-secondary break-all">{fname}{size ? ' \u00b7 ' + size : ''}</div>
          <div className="text-xs text-text-secondary">Plug your USB stick in (or restore the network share) and the next backup will land there again. Today's data is safe in ~/CounterBackups.</div>
        </div>
      );
    }
    return (
      <div className="border border-success bg-success/10 text-success px-4 py-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="font-semibold">Backup saved</div>
          {backup.dbDest && <RevealLink path={backup.dbDest} />}
        </div>
        <div className="text-xs text-text-secondary mt-1 break-all">{fname}{size ? ' \u00b7 ' + size : ''}</div>
      </div>
    );
  }

  return (
    <div className="border border-danger bg-danger/10 text-danger px-4 py-3 text-sm space-y-2">
      <div className="font-semibold">Backup failed — shift is closed but no off-site copy was written</div>
      <div className="text-xs text-text-secondary">{backup.error ?? 'Unknown error.'}</div>
      <div className="text-xs text-text-secondary">
        The shift cash reconciliation is already saved. Resolve the backup
        target (USB plugged in? disk full?) and run <code>npm run backup</code> manually,
        or wait for the nightly job to retry.
      </div>
      {!acked && (
        <button onClick={onAck}
          className="text-xs border border-danger px-3 py-1 hover:bg-danger/20">
          Acknowledge & continue
        </button>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}


function RevealLink({ path }: { path: string }) {
  const label = /Mac|iPhone|iPad/.test(
    typeof navigator === 'undefined' ? '' : (navigator.platform || navigator.userAgent),
  ) ? 'Show in Finder' : 'Show in file browser';
  return (
    <button
      onClick={() => { void counter.backupRevealTarget(path); }}
      className="text-xs underline text-text-secondary hover:text-text-primary"
    >
      {label}
    </button>
  );
}

// Shown only on the desktop host, and only when the embedded server is bound
// to the LAN. Cashiers scan it to open the till on a phone/tablet on the same
// wi-fi — no typing an IP. Prefers the stable counter.local name as the label
// but encodes the IP URL, which always resolves even where mDNS doesn't.
function LanJoinCard() {
  const [access, setAccess] = useState<AccessInfoResponse | null>(null);
  useEffect(() => {
    if (!isDesktopHost) return;
    let alive = true;
    void counter.getAccessInfo().then((r) => { if (alive && r.success) setAccess(r.data); });
    return () => { alive = false; };
  }, []);
  if (!isDesktopHost || !access || !access.exposed || access.urls.length === 0) return null;
  const joinUrl = access.urls[0]!; // length checked above
  return (
    <div className="bg-bg-surface border border-border px-6 py-5 flex items-center gap-5">
      <div className="bg-white p-2 rounded shrink-0">
        <QRCodeSVG value={joinUrl} size={96} />
      </div>
      <div className="text-sm min-w-0">
        <div className="uppercase tracking-wider text-xs text-text-secondary">Add a phone or tablet</div>
        <div className="mt-1 text-text-primary">Scan to open the till on another device on this wi-fi.</div>
        <div className="mt-1 font-mono text-xs text-text-tertiary break-all">{access.mdnsUrl ?? joinUrl}</div>
      </div>
    </div>
  );
}

function ActionRow({ kind = 'default', label, hot, caption, onClick }: {
  kind?: 'default' | 'primary' | 'warn'; label: string; hot?: string; caption: string; onClick: () => void;
}) {
  const cls =
    kind === 'primary' ? 'bg-accent text-ink border border-accent hover:bg-accent-light shadow-sm'
    : kind === 'warn'  ? 'panel border-warning text-warning hover:bg-bg-elevated'
    : 'panel text-text-primary hover:bg-bg-elevated hover:border-border-strong';
  return (
    <button onClick={onClick}
      className={`flex items-center justify-between px-6 py-5 text-left rounded-xl min-h-24 transition-colors ${cls}`}>
      <div>
        <div className={`text-sm font-semibold ${kind === 'primary' ? 'opacity-90' : 'text-text-primary'}`}>{label}</div>
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
