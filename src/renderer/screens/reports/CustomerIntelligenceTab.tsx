import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../../shared/lib/money';
import type { ReportsCustomerIntelligenceResponse } from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Input } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

export function CustomerIntelligenceTab({ reportAccessToken }: { reportAccessToken: string }) {
  const [data, setData] = useState<ReportsCustomerIntelligenceResponse | null>(null);
  const [inactiveDays, setInactiveDays] = useState(30);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await counter.reportsCustomerIntelligence({ inactiveDays, reportAccessToken });
      if (!r.success) { setError(r.error); return; }
      setData(r.data); setError(null);
    })();
  }, [inactiveDays, reportAccessToken]);

  if (error) return <FeedbackBanner>{error}</FeedbackBanner>;
  if (!data) return <div className="text-text-tertiary text-sm">Loading…</div>;

  const totalValue = data.rows.reduce((sum, r) => sum + r.totalValuePesewas, 0);
  const monthlyValue = data.rows.reduce((sum, r) => sum + r.monthlyValuePesewas, 0);

  return (
    <div className="flex flex-col gap-5">
      <section className="panel p-4 flex items-center justify-between gap-3">
        <div className="grid grid-cols-2 @xl:grid-cols-4 gap-4 flex-1">
          <Stat label="Customers" value={String(data.rows.length)} />
          <Stat label="Inactive" value={String(data.inactive.length)} />
          <Stat label="Lifetime value" value={formatMoneyWithCurrency(totalValue)} />
          <Stat label="This month" value={formatMoneyWithCurrency(monthlyValue)} />
        </div>
        <label className="text-text-secondary text-xs uppercase tracking-wider">
          Inactive days
          <Input className="mt-1 w-24"
            type="number"
            min={1}
            value={inactiveDays}
            onChange={(e) => setInactiveDays(Math.max(1, Number(e.target.value) || 30))} />
        </label>
      </section>

      <section className="panel">
        <Header title="Customer value and frequency" count={data.rows.length} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead className="text-right">Class</TableHead>
              <TableHead className="text-right">Purchases</TableHead>
              <TableHead className="text-right">Freq.</TableHead>
              <TableHead className="text-right">Inactive</TableHead>
              <TableHead className="text-right">Monthly</TableHead>
              <TableHead className="text-right">Lifetime</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((r) => (
              <TableRow key={r.customerId}>
                <TableCell className="px-4 py-2">{r.name}<span className="text-text-tertiary text-xs ml-2">{r.phone ?? ''}</span></TableCell>
                <TableCell className="px-4 py-2 text-right font-mono tnum">{r.abcClass}</TableCell>
                <TableCell className="px-4 py-2 text-right font-mono tnum">{r.purchaseCount}</TableCell>
                <TableCell className="px-4 py-2 text-right font-mono tnum">
                  {r.purchaseFrequencyDays == null ? '—' : `${r.purchaseFrequencyDays}d`}
                </TableCell>
                <TableCell className={`px-4 py-2 text-right font-mono tnum ${r.daysInactive == null || r.daysInactive >= inactiveDays ? 'text-warning' : 'text-text-tertiary'}`}>
                  {r.daysInactive == null ? 'never' : `${r.daysInactive}d`}
                </TableCell>
                <TableCell className="px-4 py-2 text-right font-mono tnum">{formatMoney(r.monthlyValuePesewas)}</TableCell>
                <TableCell className="px-4 py-2 text-right font-mono tnum">{formatMoney(r.totalValuePesewas)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="panel">
        <Header title="Top products per customer" count={data.topProducts.length} />
        <div className="divide-y divide-border-subtle">
          {data.topProducts.slice(0, 80).map((r, index) => (
            <div key={`${r.customerId}-${r.productId}-${index}`} className="px-4 py-3 text-sm flex justify-between gap-3">
              <div>
                <div>{r.customerName}</div>
                <div className="text-text-tertiary text-xs">{r.productName} · {r.sku}</div>
              </div>
              <div className="text-right font-mono tnum">
                {formatMoney(r.revenuePesewas)}
                <div className="text-text-tertiary text-xs">{r.unitsSold} unit(s)</div>
              </div>
            </div>
          ))}
          {data.topProducts.length === 0 && <div className="px-4 py-6 text-text-tertiary text-sm text-center">No customer product history yet.</div>}
        </div>
      </section>
    </div>
  );
}

function Header({ title, count }: { title: string; count: number }) {
  return (
    <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
      <h3 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h3>
      <span className="text-text-tertiary text-xs">{count}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-text-tertiary uppercase tracking-wider text-xs">{label}</div>
      <div className="font-mono tnum text-xl mt-1">{value}</div>
    </div>
  );
}
