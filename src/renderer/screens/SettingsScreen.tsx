// SettingsScreen: tabs for Workers, Products, Suppliers, Audit log, Breakage review.

import { useEffect, useState } from 'react';
import { AppHeader } from '../components/AppHeader';
import { WorkersTab } from './settings/WorkersTab';
import { ProductsTab } from './settings/ProductsTab';
import { PricingTiersTab } from './settings/PricingTiersTab';
import { SuppliersTab } from './settings/SuppliersTab';
import { SupplierPaymentsTab } from './settings/SupplierPaymentsTab';
import { AuditLogTab } from './settings/AuditLogTab';
import { BreakageReviewTab } from './settings/BreakageReviewTab';
import { ReprintQueueTab } from './settings/ReprintQueueTab';
import { ExceptionsTab } from './settings/ExceptionsTab';
import { ReorderTab } from './settings/ReorderTab';
import { AppearanceTab } from './settings/AppearanceTab';
import { BackupsTab } from './settings/BackupsTab';
import { DataTransferTab } from './settings/DataTransferTab';
import { SyncTab } from './settings/SyncTab';
import { RunbookPrintScreen } from './RunbookPrintScreen';

type Tab = 'workers' | 'products' | 'tiers' | 'suppliers' | 'supplier-pay' | 'audit' | 'breakage' | 'reprints' | 'exceptions' | 'reorder' | 'appearance' | 'backups' | 'transfer' | 'sync';

export default function SettingsScreen({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('workers');
  const [showRunbook, setShowRunbook] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') {
        e.preventDefault();
        onExit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  if (showRunbook) {
    return <RunbookPrintScreen onExit={() => setShowRunbook(false)} />;
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="settings" />
      {/* Responsive shell: no hard max-width — Counter ships with 10 settings
       *  tabs that need horizontal room; capping the container at max-w-6xl
       *  forced the tab row to overflow into a hidden zone where the "Done"
       *  button vanished off the right edge. Use full width with sensible
       *  padding that scales to the viewport. */}
      <main className="flex-1 w-full mx-auto px-4 sm:px-6 lg:px-10 py-6 flex flex-col gap-5">
        {/* Header row: tabs and action buttons share one wrap-aware flex
         *  container. On narrow widths the tabs wrap to a second line and
         *  the action buttons slide below them automatically. */}
        <div className="flex flex-wrap items-center justify-between gap-y-2 gap-x-4">
          <div className="flex flex-wrap min-w-0">
            <TabBtn active={tab === 'workers'} onClick={() => setTab('workers')}>Workers</TabBtn>
            <TabBtn active={tab === 'products'} onClick={() => setTab('products')}>Products</TabBtn>
            <TabBtn active={tab === 'tiers'} onClick={() => setTab('tiers')}>Pricing tiers</TabBtn>
            <TabBtn active={tab === 'suppliers'} onClick={() => setTab('suppliers')}>Suppliers</TabBtn>
            <TabBtn active={tab === 'supplier-pay'} onClick={() => setTab('supplier-pay')}>Supplier payments</TabBtn>
            <TabBtn active={tab === 'audit'} onClick={() => setTab('audit')}>Audit log</TabBtn>
            <TabBtn active={tab === 'breakage'} onClick={() => setTab('breakage')}>Breakage review</TabBtn>
            <TabBtn active={tab === 'reprints'} onClick={() => setTab('reprints')}>Reprint queue</TabBtn>
            <TabBtn active={tab === 'exceptions'} onClick={() => setTab('exceptions')}>Exceptions</TabBtn>
            <TabBtn active={tab === 'reorder'} onClick={() => setTab('reorder')}>Reorder</TabBtn>
            <TabBtn active={tab === 'appearance'} onClick={() => setTab('appearance')}>Appearance</TabBtn>
            <TabBtn active={tab === 'backups'} onClick={() => setTab('backups')}>Backups</TabBtn>
            <TabBtn active={tab === 'transfer'} onClick={() => setTab('transfer')}>Import / Export</TabBtn>
            <TabBtn active={tab === 'sync'} onClick={() => setTab('sync')}>Sync</TabBtn>
          </div>
          <div className="flex gap-3 shrink-0">
            <button onClick={() => setShowRunbook(true)}
              className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm whitespace-nowrap">
              Print worker handbook
            </button>
            <button onClick={onExit} className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm whitespace-nowrap">
              Done <span className="kbd">F9</span>
            </button>
          </div>
        </div>

        {/* min-w-0 here lets wide tables (Products, Audit log) inside the
         *  tab use overflow-x scrolling instead of forcing the flex parent
         *  to grow past the viewport. */}
        <div className="min-w-0">
          {tab === 'workers' && <WorkersTab />}
          {tab === 'products' && <ProductsTab />}
          {tab === 'tiers' && <PricingTiersTab />}
          {tab === 'suppliers' && <SuppliersTab />}
          {tab === 'supplier-pay' && <SupplierPaymentsTab />}
          {tab === 'audit' && <AuditLogTab />}
          {tab === 'breakage' && <BreakageReviewTab />}
          {tab === 'reprints' && <ReprintQueueTab />}
          {tab === 'exceptions' && <ExceptionsTab />}
          {tab === 'reorder' && <ReorderTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'backups' && <BackupsTab />}
          {tab === 'transfer' && <DataTransferTab />}
          {tab === 'sync' && <SyncTab />}
        </div>
      </main>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-3 lg:px-4 py-3 text-xs lg:text-sm uppercase tracking-wider border-b-2 whitespace-nowrap',
        active ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary',
      ].join(' ')}>
      {children}
    </button>
  );
}
