// FriendlyHomeMenu — the Friendly build's home screen actions.
//
// Six everyday tiles up top (Sell drinks biggest), then everything else in
// three labelled groups that open on demand. Close shift sits apart so nobody
// hits it while reaching for a sale. Every shortcut and role gate from the
// standard HomeScreen menu is kept; only the arrangement and wording change.
//
// Presentational only: HomeScreen owns polling, shortcuts and navigation.

import { useState, type ReactNode } from 'react';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import { ActionTile } from './ActionTile';
import { TaskIllustration, type IllustrationName } from './TaskIllustration';

export type FriendlyDestination =
  | 'sale' | 'customers' | 'moneyOut' | 'stock' | 'void' | 'summary'
  | 'stocktake' | 'breakage' | 'consumption' | 'stockApprovals'
  | 'pendingOrders' | 'paperReceipts' | 'voidApprovals'
  | 'reports' | 'varianceCases' | 'settings';

export interface FriendlyHomeCounts {
  pendingOrders: number;
  myVoidRequests: number;
  reviewableVoidRequests: number;
  myStockRequests: number;
  reviewableStockRequests: number;
  openVarianceCases: number;
  overdueVarianceCases: number;
  unresolvedVariancePesewas: number;
}

type GroupId = 'stock' | 'orders' | 'manage';
const GROUP_STORAGE_KEY = 'counter.friendly.homeGroups';

function readOpenGroups(): Record<GroupId, boolean> {
  const closed = { stock: false, orders: false, manage: false };
  try {
    const raw = window.localStorage.getItem(GROUP_STORAGE_KEY);
    return raw ? { ...closed, ...(JSON.parse(raw) as Partial<Record<GroupId, boolean>>) } : closed;
  } catch {
    return closed;
  }
}

export function FriendlyHomeMenu({
  isSenior, cartItemCount, counts, onNavigate, onCloseShift,
}: {
  isSenior: boolean;
  /** Units in the unfinished cart; > 0 turns "Sell drinks" into "Continue sale". */
  cartItemCount: number;
  counts: FriendlyHomeCounts;
  onNavigate: (destination: FriendlyDestination) => void;
  onCloseShift: () => void;
}) {
  const [open, setOpen] = useState<Record<GroupId, boolean>>(readOpenGroups);
  function toggle(id: GroupId) {
    setOpen((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try { window.localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(next)); } catch { /* per-device nicety only */ }
      return next;
    });
  }

  const continuing = cartItemCount > 0;
  const stockBadge = isSenior ? counts.reviewableStockRequests : 0;
  const ordersBadge = counts.pendingOrders + (isSenior ? counts.reviewableVoidRequests : 0);
  const manageBadge = isSenior ? counts.openVarianceCases : 0;

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="friendly-main-actions" className="grid grid-cols-1 @2xl:grid-cols-2 @5xl:grid-cols-3 gap-3">
        <h2 id="friendly-main-actions" className="sr-only">Main actions</h2>
        <ActionTile
          size="regular"
          kind="primary"
          illustration="sell"
          label={continuing ? 'Continue sale' : 'Sell drinks'}
          caption={continuing
            ? `${cartItemCount} ${cartItemCount === 1 ? 'item is' : 'items are'} waiting in the cart.`
            : 'Find drinks, add them to the cart, take payment.'}
          hot="F1"
          onClick={() => onNavigate('sale')}
        />
        <div className="contents">
          <ActionTile illustration="customers" label="Customers" caption="Who owes money. Take a payment." hot="F6" onClick={() => onNavigate('customers')} />
          <ActionTile illustration="money-out" label="Money out" caption="Expenses and money taken from the drawer." hot="F2" onClick={() => onNavigate('moneyOut')} />
          <ActionTile
            illustration="receive-stock"
            label="Receive stock"
            caption={counts.myStockRequests > 0
              ? `${counts.myStockRequests} of your deliveries ${counts.myStockRequests === 1 ? 'is' : 'are'} waiting for approval.`
              : 'Record a delivery from a supplier.'}
            kind={counts.myStockRequests > 0 ? 'warn' : 'default'}
            badge={counts.myStockRequests}
            hot="F8"
            onClick={() => onNavigate('stock')}
          />
          <ActionTile
            illustration="recent-sales"
            label="Recent sales"
            caption={counts.myVoidRequests > 0
              ? `${counts.myVoidRequests} of your cancel requests ${counts.myVoidRequests === 1 ? 'is' : 'are'} waiting.`
              : 'See receipts. Ask to cancel a sale.'}
            kind={counts.myVoidRequests > 0 ? 'warn' : 'default'}
            badge={counts.myVoidRequests}
            hot="F11"
            onClick={() => onNavigate('void')}
          />
          <div>
          <ActionTile illustration="summary" label="Today’s summary" caption="Money in, stock and alerts for today." hot="F5" onClick={() => onNavigate('summary')} />
          </div>
        </div>
      </section>

      <section aria-label="More actions" className="flex flex-col gap-3">
        <MenuGroup id="stock" title="Stock tools" illustration="stock-tools" badge={stockBadge} open={open.stock} onToggle={toggle}>
          <ActionTile size="compact" illustration="stock-tools" label="Count stock" caption="Stocktake" hot="F4" onClick={() => onNavigate('stocktake')} />
          <ActionTile size="compact" illustration="breakage" label="Damaged stock" caption="Report breakage with a photo" hot="F7" onClick={() => onNavigate('breakage')} />
          <ActionTile size="compact" illustration="drink" label="Staff drinks" caption="Log a drink a worker took" hot="F3" onClick={() => onNavigate('consumption')} />
          {isSenior && (
            <ActionTile
              size="compact" illustration="approvals" label="Approve deliveries"
              caption={counts.reviewableStockRequests > 0 ? `${counts.reviewableStockRequests} waiting for you` : 'Stock approvals'}
              kind={counts.reviewableStockRequests > 0 ? 'warn' : 'default'}
              badge={counts.reviewableStockRequests}
              onClick={() => onNavigate('stockApprovals')}
            />
          )}
        </MenuGroup>

        <MenuGroup id="orders" title="Orders & receipts" illustration="orders" badge={ordersBadge} open={open.orders} onToggle={toggle}>
          <ActionTile
            size="compact" illustration="orders" label="WhatsApp orders"
            caption={counts.pendingOrders > 0 ? `${counts.pendingOrders} waiting for your decision` : 'Accept or decline orders'}
            kind={counts.pendingOrders > 0 ? 'warn' : 'default'}
            badge={counts.pendingOrders}
            onClick={() => onNavigate('pendingOrders')}
          />
          <ActionTile size="compact" illustration="paper-receipts" label="Paper receipts" caption="Check photographed receipts" onClick={() => onNavigate('paperReceipts')} />
          {isSenior && (
            <ActionTile
              size="compact" illustration="approvals" label="Review sale cancellations"
              caption={counts.reviewableVoidRequests > 0 ? `${counts.reviewableVoidRequests} waiting for you` : 'Void approvals'}
              kind={counts.reviewableVoidRequests > 0 ? 'warn' : 'default'}
              badge={counts.reviewableVoidRequests}
              onClick={() => onNavigate('voidApprovals')}
            />
          )}
        </MenuGroup>

        <MenuGroup id="manage" title="Manage shop" illustration="manage" badge={manageBadge} open={open.manage} onToggle={toggle}>
          <ActionTile size="compact" illustration="reports" label="Reports" caption="Sales, profit, cash, who owes you" onClick={() => onNavigate('reports')} />
          {isSenior && (
            <ActionTile
              size="compact" illustration="variance" label="Differences to check"
              caption={counts.openVarianceCases > 0
                ? `${counts.openVarianceCases} open · ${counts.overdueVarianceCases} overdue · ${formatMoneyWithCurrency(counts.unresolvedVariancePesewas)}`
                : 'Variance cases'}
              kind={counts.overdueVarianceCases > 0 ? 'warn' : 'default'}
              badge={counts.openVarianceCases}
              onClick={() => onNavigate('varianceCases')}
            />
          )}
          <ActionTile size="compact" illustration="settings" label="Settings" caption="Workers, products, printer, change PIN" hot="F12" onClick={() => onNavigate('settings')} />
        </MenuGroup>
      </section>

      <div className="pt-2 border-t-2 border-dashed border-border">
        <button
          type="button"
          onClick={onCloseShift}
          className="w-full sm:w-auto flex items-center gap-4 min-h-16 rounded-2xl border-2 border-warning bg-bg-elevated px-5 py-3 text-left hover:bg-bg-surface"
        >
          <TaskIllustration name="close-shift" size={48} />
          <span className="flex-1">
            <span className="block text-xl font-semibold text-text-primary">Close shift</span>
            <span className="block text-lg text-text-secondary">Count the drawer at the end of the day.</span>
          </span>
          <span aria-hidden className="hidden sm:inline-flex"><span className="kbd">F10</span></span>
        </button>
      </div>
    </div>
  );
}

function MenuGroup({ id, title, illustration, badge, open, onToggle, children }: {
  id: GroupId; title: string; illustration: IllustrationName; badge: number;
  open: boolean; onToggle: (id: GroupId) => void; children: ReactNode;
}) {
  const panelId = `friendly-group-${id}`;
  return (
    <div className="rounded-2xl border-2 border-border bg-bg-surface">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => onToggle(id)}
        className="w-full flex items-center gap-4 min-h-16 px-4 py-2 text-left rounded-2xl hover:bg-bg-elevated"
      >
        <TaskIllustration name={illustration} size={44} />
        <span className="flex-1 text-xl font-semibold text-text-primary">{title}</span>
        {badge > 0 && (
          <span className="min-w-9 h-9 px-2 rounded-full bg-warning text-ink text-lg font-bold flex items-center justify-center tnum">
            <span className="sr-only">waiting: </span>{badge}
          </span>
        )}
        <span aria-hidden className={`text-2xl text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`}>⌄</span>
      </button>
      <div id={panelId} role="region" aria-label={title} hidden={!open} className={`${open ? 'grid' : 'hidden'} grid-cols-1 @2xl:grid-cols-2 gap-3 px-4 pb-4 animate-reveal`}>
        {children}
      </div>
    </div>
  );
}
