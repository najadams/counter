// SalesTab — date-ranged revenue with day/week/month grouping, plus
// breakdowns by channel, payment method, and cashier. CSV export.

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../../shared/lib/money';
import { DateRangePicker, defaultDateRange, type DateRange } from '../../components/DateRangePicker';
import { buildCsvFilename, exportRowsAsCsv, pesewasToCsvNumber } from '../../lib/csv';
import type { ReportsSalesResponse, ReportGroupBy } from '../../../shared/types/ipc';

export function SalesTab() {
  const [range, setRange] = useState<DateRange>(defaultDateRange());
  const [groupBy, setGroupBy] = useState<ReportGroupBy>('day');
  const [data, setData] = useState<ReportsSalesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await counter.reportsSales({
      fromDate: range.fromDate, toDate: range.toDate, groupBy,
    });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setData(r.data); setError(null);
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [range.fromDate, range.toDate, groupBy]);

  const peakBucket = useMemo(
    () => Math.max(0, ...(data?.buckets ?? []).map((b) => b.revenuePesewas)),
    [data],
  );

  function exportBuckets() {
    if (!data) return;
    exportRowsAsCsv(
      buildCsvFilename('sales_by_' + groupBy, [range.fromDate, range.toDate]),
      data.buckets,
      [
        { header: groupBy === 'day' ? 'date' : groupBy, get: (r) => r.bucket },
        { header: 'revenue_cedis', get: (r) => pesewasToCsvNumber(r.revenuePesewas) },
        { header: 'num_sales', get: (r) => r.numSales },
        { header: 'unique_customers', get: (r) => r.numUniqueCustomers },
        { header: 'avg_basket_cedis', get: (r) => pesewasToCsvNumber(r.avgBasketPesewas) },
        { header: 'walk_in_cedis', get: (r) => pesewasToCsvNumber(r.walkInPesewas) },
        { header: 'wholesale_cedis', get: (r) => pesewasToCsvNumber(r.wholesalePesewas) },
        { header: 'route_cedis', get: (r) => pesewasToCsvNumber(r.routePesewas) },
      ],
    );
  }
  function exportCashiers() {
    if (!data) return;
    exportRowsAsCsv(
      buildCsvFilename('sales_by_cashier', [range.fromDate, range.toDate]),
      data.byCashier,
      [
        { header: 'cashier', get: (r) => r.workerName },
        { header: 'revenue_cedis', get: (r) => pesewasToCsvNumber(r.revenuePesewas) },
        { header: 'num_sales', get: (r) => r.numSales },
        { header: 'voided_count', get: (r) => r.voidedCount },
      ],
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-bg-surface border border-border p-4 flex flex-col gap-3">
        <DateRangePicker value={range} onChange={setRange} />
        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-1 text-xs">
            {(['day', 'week', 'month'] as const).map((g) => (
              <button key={g} onClick={() => setGroupBy(g)}
                className={[
                  'px-3 py-1.5 border rounded-sm uppercase tracking-wider',
                  groupBy === g
                    ? 'bg-accent text-ink border-accent font-semibold'
                    : 'border-border text-text-secondary hover:text-text-primary',
                ].join(' ')}>
                Per {g}
              </button>
            ))}
          </div>
          <button onClick={exportBuckets} disabled={!data || data.buckets.length === 0}
            className="px-3 py-1.5 border border-border text-xs hover:bg-bg-elevated disabled:opacity-40">
            Export CSV
          </button>
        </div>
      </div>

      {error && <div className="bg-danger/10 border border-danger/40 text-danger text-sm px-3 py-2">{error}</div>}
      {loading && !data && <div className="text-text-tertiary text-sm">Loading…</div>}

      {data && (
        <>
          <section className="grid grid-cols-4 gap-4">
            <Stat label="Revenue" value={formatMoneyWithCurrency(data.totalRevenuePesewas)} />
            <Stat label="Sales" value={String(data.totalNumSales)} />
            <Stat label="Unique customers" value={String(data.totalUniqueCustomers)} />
            <Stat label="Avg basket"
              value={data.totalAvgBasketPesewas == null ? '—' : formatMoneyWithCurrency(data.totalAvgBasketPesewas)} />
          </section>

          {/* Buckets table */}
          <section className="bg-bg-surface border border-border">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-text-secondary uppercase tracking-wider text-xs">
                Revenue per {groupBy}
              </h3>
              <span className="text-text-tertiary text-xs">{data.buckets.length} bucket{data.buckets.length === 1 ? '' : 's'}</span>
            </div>
            {data.buckets.length === 0 ? (
              <div className="px-4 py-6 text-text-tertiary text-sm text-center">
                No sales in this date range.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-bg-deep/60 text-text-tertiary text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-4 py-2">When</th>
                    <th className="text-right px-4 py-2">Revenue</th>
                    <th className="text-right px-4 py-2">Sales</th>
                    <th className="text-right px-4 py-2">Cust.</th>
                    <th className="text-right px-4 py-2">Avg basket</th>
                    <th className="text-right px-4 py-2">Walk-in</th>
                    <th className="text-right px-4 py-2">Wholesale</th>
                    <th className="text-right px-4 py-2">Route</th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets.map((b) => {
                    const widthPct = peakBucket > 0 ? (b.revenuePesewas / peakBucket) * 100 : 0;
                    return (
                      <tr key={b.bucket} className="border-t border-border-subtle hover:bg-bg-elevated/40">
                        <td className="px-4 py-2 font-mono relative">
                          <span className="relative z-10">{b.bucket}</span>
                          <span
                            aria-hidden
                            className="absolute inset-y-0 left-0 bg-accent/10 pointer-events-none"
                            style={{ width: `${widthPct}%` }}
                          />
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">
                          {formatMoney(b.revenuePesewas)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{b.numSales}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">{b.numUniqueCustomers}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-text-secondary">
                          {b.avgBasketPesewas == null ? '—' : formatMoney(b.avgBasketPesewas)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                          {formatMoney(b.walkInPesewas)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                          {formatMoney(b.wholesalePesewas)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                          {formatMoney(b.routePesewas)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>

          {/* Breakdown grid */}
          <section className="grid grid-cols-3 gap-4">
            <BreakdownTable
              title="By channel" totalRev={data.totalRevenuePesewas}
              rows={data.byChannel.map((c) => ({ label: c.channel, rev: c.revenuePesewas, sub: `${c.numSales} sale${c.numSales === 1 ? '' : 's'}` }))}
            />
            <BreakdownTable
              title="By payment method" totalRev={data.totalRevenuePesewas}
              rows={data.byPaymentMethod.map((m) => ({ label: m.method, rev: m.revenuePesewas, sub: `${m.numSales} sale${m.numSales === 1 ? '' : 's'}` }))}
            />
            <div className="bg-bg-surface border border-border flex flex-col">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <h3 className="text-text-secondary uppercase tracking-wider text-xs">By cashier</h3>
                <button onClick={exportCashiers} disabled={data.byCashier.length === 0}
                  className="text-text-tertiary hover:text-accent text-xs disabled:opacity-40">
                  CSV
                </button>
              </div>
              {data.byCashier.length === 0 ? (
                <div className="px-4 py-4 text-text-tertiary text-sm">No sales by cashier yet.</div>
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {data.byCashier.map((c) => (
                      <tr key={c.workerId} className="border-t border-border-subtle">
                        <td className="px-4 py-2">
                          <div>{c.workerName}</div>
                          <div className="text-text-tertiary text-xs">
                            {c.numSales} sale{c.numSales === 1 ? '' : 's'}
                            {c.voidedCount > 0 && <span className="text-warning"> · {c.voidedCount} voided</span>}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">
                          {formatMoney(c.revenuePesewas)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg-surface border border-border p-4">
      <div className="text-text-tertiary uppercase tracking-wider text-xs">{label}</div>
      <div className="text-xl font-bold tabular-nums mt-1">{value}</div>
    </div>
  );
}

function BreakdownTable({
  title, rows, totalRev,
}: {
  title: string;
  totalRev: number;
  rows: Array<{ label: string; rev: number; sub: string }>;
}) {
  return (
    <div className="bg-bg-surface border border-border">
      <div className="px-4 py-3 border-b border-border-subtle">
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-4 text-text-tertiary text-sm">No data.</div>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => {
              const pct = totalRev > 0 ? (r.rev / totalRev) * 100 : 0;
              return (
                <tr key={r.label} className="border-t border-border-subtle">
                  <td className="px-4 py-2 relative">
                    <span className="relative z-10">
                      <div>{r.label}</div>
                      <div className="text-text-tertiary text-xs">{r.sub} · {pct.toFixed(1)}%</div>
                    </span>
                    <span aria-hidden className="absolute inset-y-0 left-0 bg-accent/10" style={{ width: `${pct}%` }} />
                  </td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">
                    {formatMoney(r.rev)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
