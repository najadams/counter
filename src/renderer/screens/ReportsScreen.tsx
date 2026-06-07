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

import { useEffect, useState } from 'react';
import { AppHeader } from '../components/AppHeader';
import { OverviewTab } from './reports/OverviewTab';
import { SalesTab } from './reports/SalesTab';
import { MarginTab } from './reports/MarginTab';
import { InventoryTab } from './reports/InventoryTab';

type Tab = 'overview' | 'sales' | 'margin' | 'inventory';

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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') { e.preventDefault(); onExit(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle={`reports — ${tab}`} onBack={onExit} />
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-8 py-6 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div className="flex">
            <TabBtn active={tab === 'overview'} onClick={() => setTab('overview')}>Overview</TabBtn>
            <TabBtn active={tab === 'sales'} onClick={() => setTab('sales')}>Sales</TabBtn>
            <TabBtn active={tab === 'margin'} onClick={() => setTab('margin')}>Margin</TabBtn>
            <TabBtn active={tab === 'inventory'} onClick={() => setTab('inventory')}>Inventory</TabBtn>
          </div>
          <button onClick={onExit}
            className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
            Done <span className="kbd">F9</span>
          </button>
        </div>

        {tab === 'overview' && (
          <OverviewTab
            onOpenCustomers={onOpenCustomers}
            onOpenSummary={onOpenSummary}
            onOpenStocktake={onOpenStocktake}
            onOpenSupplierPayments={onOpenSupplierPayments}
            onOpenReorder={onOpenReorder}
          />
        )}
        {tab === 'sales' && <SalesTab />}
        {tab === 'margin' && <MarginTab />}
        {tab === 'inventory' && <InventoryTab />}
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
        'px-5 py-3 text-sm uppercase tracking-wider border-b-2',
        active
          ? 'border-accent text-accent'
          : 'border-transparent text-text-secondary hover:text-text-primary',
      ].join(' ')}>
      {children}
    </button>
  );
}
