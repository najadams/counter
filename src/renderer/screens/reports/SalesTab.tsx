// SalesTab — date-ranged revenue with day/week/month grouping, plus
// breakdowns by channel, payment method, and cashier. CSV export.

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../../shared/lib/money';
import { DateRangePicker, defaultDateRange, type DateRange } from '../../components/DateRangePicker';
import { buildCsvFilename, exportRowsAsCsv, pesewasToCsvNumber } from '../../lib/csv';
import type { ReportsSalesResponse, ReportGroupBy } from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Button } from '../../components/ui/button';
import { Segmented } from '../../components/ui/segmented';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { ReportSkeleton } from '../../components/ReportSkeleton';

export function SalesTab({ reportAccessToken }: { reportAccessToken: string }) {
  const [range, setRange] = useState<DateRange>(defaultDateRange());
  const [groupBy, setGroupBy] = useState<ReportGroupBy>('day');
  const [data, setData] = useState<ReportsSalesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await counter.reportsSales({
      fromDate: range.fromDate, toDate: range.toDate, groupBy, reportAccessToken,
    });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setData(r.data); setError(null);
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [range.fromDate, range.toDate, groupBy, reportAccessToken]);

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
      <div className="panel p-4 flex flex-col gap-3">
        <DateRangePicker value={range} onChange={setRange} />
        <div className="flex items-center justify-between gap-3">
          <Segmented label="Group by" size="sm" value={groupBy} onChange={setGroupBy}
            options={(['day', 'week', 'month'] as const).map((g) => ({ value: g, label: `Per ${g}` }))} />
          <Button size="sm" onClick={exportBuckets} disabled={!data || data.buckets.length === 0}>
            Export CSV
          </Button>
        </div>
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      {loading && !data && <ReportSkeleton />}

      {data && (
        <>
          <section className="grid grid-cols-2 @xl:grid-cols-4 gap-4">
            <Stat label="Revenue" value={formatMoneyWithCurrency(data.totalRevenuePesewas)} />
            <Stat label="Sales" value={String(data.totalNumSales)} />
            <Stat label="Unique customers" value={String(data.totalUniqueCustomers)} />
            <Stat label="Avg basket"
              value={data.totalAvgBasketPesewas == null ? '—' : formatMoneyWithCurrency(data.totalAvgBasketPesewas)} />
          </section>

          {/* Buckets table */}
          <section className="panel">
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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Sales</TableHead>
                    <TableHead className="text-right">Cust.</TableHead>
                    <TableHead className="text-right">Avg basket</TableHead>
                    <TableHead className="text-right">Walk-in</TableHead>
                    <TableHead className="text-right">Wholesale</TableHead>
                    <TableHead className="text-right">Route</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.buckets.map((b) => {
                    const widthPct = peakBucket > 0 ? (b.revenuePesewas / peakBucket) * 100 : 0;
                    return (
                      <TableRow key={b.bucket}>
                        <TableCell className="px-4 py-2 font-mono relative">
                          <span className="relative z-10">{b.bucket}</span>
                          <span
                            aria-hidden
                            className="absolute inset-y-0 left-0 bg-accent/10 pointer-events-none"
                            style={{ width: `${widthPct}%` }}
                          />
                        </TableCell>
                        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">
                          {formatMoney(b.revenuePesewas)}
                        </TableCell>
                        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{b.numSales}</TableCell>
                        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{b.numUniqueCustomers}</TableCell>
                        <TableCell className="px-4 py-2 text-right font-mono tabular-nums text-text-secondary">
                          {b.avgBasketPesewas == null ? '—' : formatMoney(b.avgBasketPesewas)}
                        </TableCell>
                        <TableCell className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                          {formatMoney(b.walkInPesewas)}
                        </TableCell>
                        <TableCell className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                          {formatMoney(b.wholesalePesewas)}
                        </TableCell>
                        <TableCell className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                          {formatMoney(b.routePesewas)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </section>

          {/* Breakdown grid */}
          <section className="grid grid-cols-2 @xl:grid-cols-3 gap-4">
            <BreakdownTable
              title="By channel" totalRev={data.totalRevenuePesewas}
              rows={data.byChannel.map((c) => ({ label: c.channel, rev: c.revenuePesewas, sub: `${c.numSales} sale${c.numSales === 1 ? '' : 's'}` }))}
            />
            <BreakdownTable
              title="By payment method" totalRev={data.totalRevenuePesewas}
              rows={data.byPaymentMethod.map((m) => ({ label: m.method, rev: m.revenuePesewas, sub: `${m.numSales} sale${m.numSales === 1 ? '' : 's'}` }))}
            />
            <div className="panel flex flex-col">
              <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
                <h3 className="text-text-secondary uppercase tracking-wider text-xs">By cashier</h3>
                <Button variant="link" className="text-text-tertiary hover:text-accent no-underline hover:underline text-xs" onClick={exportCashiers} disabled={data.byCashier.length === 0}>
                  CSV
                </Button>
              </div>
              {data.byCashier.length === 0 ? (
                <div className="px-4 py-4 text-text-tertiary text-sm">No sales by cashier yet.</div>
              ) : (
                <Table>
                  <TableBody>
                    {data.byCashier.map((c) => (
                      <TableRow key={c.workerId}>
                        <TableCell className="px-4 py-2">
                          <div>{c.workerName}</div>
                          <div className="text-text-tertiary text-xs">
                            {c.numSales} sale{c.numSales === 1 ? '' : 's'}
                            {c.voidedCount > 0 && <span className="text-warning"> · {c.voidedCount} voided</span>}
                          </div>
                        </TableCell>
                        <TableCell className="px-4 py-2 text-right font-mono tabular-nums">
                          {formatMoney(c.revenuePesewas)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
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
    <div className="panel p-4">
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
    <div className="panel">
      <div className="px-4 py-3 border-b border-border-subtle">
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-4 text-text-tertiary text-sm">No data.</div>
      ) : (
        <Table>
          <TableBody>
            {rows.map((r) => {
              const pct = totalRev > 0 ? (r.rev / totalRev) * 100 : 0;
              return (
                <TableRow key={r.label}>
                  <TableCell className="px-4 py-2 relative">
                    <span className="relative z-10">
                      <div>{r.label}</div>
                      <div className="text-text-tertiary text-xs">{r.sub} · {pct.toFixed(1)}%</div>
                    </span>
                    <span aria-hidden className="absolute inset-y-0 left-0 bg-accent/10" style={{ width: `${pct}%` }} />
                  </TableCell>
                  <TableCell className="px-4 py-2 text-right font-mono tabular-nums">
                    {formatMoney(r.rev)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
