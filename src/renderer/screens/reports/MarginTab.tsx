// MarginTab — net gross-margin breakdown by product and category, plus a
// "below cost" panel highlighting any lines sold at negative margin.

import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../../shared/lib/money';
import { DateRangePicker, defaultDateRange, type DateRange } from '../../components/DateRangePicker';
import { bpsToCsvPercent, buildCsvFilename, exportRowsAsCsv, pesewasToCsvNumber } from '../../lib/csv';
import type { ReportsMarginResponse } from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Button } from '../../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { ReportSkeleton } from '../../components/ReportSkeleton';

type ProductSort = 'margin' | 'revenue' | 'marginBps' | 'units';

export function MarginTab({ reportAccessToken }: { reportAccessToken: string }) {
  const [range, setRange] = useState<DateRange>(defaultDateRange());
  const [data, setData] = useState<ReportsMarginResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<ProductSort>('margin');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  async function load() {
    setLoading(true);
    const r = await counter.reportsMargin({ fromDate: range.fromDate, toDate: range.toDate, reportAccessToken });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setData(r.data); setError(null);
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [range.fromDate, range.toDate, reportAccessToken]);

  const sortedProducts = useMemo(() => {
    if (!data) return [];
    const arr = [...data.byProduct];
    const dir = sortDir === 'desc' ? -1 : 1;
    arr.sort((a, b) => {
      let av: number; let bv: number;
      switch (sortBy) {
        case 'revenue':   av = a.revenuePesewas; bv = b.revenuePesewas; break;
        case 'marginBps': av = a.marginBps;      bv = b.marginBps;      break;
        case 'units':     av = a.unitsSold;      bv = b.unitsSold;      break;
        default:          av = a.marginPesewas;  bv = b.marginPesewas;
      }
      return (av - bv) * dir;
    });
    return arr;
  }, [data, sortBy, sortDir]);

  function setSort(col: ProductSort) {
    if (sortBy === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  }

  function exportProducts() {
    if (!data) return;
    exportRowsAsCsv(
      buildCsvFilename('margin_by_product', [range.fromDate, range.toDate]),
      sortedProducts,
      [
        { header: 'sku', get: (r) => r.sku },
        { header: 'name', get: (r) => r.name },
        { header: 'category', get: (r) => r.category },
        { header: 'brand', get: (r) => r.brand ?? '' },
        { header: 'units_sold', get: (r) => r.unitsSold },
        { header: 'net_revenue_cedis', get: (r) => pesewasToCsvNumber(r.revenuePesewas) },
        { header: 'net_cogs_cedis', get: (r) => pesewasToCsvNumber(r.cogsPesewas) },
        { header: 'margin_cedis', get: (r) => pesewasToCsvNumber(r.marginPesewas) },
        { header: 'margin_pct', get: (r) => bpsToCsvPercent(r.marginBps) },
      ],
    );
  }
  function exportCategories() {
    if (!data) return;
    exportRowsAsCsv(
      buildCsvFilename('margin_by_category', [range.fromDate, range.toDate]),
      data.byCategory,
      [
        { header: 'category', get: (r) => r.category },
        { header: 'product_count', get: (r) => r.productCount },
        { header: 'units_sold', get: (r) => r.unitsSold },
        { header: 'net_revenue_cedis', get: (r) => pesewasToCsvNumber(r.revenuePesewas) },
        { header: 'net_cogs_cedis', get: (r) => pesewasToCsvNumber(r.cogsPesewas) },
        { header: 'margin_cedis', get: (r) => pesewasToCsvNumber(r.marginPesewas) },
        { header: 'margin_pct', get: (r) => bpsToCsvPercent(r.marginBps) },
      ],
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="panel p-4">
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      {loading && !data && <ReportSkeleton />}

      {data && (
        <>
          <section className="grid grid-cols-2 @xl:grid-cols-4 gap-4">
            <Stat label="Net revenue" value={formatMoneyWithCurrency(data.totalRevenuePesewas)} />
            <Stat label="Net COGS" value={formatMoneyWithCurrency(data.totalCogsPesewas)} />
            <Stat label="Net margin" value={formatMoneyWithCurrency(data.totalMarginPesewas)}
              accent={data.totalMarginPesewas < 0 ? 'danger' : 'ok'} />
            <Stat label="Margin %" value={`${(data.totalMarginBps / 100).toFixed(2)}%`}
              accent={data.totalMarginBps < 0 ? 'danger' : 'ok'} />
          </section>

          {data.belowCost.numLines > 0 && (
            <section className="bg-danger/10 border border-danger/40 p-4 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-danger uppercase tracking-wider text-xs font-semibold">
                  Sold below cost · {data.belowCost.numLines} line{data.belowCost.numLines === 1 ? '' : 's'}
                </h3>
                <span className="text-danger text-sm font-semibold">
                  Margin lost: {formatMoneyWithCurrency(data.belowCost.totalLossPesewas)}
                </span>
              </div>
              <div className="text-text-secondary text-xs">
                These are lines where unit price was less than unit cost. Either prices were
                set too low, a discount went too deep, or COGS jumped without the sell price
                being updated. Worst 10:
              </div>
              <Table className="mt-1">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pb-1">When</TableHead>
                    <TableHead className="pb-1">Product</TableHead>
                    <TableHead className="text-right pb-1">Qty</TableHead>
                    <TableHead className="text-right pb-1">Price</TableHead>
                    <TableHead className="text-right pb-1">Cost</TableHead>
                    <TableHead className="text-right pb-1">Loss</TableHead>
                    <TableHead className="pb-1">Cashier</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.belowCost.worst.map((l) => (
                    <TableRow key={l.saleId + l.productId} className="border-danger/30">
                      <TableCell className="py-1.5 text-text-tertiary text-xs">
                        {new Date(l.saleAt).toLocaleString()}
                      </TableCell>
                      <TableCell className="py-1.5">
                        <div>{l.name}</div>
                        <div className="text-text-tertiary text-xs font-mono">{l.sku}</div>
                      </TableCell>
                      <TableCell className="py-1.5 text-right font-mono tabular-nums">{l.quantity}</TableCell>
                      <TableCell className="py-1.5 text-right font-mono tabular-nums">{formatMoney(l.unitPricePesewas)}</TableCell>
                      <TableCell className="py-1.5 text-right font-mono tabular-nums">{formatMoney(l.unitCostPesewas)}</TableCell>
                      <TableCell className="py-1.5 text-right font-mono tabular-nums text-danger">
                        {formatMoney(-l.marginPesewas)}
                      </TableCell>
                      <TableCell className="py-1.5 text-text-secondary text-xs">{l.workerName}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </section>
          )}

          <section className="panel">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-text-secondary uppercase tracking-wider text-xs">By product</h3>
              <div className="flex gap-3 items-center">
                <span className="text-text-tertiary text-xs">click a column to sort</span>
                <Button size="sm" onClick={exportProducts} disabled={sortedProducts.length === 0}>
                  Export CSV
                </Button>
              </div>
            </div>
            {sortedProducts.length === 0 ? (
              <div className="px-4 py-6 text-text-tertiary text-sm text-center">
                No sales recorded in this range — no margin to break down.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Category</TableHead>
                    <SortHeader label="Units" col="units" current={sortBy} dir={sortDir} onSort={setSort} />
                    <SortHeader label="Net revenue" col="revenue" current={sortBy} dir={sortDir} onSort={setSort} />
                    <TableHead className="text-right">Net COGS</TableHead>
                    <SortHeader label="Margin ₵" col="margin" current={sortBy} dir={sortDir} onSort={setSort} />
                    <SortHeader label="Margin %" col="marginBps" current={sortBy} dir={sortDir} onSort={setSort} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedProducts.map((p) => (
                    <TableRow key={p.productId}
                        className={`border-t border-border-subtle ${p.marginPesewas < 0 ? 'bg-danger/5' : ''}`}>
                      <TableCell className="px-4 py-2">
                        <div>{p.name}</div>
                        <div className="text-text-tertiary text-xs font-mono">{p.sku}</div>
                      </TableCell>
                      <TableCell className="px-4 py-2 text-text-tertiary text-xs">{p.category}</TableCell>
                      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{p.unitsSold}</TableCell>
                      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{formatMoney(p.revenuePesewas)}</TableCell>
                      <TableCell className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                        {formatMoney(p.cogsPesewas)}
                      </TableCell>
                      <TableCell className={`px-4 py-2 text-right font-mono tabular-nums ${p.marginPesewas < 0 ? 'text-danger' : ''}`}>
                        {formatMoney(p.marginPesewas)}
                      </TableCell>
                      <TableCell className={`px-4 py-2 text-right font-mono tabular-nums ${p.marginBps < 0 ? 'text-danger' : p.marginBps < 500 ? 'text-warning' : 'text-success'}`}>
                        {(p.marginBps / 100).toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section className="panel">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-text-secondary uppercase tracking-wider text-xs">By category</h3>
              <Button size="sm" onClick={exportCategories} disabled={data.byCategory.length === 0}>
                Export CSV
              </Button>
            </div>
            {data.byCategory.length === 0 ? (
              <div className="px-4 py-6 text-text-tertiary text-sm text-center">No category data.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Products</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead className="text-right">Net revenue</TableHead>
                    <TableHead className="text-right">Net COGS</TableHead>
                    <TableHead className="text-right">Margin ₵</TableHead>
                    <TableHead className="text-right">Margin %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byCategory.map((c) => (
                    <TableRow key={c.category}>
                      <TableCell className="px-4 py-2">{c.category}</TableCell>
                      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{c.productCount}</TableCell>
                      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{c.unitsSold}</TableCell>
                      <TableCell className="px-4 py-2 text-right font-mono tabular-nums">{formatMoney(c.revenuePesewas)}</TableCell>
                      <TableCell className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                        {formatMoney(c.cogsPesewas)}
                      </TableCell>
                      <TableCell className={`px-4 py-2 text-right font-mono tabular-nums ${c.marginPesewas < 0 ? 'text-danger' : ''}`}>
                        {formatMoney(c.marginPesewas)}
                      </TableCell>
                      <TableCell className={`px-4 py-2 text-right font-mono tabular-nums ${c.marginBps < 0 ? 'text-danger' : c.marginBps < 500 ? 'text-warning' : 'text-success'}`}>
                        {(c.marginBps / 100).toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'ok' | 'danger' }) {
  const tone = accent === 'danger' ? 'text-danger' : '';
  return (
    <div className="panel p-4">
      <div className="text-text-tertiary uppercase tracking-wider text-xs">{label}</div>
      <div className={`text-xl font-bold tabular-nums mt-1 ${tone}`}>{value}</div>
    </div>
  );
}

function SortHeader<T extends string>({
  label, col, current, dir, onSort,
}: {
  label: string;
  col: T;
  current: T;
  dir: 'asc' | 'desc';
  onSort: (c: T) => void;
}) {
  const active = current === col;
  return (
    <TableHead className="text-right">
      <button onClick={() => onSort(col)}
        className={`uppercase tracking-wider text-xs ${active ? 'text-accent' : 'hover:text-text-primary'}`}>
        <span className="inline-flex items-center gap-1">{label}{active && (dir === 'desc' ? <ChevronDownIcon aria-label="descending" className="size-3.5" /> : <ChevronUpIcon aria-label="ascending" className="size-3.5" />)}</span>
      </button>
    </TableHead>
  );
}
