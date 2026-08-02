// CustomerDetailScreen: balance + utilization + open sales (aging) + history.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { CustomerStatementModal } from '../components/CustomerStatementModal';
import { PriceOverridesModal } from '../components/PriceOverridesModal';
import { CustomerReturnModal } from '../components/CustomerReturnModal';
import { ReceiptPrintModal } from '../components/ReceiptPrintModal';
import type { SaleReceipt } from '../../shared/lib/receipt';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { CustomerEditModal } from '../components/CustomerEditModal';
import { useSession } from '../store/session';

interface Overview {
  id: string; displayName: string; phone: string; customerType: string;
  alternatePhone: string | null; businessName: string | null; locationDescription: string | null;
  cashOnly: boolean;
  creditLimitPesewas: number; creditTermsDays: number;
  preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null; notes: string | null;
  cachedBalancePesewas: number; trueBalancePesewas: number; driftPesewas: number;
  blocked: boolean; blockedReason: string | null;
  utilizationBps: number;
  ageOfOldestUnpaidDays: number | null;
  agingBuckets: { bucket0_30: number; bucket31_60: number; bucket61_90: number; bucket90_plus: number };
  recentSales: Array<{ id: string; createdAt: string; totalPesewas: number; creditPesewas: number; amountOutstandingPesewas: number; voided: boolean }>;
  recentPayments: Array<{ id: string; receivedAt: string; amountPesewas: number; paymentMethod: string; paymentReference: string | null }>;
}
type DebtStatus = 'CURRENT' | 'OVERDUE' | 'PROMISED' | 'RECOVERABLE' | 'DOUBTFUL' | 'DEAD';
type ContactMethod = 'CALL' | 'WHATSAPP' | 'VISIT' | 'IN_PERSON' | 'SMS' | 'OTHER';
type FollowupOutcome = 'NO_ANSWER' | 'PROMISED_TO_PAY' | 'PART_PAID' | 'DISPUTED' | 'REFUSED' | 'REMINDER_SENT' | 'OTHER';
interface OpenSale {
  saleId: string; createdAt: string; totalPesewas: number; creditPesewas: number;
  paidPesewas: number; outstandingPesewas: number; ageDays: number;
  dueDate: string | null; daysOverdue: number | null; debtStatus: DebtStatus;
}
interface DebtCollection {
  customerId: string;
  totalOutstandingPesewas: number;
  oldestOverdueDays: number | null;
  openSales: Array<{
    saleId: string; customerId: string; customerName: string; phone: string;
    createdAt: string; totalPesewas: number; creditPesewas: number; paidPesewas: number;
    outstandingPesewas: number; dueDate: string | null; daysOverdue: number | null;
    debtStatus: DebtStatus; cashOnly: boolean; creditLimitPesewas: number;
    lastFollowUpAt: string | null; nextFollowUpAt: string | null;
    openPromise: { id: string; promisedAmountPesewas: number; promiseDueDate: string; status: string; notes: string | null } | null;
  }>;
  recentFollowUps: Array<{ id: string; saleId: string | null; contactMethod: ContactMethod; outcome: FollowupOutcome; notes: string | null; nextFollowUpAt: string | null; createdAt: string; workerName: string }>;
  promises: Array<{ id: string; saleId: string | null; promisedAmountPesewas: number; promiseDueDate: string; status: 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED'; notes: string | null; createdAt: string; updatedAt: string }>;
}

export default function CustomerDetailScreen({
  customerId, onExit, onRecordPayment,
}: {
  customerId: string;
  onExit: () => void;
  onRecordPayment: (c: { customerId: string; displayName: string }) => void;
}) {
  const [tab, setTab] = useState<'open' | 'history' | 'collection'>('open');
  const [overview, setOverview] = useState<Overview | null>(null);
  const [openSales, setOpenSales] = useState<OpenSale[]>([]);
  const [debt, setDebt] = useState<DebtCollection | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showStatement, setShowStatement] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);
  const [showReturn, setShowReturn] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [receiptDetail, setReceiptDetail] = useState<{ receipt: SaleReceipt; amountOutstandingPesewas: number | null; amountPaidPesewas: number } | null>(null);
  const [loadingReceiptId, setLoadingReceiptId] = useState<string | null>(null);
  const workerRole = useSession((state) => state.workerRole);
  const canEditCreditPolicy = workerRole === 'SUPERVISOR' || workerRole === 'OWNER' || workerRole === 'FOUNDER';

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
    const d = await counter.debtCollectionGet(customerId);
    if (d.success) setDebt(d.data);
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

  async function setDebtStatus(saleId: string, status: DebtStatus) {
    setActionError(null);
    const r = await counter.debtStatusSet(saleId, status);
    if (!r.success) { setActionError(r.error); return; }
    setInfo(`Debt status set to ${status}.`);
    setTimeout(() => setInfo(null), 3500);
    await refresh();
  }

  async function updatePromise(promiseId: string, status: 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED') {
    setActionError(null);
    const r = await counter.paymentPromiseUpdate(promiseId, status);
    if (!r.success) { setActionError(r.error); return; }
    setInfo(`Promise marked ${status}.`);
    setTimeout(() => setInfo(null), 3500);
    await refresh();
  }

  if (!overview) return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex items-center justify-center">Loading…</div>
  );

  const utilPct = Math.min(150, Math.round(overview.utilizationBps / 100));
  const utilTone = utilPct >= 100 ? 'bg-danger' : utilPct >= 80 ? 'bg-warning' : 'bg-success';

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="customer detail" onBack={onExit} />
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-12 py-6 flex flex-col gap-5">
        <div className="flex items-baseline justify-between">
          <div>
            <div className="text-2xl font-semibold">{overview.displayName}</div>
            <div className="text-text-tertiary text-sm font-mono tnum">
              {overview.phone} · {overview.customerType}{overview.cashOnly ? ' · cash-only' : ''}
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-3">
            <button onClick={() => setShowEdit(true)} className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Edit customer
            </button>
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

        {info && <FeedbackBanner tone="success">{info}</FeedbackBanner>}
        {actionError && <FeedbackBanner>{actionError}</FeedbackBanner>}
        {overview.driftPesewas !== 0 && (
          <FeedbackBanner tone="warning" className="flex items-center justify-between gap-3">
            <span>Cached balance ({formatMoney(overview.cachedBalancePesewas)}) differs from truth ({formatMoney(overview.trueBalancePesewas)}) by {formatMoney(overview.driftPesewas)} pesewas.</span>
            <button onClick={() => void reconcile()} className="px-3 py-1 border border-warning hover:bg-warning hover:text-ink">
              Reconcile
            </button>
          </FeedbackBanner>
        )}
        {overview.blocked && (
          <FeedbackBanner>
            Blocked: {overview.blockedReason ?? '(no reason recorded)'}
          </FeedbackBanner>
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
          <TabBtn active={tab === 'collection'} onClick={() => setTab('collection')}>Collection</TabBtn>
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
                  <th className="px-4 py-3 text-left">Due</th>
                  <th className="px-4 py-3 text-left">Status</th>
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
                    <td className={`px-4 py-2 font-mono tnum ${s.daysOverdue != null ? 'text-warning' : 'text-text-tertiary'}`}>
                      {s.dueDate ?? '—'}{s.daysOverdue != null ? ` · ${s.daysOverdue}d late` : ''}
                    </td>
                    <td className="px-4 py-2">{s.debtStatus}</td>
                    <td className={`px-4 py-2 text-right font-mono tnum ${s.ageDays > 90 ? 'text-danger' : s.ageDays > 30 ? 'text-warning' : ''}`}>{s.ageDays}d</td>
                  </tr>
                ))}
                {openSales.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-4 text-text-tertiary text-center">No outstanding balance.</td></tr>
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

        {tab === 'collection' && debt && (
          <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4">
            <div className="bg-bg-surface border border-border">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <div className="text-text-secondary uppercase tracking-wider text-xs">Recovery ledger</div>
                <div className="text-text-tertiary text-xs">
                  {debt.oldestOverdueDays == null ? 'nothing overdue' : `oldest overdue ${debt.oldestOverdueDays}d`}
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-secondary text-xs uppercase tracking-wider">
                    <th className="px-4 py-3 text-left">Sale</th>
                    <th className="px-4 py-3 text-right">Due</th>
                    <th className="px-4 py-3 text-left">Recovery</th>
                    <th className="px-4 py-3 text-left">Next</th>
                  </tr>
                </thead>
                <tbody>
                  {debt.openSales.map((s) => (
                    <tr key={s.saleId} className="border-t border-border">
                      <td className="px-4 py-3">
                        <button onClick={() => void openReceipt(s.saleId)} className="font-mono tnum text-accent hover:text-accent-light">
                          #{s.saleId.slice(-6)}
                        </button>
                        <div className="text-text-tertiary text-xs">
                          {new Date(s.createdAt).toLocaleDateString()} · credit {formatMoney(s.creditPesewas)} · open {formatMoney(s.outstandingPesewas)}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tnum">
                        {s.dueDate ?? '—'}
                        <div className={s.daysOverdue != null ? 'text-warning text-xs' : 'text-text-tertiary text-xs'}>
                          {s.daysOverdue != null ? `${s.daysOverdue}d late` : 'current'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <select
                          value={s.debtStatus}
                          onChange={(e) => void setDebtStatus(s.saleId, e.target.value as DebtStatus)}
                          className="bg-bg-input border border-border-strong px-2 py-1 text-sm"
                        >
                          {(['CURRENT', 'OVERDUE', 'PROMISED', 'RECOVERABLE', 'DOUBTFUL', 'DEAD'] as DebtStatus[]).map((st) => (
                            <option key={st} value={st}>{st}</option>
                          ))}
                        </select>
                        {s.openPromise && (
                          <div className="text-text-tertiary text-xs mt-1">
                            promised {formatMoney(s.openPromise.promisedAmountPesewas)} by {s.openPromise.promiseDueDate}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div>{s.nextFollowUpAt ?? '—'}</div>
                        {s.lastFollowUpAt && <div className="text-text-tertiary">last {new Date(s.lastFollowUpAt).toLocaleDateString()}</div>}
                      </td>
                    </tr>
                  ))}
                  {debt.openSales.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-4 text-text-tertiary text-center">No debts to collect.</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-col gap-4">
              <FollowUpForm
                sales={debt.openSales}
                onSubmit={async (payload) => {
                  setActionError(null);
                  const r = await counter.debtFollowupRecord({ customerId, ...payload });
                  if (!r.success) { setActionError(r.error); return; }
                  setInfo(payload.outcome === 'PROMISED_TO_PAY' ? 'Follow-up and promise recorded.' : 'Follow-up recorded.');
                  setTimeout(() => setInfo(null), 3500);
                  await refresh();
                }}
              />

              <div className="bg-bg-surface border border-border">
                <div className="px-4 py-3 text-text-secondary uppercase tracking-wider text-xs border-b border-border">Promises</div>
                <ul className="divide-y divide-border text-sm">
                  {debt.promises.map((p) => (
                    <li key={p.id} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-mono tnum">{formatMoney(p.promisedAmountPesewas)} by {p.promiseDueDate}</div>
                          <div className="text-text-tertiary text-xs">{p.status}{p.saleId ? ` · #${p.saleId.slice(-6)}` : ''}</div>
                        </div>
                        <select
                          value={p.status}
                          onChange={(e) => void updatePromise(p.id, e.target.value as 'OPEN' | 'KEPT' | 'BROKEN' | 'CANCELLED')}
                          className="bg-bg-input border border-border-strong px-2 py-1 text-xs"
                        >
                          {(['OPEN', 'KEPT', 'BROKEN', 'CANCELLED'] as const).map((st) => <option key={st} value={st}>{st}</option>)}
                        </select>
                      </div>
                      {p.notes && <div className="text-text-tertiary text-xs mt-1">{p.notes}</div>}
                    </li>
                  ))}
                  {debt.promises.length === 0 && <li className="px-4 py-3 text-text-tertiary">No promises recorded.</li>}
                </ul>
              </div>

              <div className="bg-bg-surface border border-border">
                <div className="px-4 py-3 text-text-secondary uppercase tracking-wider text-xs border-b border-border">Recent follow-ups</div>
                <ul className="divide-y divide-border text-sm">
                  {debt.recentFollowUps.map((f) => (
                    <li key={f.id} className="px-4 py-3">
                      <div className="flex justify-between gap-3">
                        <span>{f.contactMethod} · {f.outcome}</span>
                        <span className="text-text-tertiary text-xs">{new Date(f.createdAt).toLocaleDateString()}</span>
                      </div>
                      <div className="text-text-tertiary text-xs">
                        {f.workerName}{f.saleId ? ` · #${f.saleId.slice(-6)}` : ''}{f.nextFollowUpAt ? ` · next ${f.nextFollowUpAt}` : ''}
                      </div>
                      {f.notes && <div className="text-text-secondary text-xs mt-1">{f.notes}</div>}
                    </li>
                  ))}
                  {debt.recentFollowUps.length === 0 && <li className="px-4 py-3 text-text-tertiary">No follow-ups yet.</li>}
                </ul>
              </div>
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
      {showEdit && (
        <CustomerEditModal
          customer={overview}
          canEditCreditPolicy={canEditCreditPolicy}
          onCancel={() => setShowEdit(false)}
          onSaved={() => {
            setShowEdit(false);
            setInfo('Customer information updated.');
            setTimeout(() => setInfo(null), 3500);
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

function FollowUpForm({
  sales,
  onSubmit,
}: {
  sales: DebtCollection['openSales'];
  onSubmit: (payload: {
    saleId: string | null;
    contactMethod: ContactMethod;
    outcome: FollowupOutcome;
    notes: string | null;
    nextFollowUpAt: string | null;
    promisedAmountPesewas?: number | null;
    promiseDueDate?: string | null;
  }) => Promise<void>;
}) {
  const [saleId, setSaleId] = useState<string>('');
  const [contactMethod, setContactMethod] = useState<ContactMethod>('CALL');
  const [outcome, setOutcome] = useState<FollowupOutcome>('REMINDER_SENT');
  const [notes, setNotes] = useState('');
  const [nextFollowUpAt, setNextFollowUpAt] = useState('');
  const [promisedAmount, setPromisedAmount] = useState('');
  const [promiseDueDate, setPromiseDueDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function submit() {
    setLocalError(null);
    const payload: Parameters<typeof onSubmit>[0] = {
      saleId: saleId || null,
      contactMethod,
      outcome,
      notes: notes.trim() || null,
      nextFollowUpAt: nextFollowUpAt || null,
    };
    if (outcome === 'PROMISED_TO_PAY') {
      const amount = parseCedisToPesewas(promisedAmount);
      if (amount == null || amount <= 0) { setLocalError('Promise amount must be positive.'); return; }
      if (!promiseDueDate) { setLocalError('Promise due date is required.'); return; }
      payload.promisedAmountPesewas = amount;
      payload.promiseDueDate = promiseDueDate;
    }
    setSubmitting(true);
    await onSubmit(payload);
    setSubmitting(false);
    setNotes('');
    setNextFollowUpAt('');
    setPromisedAmount('');
    setPromiseDueDate('');
  }

  return (
    <div className="bg-bg-surface border border-border p-4 flex flex-col gap-3">
      <div className="text-text-secondary uppercase tracking-wider text-xs">Record follow-up</div>
      <select value={saleId} onChange={(e) => setSaleId(e.target.value)}
        className="bg-bg-input border border-border-strong px-3 py-2 text-sm">
        <option value="">Customer-level note</option>
        {sales.map((s) => (
          <option key={s.saleId} value={s.saleId}>
            #{s.saleId.slice(-6)} · {formatMoney(s.outstandingPesewas)} open
          </option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-2">
        <select value={contactMethod} onChange={(e) => setContactMethod(e.target.value as ContactMethod)}
          className="bg-bg-input border border-border-strong px-3 py-2 text-sm">
          {(['CALL', 'WHATSAPP', 'VISIT', 'IN_PERSON', 'SMS', 'OTHER'] as ContactMethod[]).map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <select value={outcome} onChange={(e) => setOutcome(e.target.value as FollowupOutcome)}
          className="bg-bg-input border border-border-strong px-3 py-2 text-sm">
          {(['REMINDER_SENT', 'PROMISED_TO_PAY', 'PART_PAID', 'NO_ANSWER', 'DISPUTED', 'REFUSED', 'OTHER'] as FollowupOutcome[]).map((o) => (
            <option key={o} value={o}>{o}</option>
          ))}
        </select>
      </div>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Notes"
        className="bg-bg-input border border-border-strong px-3 py-2 text-sm min-h-20"
      />
      <label className="text-text-secondary text-xs uppercase tracking-wider">Next follow-up</label>
      <input type="date" value={nextFollowUpAt} onChange={(e) => setNextFollowUpAt(e.target.value)}
        className="bg-bg-input border border-border-strong px-3 py-2 text-sm" />
      {outcome === 'PROMISED_TO_PAY' && (
        <div className="grid grid-cols-2 gap-2">
          <input
            value={promisedAmount}
            onChange={(e) => setPromisedAmount(e.target.value)}
            placeholder="Promise amount"
            className="bg-bg-input border border-border-strong px-3 py-2 font-mono tnum text-sm"
          />
          <input type="date" value={promiseDueDate} onChange={(e) => setPromiseDueDate(e.target.value)}
            className="bg-bg-input border border-border-strong px-3 py-2 text-sm" />
        </div>
      )}
      {localError && <div className="text-danger text-sm">{localError}</div>}
      <button
        onClick={() => void submit()}
        disabled={submitting}
        className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light disabled:opacity-40"
      >
        {submitting ? 'Recording…' : 'Record follow-up'}
      </button>
    </div>
  );
}
