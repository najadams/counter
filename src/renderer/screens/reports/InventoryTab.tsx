// InventoryTab — point-in-time stock valuation. Every active SKU with units
// on hand, value at cost, value at retail, days-of-supply, last received /
// last sold. Filter buttons for "below reorder" and "stockouts".
//
// Days-of-supply uses a velocity window (default 30 days). Bump it to 60/90
// to see slower-moving products' true coverage.

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../../shared/lib/money';
import { buildCsvFilename, exportRowsAsCsv, pesewasToCsvNumber } from '../../lib/csv';
import type { ReportsInventoryResponse } from '../../../shared/types/ipc';

type Filter = 'all' | 'belowReorder' | 'stockout' | 'inStock';
type Sort =
  | 'name' | 'category'
  | 'onHand' | 'atCost' | 'atRetail'
  | 'dos' | 'lastSold';

export function InventoryTab() {
  const [velocityWindow, setVelocityWindow] = useState(30);
  const [data, setData] = useState<ReportsInventoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('atCost');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');

  async function load() {
    setLoading(true);
    const r = await counter.reportsInventory({ velocityWindowDays: velocityWindow });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setData(r.data); setError(null);
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [velocityWindow]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (filter === 'belowReorder' && !r.belowReorder) return false;
      if (filter === 'stockout' && !r.stockout) return false;
      if (filter === 'inStock' && r.stockout) return false;
      if (q && !r.name.toLowerCase().includes(q) && !r.sku.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, filter, search]);

  const sorted = useMemo(() => {
    const arr = [...filtered];
    const mult = dir === 'desc' ? -1 : 1;
    arr.sort((a, b) => {
      let av: number | string; let bv: number | string;
      switch (sort) {
        case 'name':     av = a.name; bv = b.name; break;
        case 'category': av = a.category; bv = b.category; break;
        case 'onHand':   av = a.unitsOnHand; bv = b.unitsOnHand; break;
        case 'atCost':   av = a.totalAtCostPesewas; bv = b.totalAtCostPesewas; break;
        case 'atRetail': av = a.totalAtRetailPesewas; bv = b.totalAtRetailPesewas; break;
        case 'dos':      av = a.daysOfSupply ?? Number.POSITIVE_INFINITY; bv = b.daysOfSupply ?? Number.POSITIVE_INFINITY; break;
        case 'lastSold': av = a.lastSoldAt ?? '0'; bv = b.lastSoldAt ?? '0'; break;
      }
      if (typeof av === 'string') return (av < (bv as string) ? -1 : av > (bv as string) ? 1 : 0) * mult;
      return ((av as number) - (bv as number)) * mult;
    });
    return arr;
  }, [filtered, sort, dir]);

  function clickSort(col: Sort) {
    if (sort === col) setDir(dir === 'asc' ? 'desc' : 'asc');
    else { setSort(col); setDir(col === 'name' || col === 'category' ? 'asc' : 'desc'); }
  }

  function exportCsv() {
    if (!data) return;
    exportRowsAsCsv(
      buildCsvFilename('inventory', [new Date().toISOString().slice(0, 10)]),
      sorted,
      [
        { header: 'sku', get: (r) => r.sku },
        { header: 'name', get: (r) => r.name },
        { header: 'category', get: (r) => r.category },
        { header: 'brand', get: (r) => r.brand ?? '' },
        { header: 'units_on_hand', get: (r) => r.unitsOnHand },
        { header: 'cost_per_unit_cedis', get: (r) => pesewasToCsvNumber(r.costPerUnitPesewas) },
        { header: 'retail_per_unit_cedis', get: (r) => pesewasToCsvNumber(r.retailPerUnitPesewas) },
        { header: 'total_at_cost_cedis', get: (r) => pesewasToCsvNumber(r.totalAtCostPesewas) },
        { header: 'total_at_retail_cedis', get: (r) => pesewasToCsvNumber(r.totalAtRetailPesewas) },
        { header: 'reorder_threshold', get: (r) => r.reorderThreshold },
        { header: 'below_reorder', get: (r) => r.belowReorder ? 'yes' : 'no' },
        { header: 'stockout', get: (r) => r.stockout ? 'yes' : 'no' },
        { header: 'units_sold_in_window', get: (r) => r.unitsSoldInWindow },
        { header: 'days_of_supply', get: (r) => r.daysOfSupply ?? '' },
        { header: 'last_received', get: (r) => r.lastReceivedAt ?? '' },
        { header: 'last_sold', get: (r) => r.lastSoldAt ?? '' },
      ],
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-bg-surface border border-border p-4 flex flex-col gap-3">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div className="flex gap-2 items-end">
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wider text-text-tertiary">Velocity window</span>
              <select value={velocityWindow} onChange={(e) => setVelocityWindow(Number(e.target.value))}
                className="bg-bg-input border border-border-strong px-3 py-1.5 text-sm">
                {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>last {d} days</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs uppercase tracking-wider text-text-tertiary">Search</span>
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="name or SKU"
                className="bg-bg-input border border-border-strong px-3 py-1.5 text-sm min-w-[14rem]" />
            </label>
          </div>
          <button onClick={exportCsv} disabled={!data || sorted.length === 0}
            className="px-3 py-1.5 border border-border text-xs hover:bg-bg-elevated disabled:opacity-40">
            Export CSV
          </button>
        </div>
        <div className="text-text-tertiary text-xs">
          Days-of-supply = on-hand ÷ (units sold in window ÷ {velocityWindow}). NULL when there are no sales in window.
        </div>
      </div>

      {error && <div className="bg-red-950/30 border border-red-900/50 text-red-300 text-sm px-3 py-2">{error}</div>}
      {loading && !data && <div className="text-text-tertiary text-sm">Loading…</div>}

      {data && (
        <>
          <section className="grid grid-cols-5 gap-3">
            <Stat label="Total at cost" value={formatMoneyWithCurrency(data.totalAtCostPesewas)}
              onClick={() => setFilter('all')} active={filter === 'all'} />
            <Stat label="Total at retail" value={formatMoneyWithCurrency(data.totalAtRetailPesewas)} />
            <Stat label="Active SKUs" value={String(data.activeSkuCount)}
              onClick={() => setFilter('inStock')} active={filter === 'inStock'} />
            <Stat label="Below reorder" value={String(data.belowReorderCount)} tone="warning"
              onClick={() => setFilter('belowReorder')} active={filter === 'belowReorder'} />
            <Stat label="Out of stock" value={String(data.stockoutCount)} tone="danger"
              onClick={() => setFilter('stockout')} active={filter === 'stockout'} />
          </section>

          <section className="bg-bg-surface border border-border">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <h3 className="text-text-secondary uppercase tracking-wider text-xs">
                Stock valuation · {sorted.length} of {data.activeSkuCount} SKUs
                {filter !== 'all' && <span className="ml-2 text-text-tertiary">filter: {filter}</span>}
              </h3>
              <div className="text-text-tertiary text-xs">click a column to sort</div>
            </div>
            {sorted.length === 0 ? (
              <div className="px-4 py-6 text-text-tertiary text-sm text-center">
                Nothing matches the current filter.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-bg-deep/60 text-text-tertiary text-xs uppercase tracking-wider">
                  <tr>
                    <SortHeader label="Product" col="name" current={sort} dir={dir} onSort={clickSort} align="left" />
                    <SortHeader label="Category" col="category" current={sort} dir={dir} onSort={clickSort} align="left" />
                    <SortHeader label="On hand" col="onHand" current={sort} dir={dir} onSort={clickSort} />
                    <SortHeader label="At cost" col="atCost" current={sort} dir={dir} onSort={clickSort} />
                    <SortHeader label="At retail" col="atRetail" current={sort} dir={dir} onSort={clickSort} />
                    <SortHeader label="DoS" col="dos" current={sort} dir={dir} onSort={clickSort} />
                    <SortHeader label="Last sold" col="lastSold" current={sort} dir={dir} onSort={clickSort} align="left" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r) => (
                    <tr key={r.productId}
                        className={`border-t border-border-subtle ${r.stockout ? 'bg-danger/5' : r.belowReorder ? 'bg-warning/5' : ''}`}>
                      <td className="px-4 py-2">
                        <div>{r.name}</div>
                        <div className="text-text-tertiary text-xs font-mono">{r.sku}</div>
                      </td>
                      <td className="px-4 py-2 text-text-tertiary text-xs">{r.category}</td>
                      <td className={`px-4 py-2 text-right font-mono tabular-nums ${r.stockout ? 'text-danger' : r.belowReorder ? 'text-warning' : ''}`}>
                        {r.unitsOnHand}
                        {r.reorderThreshold > 0 && (
                          <span className="text-text-tertiary text-xs"> / {r.reorderThreshold}</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">
                        {formatMoney(r.totalAtCostPesewas)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums text-text-tertiary">
                        {formatMoney(r.totalAtRetailPesewas)}
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">
                        {r.daysOfSupply == null
                          ? <span className="text-text-tertiary">—</span>
                          : r.daysOfSupply < 7
                            ? <span className="text-danger">{r.daysOfSupply}d</span>
                            : r.daysOfSupply > 120
                              ? <span className="text-warning">{r.daysOfSupply}d</span>
                              : <span>{r.daysOfSupply}d</span>}
                      </td>
                      <td className="px-4 py-2 text-text-tertiary text-xs">
                        {r.lastSoldAt
                          ? new Date(r.lastSoldAt).toLocaleDateString()
                          : 'never'}
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

function Stat({ label, value, tone, onClick, active }: {
  label: string;
  value: string;
  tone?: 'warning' | 'danger';
  onClick?: () => void;
  active?: boolean;
}) {
  const toneCls = tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : '';
  const clickable = !!onClick;
  const Tag = clickable ? 'button' : 'div';
  return (
    <Tag onClick={onClick}
      className={[
        'bg-bg-surface border p-4 text-left',
        active ? 'border-accent' : 'border-border',
        clickable ? 'hover:bg-bg-elevated cursor-pointer transition-colors' : '',
      ].join(' ')}>
      <div className="text-text-tertiary uppercase tracking-wider text-xs">{label}</div>
      <div className={`text-xl font-bold tabular-nums mt-1 ${toneCls}`}>{value}</div>
    </Tag>
  );
}

function SortHeader<T extends string>({
  label, col, current, dir, onSort, align = 'right',
}: {
  label: string;
  col: T;
  current: T;
  dir: 'asc' | 'desc';
  onSort: (c: T) => void;
  align?: 'left' | 'right';
}) {
  const active = current === col;
  return (
    <th className={`${align === 'left' ? 'text-left' : 'text-right'} px-4 py-2`}>
      <button onClick={() => onSort(col)}
        className={`uppercase tracking-wider text-xs ${active ? 'text-accent' : 'hover:text-text-primary'}`}>
        {label} {active ? (dir === 'desc' ? '▼' : '▲') : ''}
      </button>
    </th>
  );
}
