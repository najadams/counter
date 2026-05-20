// ExceptionsTab — derived outlier reports from audit_log + sales.
// OWNER/FOUNDER only. Daily-glance forensic surface.

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function daysAgoIso(n: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function ExceptionsTab() {
  const myRole = useSession((s) => s.workerRole);
  const isOwner = myRole === 'OWNER' || myRole === 'FOUNDER';

  const [fromDate, setFromDate] = useState(daysAgoIso(7));
  const [toDate, setToDate] = useState(todayIso());

  const [voids, setVoids] = useState<any[]>([]);
  const [discounts, setDiscounts] = useState<any[]>([]);
  const [edits, setEdits] = useState<any[]>([]);
  const [skuVoids, setSkuVoids] = useState<any[]>([]);
  const [bigDiscounts, setBigDiscounts] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    if (!isOwner) return;
    setLoading(true); setError(null);
    const [v, d, e, s, bd] = await Promise.all([
      counter.excVoidsByCashier(fromDate, toDate),
      counter.excDiscountsByCashier(fromDate, toDate),
      counter.excPostSaleEdits(fromDate, toDate),
      counter.excRepeatedSkuVoids(fromDate, toDate),
      counter.excLargeDiscounts(fromDate, toDate),
    ]);
    setLoading(false);
    if (!v.success || !d.success || !e.success || !s.success || !bd.success) {
      setError(
        (!v.success ? v.error : '')
        || (!d.success ? d.error : '')
        || (!e.success ? e.error : '')
        || (!s.success ? s.error : '')
        || (!bd.success ? bd.error : ''),
      );
      return;
    }
    setVoids(v.data.rows);
    setDiscounts(d.data.rows);
    setEdits(e.data.rows);
    setSkuVoids(s.data.rows);
    setBigDiscounts(bd.data.rows);
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, []);

  if (!isOwner) {
    return (
      <div className="bg-bg-elevated border border-border-subtle p-6 rounded text-text-tertiary">
        Exception reports are restricted to OWNER and FOUNDER roles.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">From</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            className="px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm" />
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">To</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            className="px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm" />
        </label>
        <button onClick={() => void refresh()}
          className="self-end bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light text-sm">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <div className="self-end ml-auto flex gap-2">
          <button className="px-3 py-2 border border-border text-sm" onClick={() => { setFromDate(daysAgoIso(0)); setToDate(todayIso()); setTimeout(() => void refresh(), 0); }}>Today</button>
          <button className="px-3 py-2 border border-border text-sm" onClick={() => { setFromDate(daysAgoIso(7)); setToDate(todayIso()); setTimeout(() => void refresh(), 0); }}>7d</button>
          <button className="px-3 py-2 border border-border text-sm" onClick={() => { setFromDate(daysAgoIso(30)); setToDate(todayIso()); setTimeout(() => void refresh(), 0); }}>30d</button>
        </div>
      </div>
      {error && <div className="bg-danger/10 border border-danger/40 text-danger text-sm px-3 py-2 rounded">{error}</div>}

      <Section title="Voids by cashier" subtitle="Who's voiding the most. Outliers ≠ proof, but always worth asking.">
        <Table headers={['Cashier', 'Role', 'Voids', 'Voided value']}>
          {voids.length === 0 ? <EmptyRow cols={4} /> : voids.map((r, i) => (
            <tr key={i} className="border-t border-border-subtle">
              <td className="px-3 py-2">{r.workerName}</td>
              <td className="px-3 py-2 text-text-tertiary">{r.workerRole}</td>
              <td className="px-3 py-2 font-mono text-right">{r.voidCount}</td>
              <td className="px-3 py-2 font-mono text-right">{formatMoneyWithCurrency(r.voidValuePesewas)}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Discounts by cashier" subtitle="Total and largest discount given by each cashier.">
        <Table headers={['Cashier', 'Role', 'Discounted sales', 'Total discount', 'Largest']}>
          {discounts.length === 0 ? <EmptyRow cols={5} /> : discounts.map((r, i) => (
            <tr key={i} className="border-t border-border-subtle">
              <td className="px-3 py-2">{r.workerName}</td>
              <td className="px-3 py-2 text-text-tertiary">{r.workerRole}</td>
              <td className="px-3 py-2 font-mono text-right">{r.discountSaleCount}</td>
              <td className="px-3 py-2 font-mono text-right">{formatMoneyWithCurrency(r.totalDiscountPesewas)}</td>
              <td className="px-3 py-2 font-mono text-right">{formatMoneyWithCurrency(r.largestDiscountPesewas)}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Post-sale edits" subtitle="Any change to a sale after it was completed. Should be rare.">
        <Table headers={['When', 'Action', 'By', 'Sale', 'Original cashier']}>
          {edits.length === 0 ? <EmptyRow cols={5} /> : edits.map((r) => (
            <tr key={r.editAuditId} className="border-t border-border-subtle">
              <td className="px-3 py-2 font-mono text-xs">{new Date(r.editAt).toLocaleString()}</td>
              <td className="px-3 py-2"><span className="text-warning">{r.editAction}</span></td>
              <td className="px-3 py-2">{r.editWorkerName} ({r.editWorkerRole})</td>
              <td className="px-3 py-2 font-mono text-xs">{r.saleId.slice(-8)}</td>
              <td className="px-3 py-2 text-text-tertiary">{r.saleWorkerName}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Repeated SKU voids" subtitle="Same product voided 3+ times by the same cashier in one day. Classic shrinkage pattern.">
        <Table headers={['Date', 'Cashier', 'Product', 'Voids']}>
          {skuVoids.length === 0 ? <EmptyRow cols={4} /> : skuVoids.map((r, i) => (
            <tr key={i} className="border-t border-border-subtle">
              <td className="px-3 py-2 font-mono text-xs">{r.businessDate}</td>
              <td className="px-3 py-2">{r.workerName}</td>
              <td className="px-3 py-2">{r.productName}</td>
              <td className="px-3 py-2 font-mono text-right text-danger">{r.voidCount}</td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Large discounts" subtitle="Discounts ≥ ₵2.00 absolute or ≥ 5% of subtotal. Should always have a reason.">
        <Table headers={['When', 'Cashier', 'Total', 'Discount', '% of subtotal', 'Reason']}>
          {bigDiscounts.length === 0 ? <EmptyRow cols={6} /> : bigDiscounts.map((r) => (
            <tr key={r.saleId} className="border-t border-border-subtle">
              <td className="px-3 py-2 font-mono text-xs">{new Date(r.saleAt).toLocaleString()}</td>
              <td className="px-3 py-2">{r.workerName}</td>
              <td className="px-3 py-2 font-mono text-right">{formatMoneyWithCurrency(r.totalPesewas)}</td>
              <td className="px-3 py-2 font-mono text-right text-warning">{formatMoneyWithCurrency(r.discountPesewas)}</td>
              <td className="px-3 py-2 font-mono text-right">{(r.discountRatio * 100).toFixed(1)}%</td>
              <td className="px-3 py-2 text-text-secondary">{r.reason ?? '—'}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-elevated rounded border border-border-subtle">
      <div className="px-4 py-3 border-b border-border-subtle">
        <div className="font-semibold">{title}</div>
        <div className="text-xs text-text-tertiary">{subtitle}</div>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-bg-deep text-text-tertiary uppercase text-xs">
        <tr>{headers.map((h, i) => (
          <th key={i} className={`px-3 py-2 ${i >= 2 && /count|value|discount|%|voids/i.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>
        ))}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

function EmptyRow({ cols }: { cols: number }) {
  return <tr><td colSpan={cols} className="px-4 py-6 text-center text-text-tertiary">No matching events in this range.</td></tr>;
}
