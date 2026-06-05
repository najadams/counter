// CustomerDetailScreen: balance + utilization + open sales (aging) + history.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { CustomerStatementModal } from '../components/CustomerStatementModal';
import { PriceOverridesModal } from '../components/PriceOverridesModal';
import { CustomerReturnModal } from '../components/CustomerReturnModal';
import { ReceiptPrintModal } from '../components/ReceiptPrintModal';
import type { SaleReceipt } from '../../shared/lib/receipt';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';

interface Overview {
  id: string; displayName: string; phone: string; customerType: string;
  creditLimitPesewas: number;
  cachedBalancePesewas: number; trueBalancePesewas: number; driftPesewas: number;
  blocked: boolean; blockedReason: string | null;
  utilizationBps: number;
  ageOfOldestUnpaidDays: number | null;
  agingBuckets: { bucket0_30: number; bucket31_60: number; bucket61_90: number; bucket90_plus: number };
  recentSales: Array<{ id: string; createdAt: string; totalPesewas: number; amountOutstandingPesewas: number; voided: boolean }>;
  recentPayments: Array<{ id: string; receivedAt: string; amountPesewas: number; paymentMethod: string; paymentReference: string | null }>;
}
interface OpenSale { saleId: string; createdAt: string; totalPesewas: number; paidPesewas: number; outstandingPesewas: number; ageDays: number }

export default function CustomerDetailScreen({
  customerId, onExit, onRecordPayment,
}: {
  customerId: string;
  onExit: () => void;
  onRecordPayment: (c: { customerId: string; displayName: string }) => void;
}) {
  const [tab, setTab] = useState<'open' | 'history'>('open');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [openSales, setOpenSales] = useState<OpenSale[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const [showStatement, setShowStatement] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);
  const [showReturn, setShowReturn] = useState(false);
  const [receiptDetail, setReceiptDetail] = useState<{ receipt: SaleReceipt; amountOutstandingPesewas: number | null; amountPaidPesewas: number } | null>(null);
  const [loadingReceiptId, setLoadingReceiptId] = useState<string | null>(null);

  async function openReceipt(saleId: string) {
    setLoadingReceiptId(saleId);
    const r = await counter.getSaleReceipt(saleId);
    setLoadingReceiptId(null);
    if (!r.success) {
      setInfo(`Failed to load receipt: ${r.error}`);
      setTimeout(() => setInfo(null), 4000);
      return;
    }
    setReceiptDetail(r.data);
  }

  async function refresh() {
    const o = await counter.customerOverview(customerId);
    if (o.success) setOverview(o.data);
    const s = await counter.customerOpenSales(customerId);
    if (s.success) setOpenSales(s.data.sales);
  }
  useEffect(() => { void refresh(); }, [customerId]);

  async function reconcile() {
    const r = await counter.reconcileCustomer(customerId);
    if (r.success) {
      setInfo(`Reconciled. Drift was ${r.data.driftPesewas} pesewas.`);
      setTimeout(() => setInfo(null), 4000);
      await refresh();
    }
  }

  if (!overview) return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex items-center justify-center">Loading…</div>
  );

  const utilPct = Math.min(150, Math.round(overview.utilizationBps / 100));
  const utilTone = utilPct >= 100 ? 'bg-danger' : utilPct >= 80 ? 'bg-warning' : 'bg-success';

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="customer detail" />
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-12 py-6 flex flex-col gap-5">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-2xl font-semibold">{overview.displayName}</div>
            <div className="text-text-tertiary text-sm font-mono tnum">{overview.phone} · {overview.customerType}</div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => onRecordPayment({ customerId: overview.id, displayName: overview.displayName })}
              className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light">
              Record payment
            </button>
            <button onClick={() => setShowStatement(true)}
              className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Print statement
            </button>
            <button onClick={() => setShowOverrides(true)}
              className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Price overrides
            </button>
            <button onClick={() => setShowReturn(true)}
              className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Record return
            </button>
            <button onClick={onExit} className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Back <span className="kbd">F9</span>
            </button>
          </div>
        </div>

        {info && <div className="bg-bg-surface border border-success px-4 py-2 text-success text-sm">{info}</div>}
        {overview.driftPesewas !== 0 && (
          <div className="bg-bg-surface border border-warning px-4 py-3 text-warning text-sm flex items-center justify-between">
            <span>Cached balance ({formatMoney(overview.cachedBalancePesewas)}) differs from truth ({formatMoney(overview.trueBalancePesewas)}) by {formatMoney(overview.driftPesewas)} pesewas.</span>
            <button onClick={() => void reconcile()} className="px-3 py-1 border border-warning hover:bg-warning hover:text-ink">
              Reconcile
            </button>
          </div>
        )}
        {overview.blocked && (
          <div className="bg-bg-surface border border-danger px-4 py-3 text-danger text-sm">
            Blocked: {overview.blockedReason ?? '(no reason recorded)'}
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div className="bg-bg-surface border border-border p-4">
            <div className="text-text-secondary uppercase tracking-wider text-xs">Owed to us</div>
            <div className="font-mono tnum text-3xl text-accent mt-1">{formatMoneyWithCurrency(overview.trueBalancePesewas)}</div>
            <div className="text-text-tertiary text-xs mt-1">
              {overview.ageOfOldestUnpaidDays === null ? 'no open sales' : `oldest ${overview.ageOfOldestUnpaidDays} days old`}
            </div>
          </div>
          <div className="bg-bg-surface border border-border p-4">
            <div className="text-text-secondary uppercase tracking-wider text-xs">Credit limit</div>
            <div className="font-mono tnum text-3xl mt-1">
              {overview.creditLimitPesewas > 0 ? formatMoneyWithCurrency(overview.creditLimitPesewas) : '—'}
            </div>
            {overview.creditLimitPesewas > 0 && (
              <div className="mt-2">
                <div className="bg-bg-deep h-2 w-full">
                  <div className={`${utilTone} h-2`} style={{ width: `${Math.min(100, utilPct)}%` }} />
                </div>
                <div className="text-text-tertiary text-xs mt-1">{utilPct}% utilized</div>
              </div>
            )}
          </div>
          <div className="bg-bg-surface border border-border p-4">
            <div className="text-text-secondary uppercase tracking-wider text-xs">Aging</div>
            <ul className="text-sm font-mono tnum mt-1 space-y-1">
              <li className="flex justify-between"><span className="text-text-secondary">0–30</span><span>{formatMoney(overview.agingBuckets.bucket0_30)}</span></li>
              <li className="flex justify-between"><span className="text-warning">31–60</span><span>{formatMoney(overview.agingBuckets.bucket31_60)}</span></li>
              <li className="flex justify-between"><span className="text-warning">61–90</span><span>{formatMoney(overview.agingBuckets.bucket61_90)}</span></li>
              <li className="flex justify-between"><span className="text-danger">90+</span><span>{formatMoney(overview.agingBuckets.bucket90_plus)}</span></li>
            </ul>
          </div>
        </div>

        <div className="flex">
          <TabBtn active={tab === 'open'} onClick={() => setTab('open')}>Open sales ({openSales.length})</TabBtn>
          <TabBtn active={tab === 'history'} onClick={() => setTab('history')}>Recent activity</TabBtn>
        </div>

        {tab === 'open' && (
          <div className="bg-bg-surface border border-border">
            <div className="px-4 py-2 text-text-tertiary text-xs border-b border-border">
              Click a row to see the items on that sale.
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-secondary text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 text-left">When</th>
                  <th className="px-4 py-3 text-right">Total</th>
                  <th className="px-4 py-3 text-right">Paid</th>
                  <th className="px-4 py-3 text-right">Outstanding</th>
                  <th className="px-4 py-3 text-right">Age</th>
                </tr>
              </thead>
              <tbody>
                {openSales.map((s) => (
                  <tr
                    key={s.saleId}
                    onClick={() => void openReceipt(s.saleId)}
                    className="border-t border-border cursor-pointer hover:bg-bg-elevated"
                    title="View receipt"
                  >
                    <td className="px-4 py-2 font-mono tnum">
                      {new Date(s.createdAt).toLocaleString()}
                      <span className="text-text-tertiary ml-2">#{s.saleId.slice(-6)}</span>
                      {loadingReceiptId === s.saleId && <span className="text-text-tertiary ml-2 text-xs">loading…</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono tnum">{formatMoney(s.totalPesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum text-text-tertiary">{formatMoney(s.paidPesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum text-accent">{formatMoney(s.outstandingPesewas)}</td>
                    <td className={`px-4 py-2 text-right font-mono tnum ${s.ageDays > 90 ? 'text-danger' : s.ageDays > 30 ? 'text-warning' : ''}`}>{s.ageDays}d</td>
                  </tr>
                ))}
                {openSales.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-4 text-text-tertiary text-center">No outstanding balance.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'history' && (
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-bg-surface border border-border">
              <div className="px-4 py-3 text-text-secondary uppercase tracking-wider text-xs border-b border-border">Recent sales</div>
              <ul className="divide-y divide-border text-sm">
                {overview.recentSales.map((s) => (
                  <li
                    key={s.id}
                    onClick={() => !s.voided && void openReceipt(s.id)}
                    className={`px-4 py-2 flex justify-between ${s.voided ? 'line-through text-text-tertiary' : 'cursor-pointer hover:bg-bg-elevated'}`}
                    title={s.voided ? 'Voided sale' : 'View receipt'}
                  >
                    <span className="font-mono tnum text-xs text-text-tertiary">
                      {new Date(s.createdAt).toLocaleDateString()}
                      <span className="ml-2">#{s.id.slice(-6)}</span>
                      {loadingReceiptId === s.id && <span className="ml-2">loading…</span>}
                    </span>
                    <span className="font-mono tnum">{formatMoney(s.totalPesewas)}{s.amountOutstandingPesewas > 0 ? ` (${formatMoney(s.amountOutstandingPesewas)} due)` : ''}</span>
                  </li>
                ))}
                {overview.recentSales.length === 0 && <li className="px-4 py-2 text-text-tertiary">none</li>}
              </ul>
            </div>
            <div className="bg-bg-surface border border-border">
              <div className="px-4 py-3 text-text-secondary uppercase tracking-wider text-xs border-b border-border">Recent payments</div>
              <ul className="divide-y divide-border text-sm">
                {overview.recentPayments.map((p) => (
                  <li key={p.id} className="px-4 py-2 flex justify-between">
                    <span className="font-mono tnum text-xs text-text-tertiary">
                      {new Date(p.receivedAt).toLocaleDateString()} · {p.paymentMethod}
                      {p.paymentReference ? ` · ${p.paymentReference}` : ''}
                    </span>
                    <span className="font-mono tnum text-success">{formatMoney(p.amountPesewas)}</span>
                  </li>
                ))}
                {overview.recentPayments.length === 0 && <li className="px-4 py-2 text-text-tertiary">none</li>}
              </ul>
            </div>
          </div>
        )}
      </main>
      {showStatement && (
        <CustomerStatementModal
          customerId={overview.id}
          onClose={() => setShowStatement(false)}
        />
      )}
      {showOverrides && (
        <PriceOverridesModal
          customerId={overview.id}
          customerName={overview.displayName}
          onClose={() => setShowOverrides(false)}
        />
      )}
      {showReturn && (
        <CustomerReturnModal
          customerId={overview.id}
          customerName={overview.displayName}
          onClose={() => setShowReturn(false)}
          onRecorded={(s) => {
            setShowReturn(false);
            setInfo(`Return recorded — refund ${formatMoney(s.totalRefundPesewas)}.`);
            setTimeout(() => setInfo(null), 4000);
            void refresh();
          }}
        />
      )}
      {receiptDetail && (
        <ReceiptPrintModal
          receipt={receiptDetail.receipt}
          amountPaidPesewas={receiptDetail.amountPaidPesewas}
          amountOutstandingPesewas={receiptDetail.amountOutstandingPesewas}
          onClose={() => setReceiptDetail(null)}
        />
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={[
        'px-5 py-2 text-sm uppercase tracking-wider border-b-2',
        active ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary',
      ].join(' ')}>{children}</button>
  );
}
