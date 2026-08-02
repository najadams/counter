// ReportsScreen — tabbed shell.
//
// Top-level routes:
//   Overview  — Pass 1 dashboard (single bundle, KPI cards + sparkline + lists)
//   Sales     — date-ranged revenue grouped by day/week/month, by channel/method/cashier
//   Margin    — gross-margin by product + category, sold-below-cost panel
//   Inventory — point-in-time stock valuation with days-of-supply
//
// Each tab loads its own data independently when first opened so we don't pay
// for queries the user isn't looking at.

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AppHeader } from '../components/AppHeader';
import { OverviewTab } from './reports/OverviewTab';
import { SalesTab } from './reports/SalesTab';
import { GraphsTab } from './reports/GraphsTab';
import { MarginTab } from './reports/MarginTab';
import { InventoryTab } from './reports/InventoryTab';
import { DrawingsTab } from './reports/DrawingsTab';
import { PriceIntelligenceTab } from './reports/PriceIntelligenceTab';
import { CustomerIntelligenceTab } from './reports/CustomerIntelligenceTab';
import { TaxesTab } from './reports/TaxesTab';
import { BalanceSheetTab } from './reports/BalanceSheetTab';
import { CashflowTab } from './reports/CashflowTab';
import { OwnerManagementTab } from './reports/OwnerManagementTab';
import { counter } from '../lib/ipc';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { useSession } from '../store/session';
import { useReportAccess } from '../store/reportAccess';

type Tab =
  | 'owner-summary' | 'profit' | 'position' | 'management-cash'
  | 'obligations' | 'concentration' | 'downside'
  | 'overview' | 'sales' | 'graphs' | 'taxes' | 'balance' | 'cashflow'
  | 'margin' | 'inventory' | 'drawings' | 'prices' | 'customers';

interface Props {
  onExit: () => void;
  onOpenCustomers?: () => void;
  onOpenSummary?: () => void;
  onOpenStocktake?: () => void;
  onOpenSupplierPayments?: () => void;
  onOpenReorder?: () => void;
}

export default function ReportsScreen({
  onExit, onOpenCustomers, onOpenSummary, onOpenStocktake,
  onOpenSupplierPayments, onOpenReorder,
}: Props) {
  const [tab, setTab] = useState<Tab>('overview');
  const workerRole = useSession((state) => state.workerRole);
  const isOwner = workerRole === 'OWNER' || workerRole === 'FOUNDER';
  const accessToken = useReportAccess((state) => state.accessToken);
  const scopes = useReportAccess((state) => state.scopes);
  const idleExpiresAt = useReportAccess((state) => state.idleExpiresAt);
  const setUnlocked = useReportAccess((state) => state.unlock);
  const touchAccess = useReportAccess((state) => state.touch);
  const clearAccess = useReportAccess((state) => state.clear);
  const [pin, setPin] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const lastTouchSentAt = useRef(0);

  const lockReports = useCallback(async (reason: 'MANUAL' | 'IDLE') => {
    const token = useReportAccess.getState().accessToken;
    clearAccess();
    setPin('');
    if (token) await counter.reportsLock(token, reason);
  }, [clearAccess]);

  async function unlockReports(event: FormEvent) {
    event.preventDefault();
    if (pin.length < 4 || unlocking) return;
    setUnlocking(true);
    setAccessError(null);
    const result = await counter.reportsUnlock(pin);
    setUnlocking(false);
    setPin('');
    if (!result.success) {
      setAccessError(result.error);
      return;
    }
    setUnlocked(result.data.accessToken, result.data.scopes, result.data.idleExpiresAt);
  }

  const tabContent = (
    <>
      {tab === 'overview' && (
        <OverviewTab
          reportAccessToken={accessToken!}
          onOpenCustomers={onOpenCustomers}
          onOpenSummary={onOpenSummary}
          onOpenStocktake={onOpenStocktake}
          onOpenSupplierPayments={onOpenSupplierPayments}
          onOpenReorder={onOpenReorder}
        />
      )}
      {tab === 'sales' && <SalesTab reportAccessToken={accessToken!} />}
      {tab === 'graphs' && <GraphsTab reportAccessToken={accessToken!} />}
      {tab === 'taxes' && <TaxesTab reportAccessToken={accessToken!} />}
      {tab === 'balance' && <BalanceSheetTab reportAccessToken={accessToken!} />}
      {tab === 'cashflow' && <CashflowTab reportAccessToken={accessToken!} />}
      {tab === 'margin' && <MarginTab reportAccessToken={accessToken!} />}
      {tab === 'inventory' && <InventoryTab reportAccessToken={accessToken!} />}
      {tab === 'drawings' && <DrawingsTab reportAccessToken={accessToken!} />}
      {tab === 'prices' && <PriceIntelligenceTab reportAccessToken={accessToken!} />}
      {tab === 'customers' && <CustomerIntelligenceTab reportAccessToken={accessToken!} />}
      {tab === 'owner-summary' && <OwnerManagementTab view="summary" reportAccessToken={accessToken!} />}
      {tab === 'profit' && <OwnerManagementTab view="profit" reportAccessToken={accessToken!} />}
      {tab === 'position' && <OwnerManagementTab view="position" reportAccessToken={accessToken!} />}
      {tab === 'management-cash' && <OwnerManagementTab view="cash" reportAccessToken={accessToken!} />}
      {tab === 'obligations' && <OwnerManagementTab view="obligations" reportAccessToken={accessToken!} />}
      {tab === 'concentration' && <OwnerManagementTab view="concentration" reportAccessToken={accessToken!} />}
      {tab === 'downside' && <OwnerManagementTab view="downside" reportAccessToken={accessToken!} />}
    </>
  );
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') { e.preventDefault(); onExit(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    void counter.reportsAccessStatus(accessToken).then((result) => {
      if (cancelled) return;
      if (!result.success || !result.data.unlocked || !result.data.idleExpiresAt) void lockReports('IDLE');
      else touchAccess(result.data.idleExpiresAt);
    });
    return () => { cancelled = true; };
  }, [accessToken, lockReports, touchAccess]);

  useEffect(() => {
    if (!accessToken || !idleExpiresAt) { setRemainingMs(0); return; }
    const tick = () => {
      const remaining = new Date(useReportAccess.getState().idleExpiresAt ?? 0).getTime() - Date.now();
      setRemainingMs(Math.max(0, remaining));
      if (remaining <= 0) void lockReports('IDLE');
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [accessToken, idleExpiresAt, lockReports]);

  useEffect(() => {
    if (!accessToken) return;
    const activity = () => {
      const now = Date.now();
      if (now - lastTouchSentAt.current < 15_000) return;
      lastTouchSentAt.current = now;
      touchAccess(new Date(now + 5 * 60_000).toISOString());
      void counter.reportsTouch(accessToken).then((result) => {
        if (!result.success) clearAccess();
        else touchAccess(result.data.idleExpiresAt);
      });
    };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
    for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
    return () => {
      for (const event of events) window.removeEventListener(event, activity, { capture: true });
    };
  }, [accessToken, clearAccess, touchAccess]);

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle={`reports — ${tab}`} onBack={onExit} />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-8 py-6 flex flex-col gap-5">
        {!accessToken ? (
          <form onSubmit={(event) => void unlockReports(event)} className="panel max-w-xl p-6 sm:p-8 flex flex-col gap-5">
            <div>
              <div className="eyebrow">Protected workspace</div>
              <h1 className="text-2xl font-semibold mt-2">Unlock reports once</h1>
              <p className="text-text-secondary text-sm mt-2">Your report session locks after five minutes without keyboard, touch, pointer, or scroll activity.</p>
            </div>
            {accessError && <FeedbackBanner>{accessError}</FeedbackBanner>}
            <div className="flex flex-wrap gap-3">
              <input autoFocus type="password" inputMode="numeric" maxLength={6} value={pin}
                onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Your PIN" className="input max-w-44 text-lg font-mono" />
              <button type="submit" disabled={pin.length < 4 || unlocking} className="btn btn-primary">
                {unlocking ? 'Unlocking…' : 'Unlock reports'}
              </button>
            </div>
          </form>
        ) : <>
        <div className="panel px-4 py-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="status-badge status-approved">Reports unlocked</span>
            <span className="text-xs text-text-secondary">
              {remainingMs <= 60_000 ? `Locks in ${Math.max(1, Math.ceil(remainingMs / 1000))}s` : 'Locks after 5 minutes of inactivity'}
            </span>
          </div>
          <button onClick={() => void lockReports('MANUAL')} className="btn btn-quiet">Lock now</button>
        </div>
        <div className="panel p-3 flex flex-col gap-3">
          {isOwner && scopes.includes('OWNER') && (
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="eyebrow w-24 shrink-0">Owner</div>
            <div className="flex overflow-x-auto">
            {isOwner && scopes.includes('OWNER') && (
              <>
                <TabBtn active={tab === 'owner-summary'} onClick={() => setTab('owner-summary')}>Owner Summary</TabBtn>
                <TabBtn active={tab === 'profit'} onClick={() => setTab('profit')}>Profit</TabBtn>
                <TabBtn active={tab === 'position'} onClick={() => setTab('position')}>Position</TabBtn>
                <TabBtn active={tab === 'management-cash'} onClick={() => setTab('management-cash')}>Cash</TabBtn>
                <TabBtn active={tab === 'obligations'} onClick={() => setTab('obligations')}>Obligations</TabBtn>
                <TabBtn active={tab === 'concentration'} onClick={() => setTab('concentration')}>Concentration</TabBtn>
                <TabBtn active={tab === 'downside'} onClick={() => setTab('downside')}>Downside</TabBtn>
                <TabBtn active={tab === 'balance'} onClick={() => setTab('balance')}>Legacy position</TabBtn>
                <TabBtn active={tab === 'cashflow'} onClick={() => setTab('cashflow')}>Legacy cashflow</TabBtn>
                <TabBtn active={tab === 'drawings'} onClick={() => setTab('drawings')}>Drawings</TabBtn>
              </>
            )}
            </div>
          </div>
          )}
          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <div className="eyebrow w-24 shrink-0">Operational</div>
            <div className="flex overflow-x-auto">
            <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabBtn>
            <TabBtn active={tab === 'sales'} onClick={() => setTab('sales')}>Sales</TabBtn>
            <TabBtn active={tab === 'graphs'} onClick={() => setTab('graphs')}>Graphs</TabBtn>
            <TabBtn active={tab === 'taxes'} onClick={() => setTab('taxes')}>Taxes</TabBtn>
            <TabBtn active={tab === 'margin'} onClick={() => setTab('margin')}>Margin</TabBtn>
            <TabBtn active={tab === 'inventory'} onClick={() => setTab('inventory')}>Inventory</TabBtn>
            <TabBtn active={tab === 'prices'} onClick={() => setTab('prices')}>Prices</TabBtn>
            <TabBtn active={tab === 'customers'} onClick={() => setTab('customers')}>Customers</TabBtn>
            </div>
          </div>
        </div>

        {tabContent}
        </>}
      </main>
    </div>
  );
}

function TabBtn({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-4 py-2.5 text-sm whitespace-nowrap border-b-2',
        active
          ? 'border-accent text-accent'
          : 'border-transparent text-text-secondary hover:text-text-primary',
      ].join(' ')}>
      {children}
    </button>
  );
}
