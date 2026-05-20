// MarginTab — gross-margin breakdown by product and category, plus a
// "below cost" panel highlighting any lines sold at negative margin.

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../../shared/lib/money';
import { DateRangePicker, defaultDateRange, type DateRange } from '../../components/DateRangePicker';
import { bpsToCsvPercent, buildCsvFilename, exportRowsAsCsv, pesewasToCsvNumber } from '../../lib/csv';
import type { ReportsMarginResponse } from '../../../shared/types/ipc';

type ProductSort = 'margin' | 'revenue' | 'marginBps' | 'units';

export function MarginTab() {
  const [range, setRange] = useState<DateRange>(defaultDateRange());
  const [data, setData] = useState<ReportsMarginResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<ProductSort>('margin');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  async function load() {
    setLoading(true);
    const r = await counter.reportsMargin({ fromDate: range.fromDate, toDate: range.toDate });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setData(r.data); setError(null);
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [range.fromDate, range.toDate]);

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
        { header: 'revenue_cedis', get: (r) => pesewasToCsvNumber(r.revenuePesewas) },
        { header: 'cogs_cedis', get: (r) => pesewasToCsvNumber(r.cogsPesewas) },
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
        { header: 'revenue_cedis', get: (r) => pesewasToCsvNumber(r.revenuePesewas) },
        { header: 'cogs_cedis', get: (r) => pesewasToCsvNumber(r.cogsPesewas) },
        { header: 'margin_cedis', get: (r) => pesewasToCsvNumber(r.marginPesewas) },
        { header: 'margin_pct', get: (r) => bpsToCsvPercent(r.marginBps) },
      ],
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-bg-surface border border-border p-4">
        <DateRangePicker value={range} onChange={setRange} />
      </div>

      {error && <div className="bg-danger/10 border border-danger/40 text-danger text-sm px-3 py-2">{error}</div>}
      {loading && !data && <div className="text-text-tertiary text-sm">Loading…</div>}

      {data && (
        <>
          <section className="grid grid-cols-4 gap-4">
            <Stat label="Revenue" value={formatMoneyWithCurrency(data.totalRevenuePesewas)} />
            <Stat label="COGS" value={formatMoneyWithCurrency(data.totalCogsPesewas)} />
            <Stat label="Gross margin" value={formatMoneyWithCurrency(data.totalMarginPesewas)}
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
              <table className="w-full text-sm mt-1">
                <thead className="text-text-tertiary text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left pb-1">When</th>
                    <th className="text-left pb-1">Product</th>
                    <th className="text-right pb-1">Qty</th>
                    <th className="text-right pb-1">Price</th>
                    <th className="text-right pb-1">Cost</th>
                    <th className="text-right pb-1">Loss</th>
                    <th className="text-left pb-1">Cashier</th>
                  </tr>
                </thead>
                <tbody>
                  {data.belowCost.worst.map((l) => (
                    <tr key={l.saleId + l.productId} className="border-t border-danger/30">
                      <td className="py-1.5 text-text-tertiary text-xs">
                        {new Date(l.saleAt).toLocaleString()}
                      </td>
                      <td className="py-1.5">
                        <div>{l.name}</div>
                        <div className="text-text-tertiary text-xs font-mono">{l.sku}</div>
                      </td>
                      <td className="py-1.5 text-right font-mono tabular-nums">{l.quantity}</td>
                      <td className="py-1.5 text-right font-mono tabular-nums">{formatMoney(l.unitPricePesewas)}</td>
                      <td className="py-1.5 text-right font-mono tabular-nums">{formatMoney(l.unitCostPesewas)}</td>
                      <td className="py-1.5 text-right font-mono tabular-nums text-danger">
                        {formatMoney(-l.marginPesewas)}
                      </td>
                      <td className="py-1.5 text-text-secondary text-xs">{l.workerName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="bg-bg-surface border border-border">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-text-secondary uppercase tracking-wider text-xs">By product</h3>
              <div className="flex gap-3 items-center">
                <span className="text-text-tertiary text-xs">click a column to sort</span>
                <button onClick={exportProducts} disabled={sortedProducts.length === 0}
                  className="px-3 py-1 border border-border text-xs hover:bg-bg-elevated disabled:opacity-40">
                  Export CSV
                </button>
              </div>
            </div>
            {sortedProducts.length === 0 ? (
              <div className="px-4 py-6 text-text-tertiary text-sm text-center">
                No sales recorded in this range — no margin to break down.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-bg-deep/60 text-text-tertiary text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-4 py-2">Product</th>
                    <th className="text-left px-4 py-2">Category</th>
                    <SortHeader label="Units" col="units" current={sortBy} dir={sortDir} onSort={setSort} />
                    <SortHeader label="Revenue" col="revenue" current={sortBy} dir={sortDir} onSort={setSort} />
                    <th className="text-right px-4 py-2">COGS</th>
                    <SortHeader label="Margin ₵" col="margin" current={sortBy} dir={sortDir} onSort={setSort} />
                    <SortHeader label="Margin %" col="marginBps" current={sortBy} dir={sortDir} onSort={setSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedProducts.map((p) => (
                    <tr key={p.productId}
                        className={`border-t border-border-subtle ${p.marginPesewas < 0 ? 'bg-danger/5' : ''}`}>
                      <td className="px-4 py-2">
                        <div>{p.name}</div>
                        <div className="text-text-tertiary text-xs font-mono">{p.sku}</div>
                      </td>
                      <td className="px-4 py-2 text-text-tertiary text-xs">{p.category}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{p.unitsSold}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{formatMoney(p.revenuePesewas)}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                        {formatMoney(p.cogsPesewas)}
                      </td>
                      <td className={`px-4 py-2 text-right font-mono tabular-nums ${p.marginPesewas < 0 ? 'text-danger' : ''}`}>
                        {formatMoney(p.marginPesewas)}
                      </td>
                      <td className={`px-4 py-2 text-right font-mono tabular-nums ${p.marginBps < 0 ? 'text-danger' : p.marginBps < 500 ? 'text-warning' : 'text-success'}`}>
                        {(p.marginBps / 100).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="bg-bg-surface border border-border">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-text-secondary uppercase tracking-wider text-xs">By category</h3>
              <button onClick={exportCategories} disabled={data.byCategory.length === 0}
                className="px-3 py-1 border border-border text-xs hover:bg-bg-elevated disabled:opacity-40">
                Export CSV
              </button>
            </div>
            {data.byCategory.length === 0 ? (
              <div className="px-4 py-6 text-text-tertiary text-sm text-center">No category data.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-bg-deep/60 text-text-tertiary text-xs uppercase tracking-wider">
                  <tr>
                    <th className="text-left px-4 py-2">Category</th>
                    <th className="text-right px-4 py-2">Products</th>
                    <th className="text-right px-4 py-2">Units</th>
                    <th className="text-right px-4 py-2">Revenue</th>
                    <th className="text-right px-4 py-2">COGS</th>
                    <th className="text-right px-4 py-2">Margin ₵</th>
                    <th className="text-right px-4 py-2">Margin %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byCategory.map((c) => (
                    <tr key={c.category} className="border-t border-border-subtle">
                      <td className="px-4 py-2">{c.category}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{c.productCount}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{c.unitsSold}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{formatMoney(c.revenuePesewas)}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                        {formatMoney(c.cogsPesewas)}
                      </td>
                      <td className={`px-4 py-2 text-right font-mono tabular-nums ${c.marginPesewas < 0 ? 'text-danger' : ''}`}>
                        {formatMoney(c.marginPesewas)}
                      </td>
                      <td className={`px-4 py-2 text-right font-mono tabular-nums ${c.marginBps < 0 ? 'text-danger' : c.marginBps < 500 ? 'text-warning' : 'text-success'}`}>
                        {(c.marginBps / 100).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
    <div className="bg-bg-surface border border-border p-4">
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
    <th className="text-right px-4 py-2">
      <button onClick={() => onSort(col)}
        className={`uppercase tracking-wider text-xs ${active ? 'text-accent' : 'hover:text-text-primary'}`}>
        {label} {active ? (dir === 'desc' ? '▼' : '▲') : ''}
      </button>
    </th>
  );
}
