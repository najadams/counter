// CustomersScreen: aging-focused list of who owes us what.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';
import CustomerDetailScreen from './CustomerDetailScreen';
import { RecordPaymentModal } from '../components/RecordPaymentModal';
import { CustomerCreateModal } from '../components/CustomerCreateModal';

interface Row {
  id: string; displayName: string; phone: string; customerType: string;
  creditLimitPesewas: number; trueBalancePesewas: number; blocked: boolean;
  ageOfOldestUnpaidDays: number | null;
  oldestUnpaidBucket: 'bucket0_30' | 'bucket31_60' | 'bucket61_90' | 'bucket90_plus' | null;
  needsReconcile: boolean;
}
interface Aging { bucket0_30: number; bucket31_60: number; bucket61_90: number; bucket90_plus: number; total: number; blockedCount: number; needsReviewCount: number }

const BUCKET_LABEL: Record<string, string> = {
  bucket0_30: '0–30 days', bucket31_60: '31–60', bucket61_90: '61–90', bucket90_plus: '90+',
};

export default function CustomersScreen({ onExit }: { onExit: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [aging, setAging] = useState<Aging | null>(null);
  const [filter, setFilter] = useState('');
  const [bucket, setBucket] = useState<Row['oldestUnpaidBucket'] | null>(null);
  const [includeBlocked, setIncludeBlocked] = useState(false);
  const [includeZero, setIncludeZero] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<string | null>(null);
  const [showPay, setShowPay] = useState<{ customerId: string; displayName: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function refresh() {
    const r = await counter.listCustomersByOutstanding({
      ...(bucket ? { agingBucket: bucket } : {}),
      includeBlocked, includeZeroBalance: includeZero,
    });
    if (r.success) setRows(r.data.customers);
    const s = await counter.customerAgingSummary();
    if (s.success) setAging(s.data);
  }

  useEffect(() => {
    void refresh();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') {
        e.preventDefault();
        if (selectedCustomer) setSelectedCustomer(null);
        else if (showPay) setShowPay(null);
        else onExit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCustomer, showPay, onExit, bucket, includeBlocked, includeZero]);

  if (selectedCustomer) {
    return (
      <CustomerDetailScreen
        customerId={selectedCustomer}
        onExit={() => { setSelectedCustomer(null); void refresh(); }}
        onRecordPayment={(c) => setShowPay(c)}
      />
    );
  }

  const visible = rows.filter((r) =>
    !filter || r.displayName.toLowerCase().includes(filter.toLowerCase())
    || r.phone.includes(filter),
  );

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="customers — credit" />
      <main className="flex-1 max-w-6xl w-full mx-auto px-12 py-6 flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">Open balances</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowAdd(true)}
              className="bg-accent text-bg-deep px-4 py-2 font-semibold hover:bg-accent-light text-sm">
              + Add customer
            </button>
            <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
          </div>
        </div>

        {aging && (
          <div className="grid grid-cols-5 gap-3">
            <KPI label="0–30 days" value={formatMoney(aging.bucket0_30)} tone="ok"
              onClick={() => setBucket(bucket === 'bucket0_30' ? null : 'bucket0_30')}
              active={bucket === 'bucket0_30'} />
            <KPI label="31–60" value={formatMoney(aging.bucket31_60)} tone="warn"
              onClick={() => setBucket(bucket === 'bucket31_60' ? null : 'bucket31_60')}
              active={bucket === 'bucket31_60'} />
            <KPI label="61–90" value={formatMoney(aging.bucket61_90)} tone="warn"
              onClick={() => setBucket(bucket === 'bucket61_90' ? null : 'bucket61_90')}
              active={bucket === 'bucket61_90'} />
            <KPI label="90+ days" value={formatMoney(aging.bucket90_plus)} tone="bad"
              onClick={() => setBucket(bucket === 'bucket90_plus' ? null : 'bucket90_plus')}
              active={bucket === 'bucket90_plus'} />
            <KPI label="TOTAL OWED" value={formatMoneyWithCurrency(aging.total)} large />
          </div>
        )}

        <div className="flex items-center gap-3">
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or phone…"
            className="bg-bg-input border border-border-strong px-3 py-2 flex-1" />
          <label className="flex items-center gap-2 text-text-secondary text-sm">
            <input type="checkbox" checked={includeBlocked} onChange={(e) => setIncludeBlocked(e.target.checked)} />
            include blocked
          </label>
          <label className="flex items-center gap-2 text-text-secondary text-sm">
            <input type="checkbox" checked={includeZero} onChange={(e) => setIncludeZero(e.target.checked)} />
            include 0-balance
          </label>
          {bucket && (
            <button onClick={() => setBucket(null)}
              className="px-3 py-2 border border-border text-text-tertiary hover:text-text-primary text-sm">
              clear bucket: {BUCKET_LABEL[bucket]} ✕
            </button>
          )}
        </div>

        <div className="bg-bg-surface border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-xs uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Phone</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="px-4 py-3 text-right">Limit</th>
                <th className="px-4 py-3 text-left">Oldest unpaid</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const overLimit = r.creditLimitPesewas > 0 && r.trueBalancePesewas >= r.creditLimitPesewas;
                const tone = r.oldestUnpaidBucket === 'bucket90_plus' ? 'text-danger'
                  : r.oldestUnpaidBucket === 'bucket61_90' ? 'text-warning'
                  : r.oldestUnpaidBucket === 'bucket31_60' ? 'text-warning'
                  : 'text-text-primary';
                return (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <button onClick={() => setSelectedCustomer(r.id)} className="text-left hover:text-accent">
                        {r.displayName}
                        {r.needsReconcile && <span className="ml-2 text-warning text-xs">drift</span>}
                      </button>
                      <div className="text-text-tertiary text-xs">{r.customerType}</div>
                    </td>
                    <td className="px-4 py-3 font-mono tnum">{r.phone}</td>
                    <td className={`px-4 py-3 text-right font-mono tnum ${tone}`}>{formatMoney(r.trueBalancePesewas)}</td>
                    <td className={`px-4 py-3 text-right font-mono tnum ${overLimit ? 'text-warning' : 'text-text-tertiary'}`}>
                      {r.creditLimitPesewas > 0 ? formatMoney(r.creditLimitPesewas) : '—'}
                    </td>
                    <td className={`px-4 py-3 ${tone}`}>
                      {r.ageOfOldestUnpaidDays === null ? '—' : `${r.ageOfOldestUnpaidDays} days · ${BUCKET_LABEL[r.oldestUnpaidBucket!]}`}
                    </td>
                    <td className="px-4 py-3">
                      {r.blocked ? <span className="text-danger">blocked</span>
                        : overLimit ? <span className="text-warning">over limit</span>
                        : <span className="text-success">ok</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => setShowPay({ customerId: r.id, displayName: r.displayName })}
                        className="bg-accent text-bg-deep px-3 py-1 hover:bg-accent-light text-xs font-semibold">
                        Take payment
                      </button>
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-6 text-text-tertiary text-center">No customers match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>

      {showPay && (
        <RecordPaymentModal
          customerId={showPay.customerId}
          customerName={showPay.displayName}
          onCancel={() => setShowPay(null)}
          onDone={() => { setShowPay(null); void refresh(); }}
        />
      )}

      {showAdd && (
        <CustomerCreateModal
          onCancel={() => setShowAdd(false)}
          onCreated={() => { setShowAdd(false); void refresh(); }}
        />
      )}
    </div>
  );
}

function KPI({ label, value, tone = 'ok', large, onClick, active }: {
  label: string; value: string; tone?: 'ok' | 'warn' | 'bad'; large?: boolean;
  onClick?: () => void; active?: boolean;
}) {
  const c = tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning' : 'text-text-primary';
  const border = active ? 'border-accent' : 'border-border';
  const inner = (
    <>
      <div className="text-text-secondary uppercase tracking-wider text-xs">{label}</div>
      <div className={`font-mono tnum mt-1 ${large ? 'text-2xl text-accent' : 'text-xl ' + c}`}>{value}</div>
    </>
  );
  return onClick ? (
    <button onClick={onClick} className={`bg-bg-surface border ${border} p-4 text-left hover:bg-bg-elevated`}>
      {inner}
    </button>
  ) : (
    <div className={`bg-bg-surface border ${border} p-4`}>{inner}</div>
  );
}
