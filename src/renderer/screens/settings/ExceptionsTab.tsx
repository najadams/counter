// ExceptionsTab — derived outlier reports from audit_log + sales.
// OWNER/FOUNDER only. Daily-glance forensic surface.

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

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
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">To</span>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
        <Button variant="primary" className="self-end" onClick={() => void refresh()}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
        <div className="self-end ml-auto flex gap-2">
          <Button onClick={() => { setFromDate(daysAgoIso(0)); setToDate(todayIso()); setTimeout(() => void refresh(), 0); }}>Today</Button>
          <Button onClick={() => { setFromDate(daysAgoIso(7)); setToDate(todayIso()); setTimeout(() => void refresh(), 0); }}>7d</Button>
          <Button onClick={() => { setFromDate(daysAgoIso(30)); setToDate(todayIso()); setTimeout(() => void refresh(), 0); }}>30d</Button>
        </div>
      </div>
      {error && <FeedbackBanner>{error}</FeedbackBanner>}

      <Section title="Voids by cashier" subtitle="Who's voiding the most. Outliers ≠ proof, but always worth asking.">
        <ReportTable headers={['Cashier', 'Role', 'Voids', 'Voided value']}>
          {voids.length === 0 ? <EmptyRow cols={4} /> : voids.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="px-3 py-2">{r.workerName}</TableCell>
              <TableCell className="px-3 py-2 text-text-tertiary">{r.workerRole}</TableCell>
              <TableCell className="px-3 py-2 font-mono text-right">{r.voidCount}</TableCell>
              <TableCell className="px-3 py-2 font-mono text-right">{formatMoneyWithCurrency(r.voidValuePesewas)}</TableCell>
            </TableRow>
          ))}
        </ReportTable>
      </Section>

      <Section title="Discounts by cashier" subtitle="Total and largest discount given by each cashier.">
        <ReportTable headers={['Cashier', 'Role', 'Discounted sales', 'Total discount', 'Largest']}>
          {discounts.length === 0 ? <EmptyRow cols={5} /> : discounts.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="px-3 py-2">{r.workerName}</TableCell>
              <TableCell className="px-3 py-2 text-text-tertiary">{r.workerRole}</TableCell>
              <TableCell className="px-3 py-2 font-mono text-right">{r.discountSaleCount}</TableCell>
              <TableCell className="px-3 py-2 font-mono text-right">{formatMoneyWithCurrency(r.totalDiscountPesewas)}</TableCell>
              <TableCell className="px-3 py-2 font-mono text-right">{formatMoneyWithCurrency(r.largestDiscountPesewas)}</TableCell>
            </TableRow>
          ))}
        </ReportTable>
      </Section>

      <Section title="Post-sale edits" subtitle="Any change to a sale after it was completed. Should be rare.">
        <ReportTable headers={['When', 'Action', 'By', 'Sale', 'Original cashier']}>
          {edits.length === 0 ? <EmptyRow cols={5} /> : edits.map((r) => (
            <TableRow key={r.editAuditId}>
              <TableCell className="px-3 py-2 font-mono text-xs">{new Date(r.editAt).toLocaleString()}</TableCell>
              <TableCell className="px-3 py-2"><span className="text-warning">{r.editAction}</span></TableCell>
              <TableCell className="px-3 py-2">{r.editWorkerName} ({r.editWorkerRole})</TableCell>
              <TableCell className="px-3 py-2 font-mono text-xs">{r.saleId.slice(-8)}</TableCell>
              <TableCell className="px-3 py-2 text-text-tertiary">{r.saleWorkerName}</TableCell>
            </TableRow>
          ))}
        </ReportTable>
      </Section>

      <Section title="Repeated SKU voids" subtitle="Same product voided 3+ times by the same cashier in one day. Classic shrinkage pattern.">
        <ReportTable headers={['Date', 'Cashier', 'Product', 'Voids']}>
          {skuVoids.length === 0 ? <EmptyRow cols={4} /> : skuVoids.map((r, i) => (
            <TableRow key={i}>
              <TableCell className="px-3 py-2 font-mono text-xs">{r.businessDate}</TableCell>
              <TableCell className="px-3 py-2">{r.workerName}</TableCell>
              <TableCell className="px-3 py-2">{r.productName}</TableCell>
              <TableCell className="px-3 py-2 font-mono text-right text-danger">{r.voidCount}</TableCell>
            </TableRow>
          ))}
        </ReportTable>
      </Section>

      <Section title="Large discounts" subtitle="Discounts ≥ ₵2.00 absolute or ≥ 5% of subtotal. Should always have a reason.">
        <ReportTable headers={['When', 'Cashier', 'Total', 'Discount', '% of subtotal', 'Reason']}>
          {bigDiscounts.length === 0 ? <EmptyRow cols={6} /> : bigDiscounts.map((r) => (
            <TableRow key={r.saleId}>
              <TableCell className="px-3 py-2 font-mono text-xs">{new Date(r.saleAt).toLocaleString()}</TableCell>
              <TableCell className="px-3 py-2">{r.workerName}</TableCell>
              <TableCell className="px-3 py-2 font-mono text-right">{formatMoneyWithCurrency(r.totalPesewas)}</TableCell>
              <TableCell className="px-3 py-2 font-mono text-right text-warning">{formatMoneyWithCurrency(r.discountPesewas)}</TableCell>
              <TableCell className="px-3 py-2 font-mono text-right">{(r.discountRatio * 100).toFixed(1)}%</TableCell>
              <TableCell className="px-3 py-2 text-text-secondary">{r.reason ?? '—'}</TableCell>
            </TableRow>
          ))}
        </ReportTable>
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

function ReportTable({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>{headers.map((h, i) => (
          <TableHead key={i} className={`px-3 py-2 ${i >= 2 && /count|value|discount|%|voids/i.test(h) ? 'text-right' : 'text-left'}`}>{h}</TableHead>
        ))}</TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

function EmptyRow({ cols }: { cols: number }) {
  return <TableRow><TableCell colSpan={cols} className="px-4 py-6 text-center text-text-tertiary">No matching events in this range.</TableCell></TableRow>;
}
