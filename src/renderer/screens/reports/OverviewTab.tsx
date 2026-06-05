// OverviewTab — the Pass 1 dashboard content, now mounted inside the
// tabbed ReportsScreen. Pure render of the single reportsOverview bundle.

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../../shared/lib/money';
import type { ReportsOverviewResponse } from '../../../shared/types/ipc';

interface Props {
  onOpenCustomers?: () => void;
  onOpenSummary?: () => void;
  onOpenStocktake?: () => void;
  onOpenSupplierPayments?: () => void;
  onOpenReorder?: () => void;
  /** Receive a (refresh, loading) handle so the parent header can drive it. */
  registerRefresh?: (refresh: () => Promise<void>, loading: boolean) => void;
}

export function OverviewTab({
  onOpenCustomers, onOpenSummary, onOpenStocktake,
  onOpenSupplierPayments, onOpenReorder, registerRefresh,
}: Props) {
  const [data, setData] = useState<ReportsOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    const r = await counter.reportsOverview({});
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setData(r.data);
    setError(null);
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, []);
  useEffect(() => { registerRefresh?.(refresh, loading); /* eslint-disable-next-line */ }, [loading]);

  if (error) return (
    <div className="bg-danger/10 border border-danger/40 text-danger text-sm px-3 py-2 rounded">{error}</div>
  );
  if (!data) return <div className="text-text-tertiary text-sm">Loading dashboard…</div>;

  return (
    <div className="flex flex-col gap-6">
      <div className="text-text-tertiary text-xs">
        As of {new Date(data.generatedAt).toLocaleString()} · location {data.locationId}
      </div>

      {/* --- KPI cards (3×2) --- */}
      <section className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <KpiCard
          label="Revenue · today"
          value={formatMoneyWithCurrency(data.revenue.todayPesewas)}
          sub={`${data.revenue.numSalesToday} sale${data.revenue.numSalesToday === 1 ? '' : 's'}`}
          trend={data.revenue.todayChangePct}
          trendLabel="vs yesterday"
          onClick={onOpenSummary}
        />
        <KpiCard
          label="Revenue · this week"
          value={formatMoneyWithCurrency(data.revenue.thisWeekPesewas)}
          sub={`${data.revenue.numSalesThisWeek} sales`}
          trend={data.revenue.thisWeekChangePct}
          trendLabel="vs last week"
          onClick={onOpenSummary}
        />
        <KpiCard
          label="Revenue · this month"
          value={formatMoneyWithCurrency(data.revenue.thisMonthPesewas)}
          sub={`${data.revenue.numSalesThisMonth} sales`}
          trend={data.revenue.thisMonthChangePct}
          trendLabel="vs last month"
          onClick={onOpenSummary}
        />

        <KpiCard
          label="Gross margin · this month"
          value={formatMoneyWithCurrency(data.margin.grossMarginPesewas)}
          sub={data.margin.revenuePesewas > 0
            ? `${(data.margin.grossMarginBps / 100).toFixed(1)}% · COGS ${formatMoneyWithCurrency(data.margin.cogsPesewas)}`
            : 'No sales yet this month'}
        />
        <KpiCard
          label="Cash in tills"
          value={formatMoneyWithCurrency(data.cashPosition.openTillExpectedPesewas)}
          sub={data.cashPosition.openShifts === 0
            ? 'No open shifts'
            : `${data.cashPosition.openShifts} open shift${data.cashPosition.openShifts === 1 ? '' : 's'}`}
          footer={data.cashPosition.lastClosedAt && data.cashPosition.lastClosedVariancePesewas != null
            ? <span className={varianceClass(data.cashPosition.lastClosedVariancePesewas)}>
                Last close: {signedMoney(data.cashPosition.lastClosedVariancePesewas)} variance
              </span>
            : null}
        />
        <KpiCard
          label="Inventory · at cost"
          value={formatMoneyWithCurrency(data.inventory.totalAtCostPesewas)}
          sub={`${data.inventory.activeSkuCount} active SKUs · at retail ${formatMoneyWithCurrency(data.inventory.totalAtRetailPesewas)}`}
          footer={
            <div className="flex gap-3 text-xs">
              {data.inventory.belowReorderCount > 0 && (
                <button onClick={onOpenReorder}
                  className="text-warning hover:underline">
                  {data.inventory.belowReorderCount} below reorder →
                </button>
              )}
              {data.inventory.stockoutCount > 0 && (
                <span className="text-danger">
                  {data.inventory.stockoutCount} out of stock
                </span>
              )}
            </div>
          }
          onClick={onOpenReorder}
        />
      </section>

      <section className="grid grid-cols-2 gap-4">
        <ReceivablesCard data={data} onClick={onOpenCustomers} />
        <PayablesCard data={data} onClick={onOpenSupplierPayments} />
      </section>

      <section className="bg-bg-surface border border-border p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-text-secondary uppercase tracking-wider text-xs">Revenue · last 30 days</h3>
          <div className="text-text-tertiary text-xs">
            Peak {formatMoneyWithCurrency(Math.max(0, ...data.revenueSparkline.map((d) => d.pesewas)))}
          </div>
        </div>
        <Sparkline data={data.revenueSparkline} />
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div className="bg-bg-surface border border-border p-5 flex flex-col gap-3">
          <h3 className="text-text-secondary uppercase tracking-wider text-xs">Top sellers · this week</h3>
          {data.topSellersThisWeek.length === 0 ? (
            <div className="text-text-tertiary text-sm py-4">No sales recorded this week.</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-tertiary text-xs uppercase tracking-wider">
                  <th className="text-left pb-2">Product</th>
                  <th className="text-right pb-2">Units</th>
                  <th className="text-right pb-2">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {data.topSellersThisWeek.map((p) => (
                  <tr key={p.productId} className="border-t border-border-subtle">
                    <td className="py-2">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-text-tertiary text-xs font-mono">{p.sku}</div>
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">{p.unitsSold}</td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {formatMoneyWithCurrency(p.revenuePesewas)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-bg-surface border border-border p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-text-secondary uppercase tracking-wider text-xs">Slow movers · capital tied up</h3>
            <span className="text-text-tertiary text-xs">no sale in 14 days</span>
          </div>
          {data.slowMovers.length === 0 ? (
            <div className="text-text-tertiary text-sm py-4">
              Nothing sitting idle — every active SKU sold in the last 14 days.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-tertiary text-xs uppercase tracking-wider">
                  <th className="text-left pb-2">Product</th>
                  <th className="text-right pb-2">On hand</th>
                  <th className="text-right pb-2">Tied-up ₵</th>
                </tr>
              </thead>
              <tbody>
                {data.slowMovers.map((p) => (
                  <tr key={p.productId} className="border-t border-border-subtle">
                    <td className="py-2">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-text-tertiary text-xs">
                        {p.daysSinceLastSale == null
                          ? 'never sold'
                          : `last sold ${p.daysSinceLastSale} day${p.daysSinceLastSale === 1 ? '' : 's'} ago`}
                      </div>
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">{p.unitsOnHand}</td>
                    <td className="py-2 text-right font-mono tabular-nums text-warning">
                      {formatMoneyWithCurrency(p.stockValueAtCostPesewas)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <section className="bg-bg-surface border border-border p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-text-secondary uppercase tracking-wider text-xs">Recent stocktake variance</h3>
          {onOpenStocktake && (
            <button onClick={onOpenStocktake} className="text-accent text-xs hover:underline">
              Open stocktake →
            </button>
          )}
        </div>
        {data.recentVarianceEvents.length === 0 ? (
          <div className="text-text-tertiary text-sm py-4">No completed stocktake with variance yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-tertiary text-xs uppercase tracking-wider">
                <th className="text-left pb-2">When</th>
                <th className="text-right pb-2">Loss</th>
                <th className="text-right pb-2">Found</th>
                <th className="text-right pb-2">Net</th>
                <th className="text-right pb-2">SKUs off</th>
                <th className="text-right pb-2">Shrinkage</th>
              </tr>
            </thead>
            <tbody>
              {data.recentVarianceEvents.map((e) => {
                const net = e.lossValuePesewas - e.foundValuePesewas;
                return (
                  <tr key={e.stocktakeId} className="border-t border-border-subtle">
                    <td className="py-2">{new Date(e.completedAt).toLocaleDateString()}</td>
                    <td className="py-2 text-right font-mono tabular-nums text-danger">
                      {formatMoneyWithCurrency(e.lossValuePesewas)}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums text-success">
                      {formatMoneyWithCurrency(e.foundValuePesewas)}
                    </td>
                    <td className={`py-2 text-right font-mono tabular-nums ${net > 0 ? 'text-danger' : net < 0 ? 'text-success' : ''}`}>
                      {net === 0 ? '0.00' : signedMoney(net)}
                    </td>
                    <td className="py-2 text-right font-mono tabular-nums">{e.productsWithVariance}</td>
                    <td className="py-2 text-right font-mono tabular-nums">
                      {e.shrinkageRate == null ? '—' : `${(e.shrinkageRate * 100).toFixed(2)}%`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function KpiCard({
  label, value, sub, trend, trendLabel, footer, onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  trend?: number | null;
  trendLabel?: string;
  footer?: React.ReactNode;
  onClick?: () => void;
}): JSX.Element {
  const clickable = !!onClick;
  const Tag = clickable ? 'button' : 'div';
  return (
    <Tag
      onClick={onClick}
      className={[
        'bg-bg-surface border border-border p-5 flex flex-col gap-1 text-left',
        clickable ? 'hover:bg-bg-elevated cursor-pointer transition-colors' : '',
      ].join(' ')}
    >
      <div className="text-text-tertiary uppercase tracking-wider text-xs">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="flex items-baseline justify-between">
        {sub && <div className="text-text-tertiary text-xs">{sub}</div>}
        {trend != null && trendLabel && (
          <div className={`text-xs ${trendClass(trend)}`}>
            {trend >= 0 ? '▲' : '▼'} {Math.abs(trend).toFixed(1)}% <span className="text-text-tertiary">{trendLabel}</span>
          </div>
        )}
      </div>
      {footer && <div className="mt-1">{footer}</div>}
    </Tag>
  );
}

function ReceivablesCard({ data, onClick }: { data: ReportsOverviewResponse; onClick?: () => void }) {
  const r = data.receivables;
  const ageWarn = r.bucket61_90Pesewas + r.bucket90PlusPesewas;
  return (
    <button
      onClick={onClick}
      className="bg-bg-surface border border-border p-5 flex flex-col gap-3 text-left hover:bg-bg-elevated cursor-pointer transition-colors"
    >
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-text-tertiary uppercase tracking-wider text-xs">Customers owe us</div>
          <div className="text-2xl font-bold tabular-nums mt-1">
            {formatMoneyWithCurrency(r.totalPesewas)}
          </div>
        </div>
        <div className="text-text-tertiary text-xs text-right">
          {r.customerCount} customer{r.customerCount === 1 ? '' : 's'}
          {r.overLimitCount > 0 && (
            <div className="text-warning">{r.overLimitCount} over limit</div>
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <AgingPill label="0–30" amount={r.bucket0_30Pesewas} tone="" />
        <AgingPill label="31–60" amount={r.bucket31_60Pesewas} tone="text-text-secondary" />
        <AgingPill label="61–90" amount={r.bucket61_90Pesewas} tone="text-warning" />
        <AgingPill label="90+" amount={r.bucket90PlusPesewas} tone="text-danger" />
      </div>
      {ageWarn > 0 && (
        <div className="text-warning text-xs">
          ⚠ {formatMoneyWithCurrency(ageWarn)} aged 60+ days — chase these first
        </div>
      )}
    </button>
  );
}

function PayablesCard({ data, onClick }: { data: ReportsOverviewResponse; onClick?: () => void }) {
  const p = data.payables;
  return (
    <button
      onClick={onClick}
      className="bg-bg-surface border border-border p-5 flex flex-col gap-2 text-left hover:bg-bg-elevated cursor-pointer transition-colors"
    >
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-text-tertiary uppercase tracking-wider text-xs">We owe suppliers</div>
          <div className="text-2xl font-bold tabular-nums mt-1">
            {formatMoneyWithCurrency(p.totalOwedPesewas)}
          </div>
        </div>
        <div className="text-text-tertiary text-xs text-right">
          {p.supplierCount} supplier{p.supplierCount === 1 ? '' : 's'} with a balance
        </div>
      </div>
      <div className="text-text-tertiary text-xs">Click to open supplier payments →</div>
    </button>
  );
}

function AgingPill({ label, amount, tone }: { label: string; amount: number; tone: string }) {
  return (
    <div className="bg-bg-deep border border-border-subtle px-2 py-1.5">
      <div className="text-text-tertiary uppercase">{label}</div>
      <div className={`font-mono tabular-nums ${tone}`}>{formatMoney(amount)}</div>
    </div>
  );
}

function Sparkline({ data }: { data: Array<{ date: string; pesewas: number }> }) {
  const max = Math.max(1, ...data.map((d) => d.pesewas));
  return (
    <div className="flex items-end gap-1 h-32">
      {data.map((d) => {
        const h = Math.round((d.pesewas / max) * 100);
        return (
          <div key={d.date} className="flex-1 flex flex-col items-center justify-end gap-1 group relative">
            <div
              className={`w-full ${d.pesewas > 0 ? 'bg-accent' : 'bg-border'} hover:bg-accent-light transition-colors`}
              style={{ height: `${Math.max(2, h)}%` }}
            />
            <div className="absolute bottom-full mb-1 hidden group-hover:block bg-bg-elevated border border-border px-2 py-1 text-xs whitespace-nowrap z-10">
              <div className="font-mono">{d.date}</div>
              <div className="font-mono tabular-nums">{formatMoneyWithCurrency(d.pesewas)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function trendClass(pct: number): string {
  if (pct > 0) return 'text-success';
  if (pct < 0) return 'text-danger';
  return 'text-text-tertiary';
}
function varianceClass(p: number): string {
  if (p === 0) return 'text-text-tertiary';
  return Math.abs(p) > 100 ? 'text-danger' : 'text-warning';
}
function signedMoney(p: number): string {
  const sign = p > 0 ? '+' : p < 0 ? '−' : '';
  return `${sign}${formatMoneyWithCurrency(Math.abs(p))}`;
}
