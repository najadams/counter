// SettingsScreen: tabs for Workers, Products, Suppliers, Audit log, Breakage review.

import { useEffect, useState } from 'react';
import { AppHeader } from '../components/AppHeader';
import { WorkersTab } from './settings/WorkersTab';
import { ProductsTab } from './settings/ProductsTab';
import { SuppliersTab } from './settings/SuppliersTab';
import { AuditLogTab } from './settings/AuditLogTab';
import { BreakageReviewTab } from './settings/BreakageReviewTab';
import { ReprintQueueTab } from './settings/ReprintQueueTab';
import { ExceptionsTab } from './settings/ExceptionsTab';
import { ReorderTab } from './settings/ReorderTab';
import { RunbookPrintScreen } from './RunbookPrintScreen';

type Tab = 'workers' | 'products' | 'suppliers' | 'audit' | 'breakage' | 'reprints' | 'exceptions' | 'reorder';

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
      <main className="flex-1 max-w-6xl w-full mx-auto px-12 py-8 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <div className="flex">
            <TabBtn active={tab === 'workers'} onClick={() => setTab('workers')}>Workers</TabBtn>
            <TabBtn active={tab === 'products'} onClick={() => setTab('products')}>Products</TabBtn>
            <TabBtn active={tab === 'suppliers'} onClick={() => setTab('suppliers')}>Suppliers</TabBtn>
            <TabBtn active={tab === 'audit'} onClick={() => setTab('audit')}>Audit log</TabBtn>
            <TabBtn active={tab === 'breakage'} onClick={() => setTab('breakage')}>Breakage review</TabBtn>
            <TabBtn active={tab === 'reprints'} onClick={() => setTab('reprints')}>Reprint queue</TabBtn>
            <TabBtn active={tab === 'exceptions'} onClick={() => setTab('exceptions')}>Exceptions</TabBtn>
            <TabBtn active={tab === 'reorder'} onClick={() => setTab('reorder')}>Reorder</TabBtn>
          </div>
          <div className="flex gap-3">
            <button onClick={() => setShowRunbook(true)}
              className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Print worker handbook
            </button>
            <button onClick={onExit} className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Done <span className="kbd">F9</span>
            </button>
          </div>
        </div>

        {tab === 'workers' && <WorkersTab />}
        {tab === 'products' && <ProductsTab />}
        {tab === 'suppliers' && <SuppliersTab />}
        {tab === 'audit' && <AuditLogTab />}
        {tab === 'breakage' && <BreakageReviewTab />}
        {tab === 'reprints' && <ReprintQueueTab />}
        {tab === 'exceptions' && <ExceptionsTab />}
        {tab === 'reorder' && <ReorderTab />}
      </main>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-5 py-3 text-sm uppercase tracking-wider border-b-2',
        active ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary',
      ].join(' ')}>
      {children}
    </button>
  );
}
