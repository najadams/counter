// OverviewTab — the Pass 1 dashboard content, now mounted inside the
// tabbed ReportsScreen. Pure render of the single reportsOverview bundle.

import { ArrowRightIcon, TrendingDownIcon, TrendingUpIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../../shared/lib/money';
import type { ReportsOverviewResponse } from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Button } from '../../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { ReportSkeleton } from '../../components/ReportSkeleton';

interface Props {
  reportAccessToken: string;
  onOpenCustomers?: () => void;
  onOpenSummary?: () => void;
  onOpenStocktake?: () => void;
  onOpenSupplierPayments?: () => void;
  onOpenReorder?: () => void;
  /** Receive a (refresh, loading) handle so the parent header can drive it. */
  registerRefresh?: (refresh: () => Promise<void>, loading: boolean) => void;
}

export function OverviewTab({
  reportAccessToken,
  onOpenCustomers, onOpenSummary, onOpenStocktake,
  onOpenSupplierPayments, onOpenReorder, registerRefresh,
}: Props) {
  const [data, setData] = useState<ReportsOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    const r = await counter.reportsOverview({ reportAccessToken });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setData(r.data);
    setError(null);
  }
  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, [reportAccessToken]);
  useEffect(() => { registerRefresh?.(refresh, loading); /* eslint-disable-next-line */ }, [loading]);

  if (error) return <FeedbackBanner>{error}</FeedbackBanner>;
  if (!data) return <ReportSkeleton label="Loading dashboard…" stats={6} />;

  return (
    <div className="flex flex-col gap-6">
      <div className="text-text-tertiary text-xs">
        As of {new Date(data.generatedAt).toLocaleString()} · location {data.locationId}
      </div>

      {/* --- KPI cards (3×2) --- */}
      <section className="grid grid-cols-2 @xl:grid-cols-3 gap-4">
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
          label="Net margin · this month"
          value={formatMoneyWithCurrency(data.margin.grossMarginPesewas)}
          sub={data.margin.revenuePesewas > 0
            ? `${(data.margin.grossMarginBps / 100).toFixed(1)}% · net COGS ${formatMoneyWithCurrency(data.margin.cogsPesewas)}`
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
          label="Net inventory · at cost"
          value={formatMoneyWithCurrency(data.inventory.totalAtCostPesewas)}
          sub={`${data.inventory.activeSkuCount} active SKUs · net retail ${formatMoneyWithCurrency(data.inventory.totalAtRetailPesewas)}`}
          footer={
            <div className="flex gap-3 text-xs">
              {data.inventory.belowReorderCount > 0 && (
                <Button variant="link" className="text-warning no-underline hover:underline" onClick={onOpenReorder}>
                  {data.inventory.belowReorderCount} below reorder <ArrowRightIcon aria-hidden="true" className="size-3.5" />
                </Button>
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

      <section className="panel p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-text-secondary uppercase tracking-wider text-xs">Revenue · last 30 days</h3>
          <div className="text-text-tertiary text-xs">
            Peak {formatMoneyWithCurrency(Math.max(0, ...data.revenueSparkline.map((d) => d.pesewas)))}
          </div>
        </div>
        <Sparkline data={data.revenueSparkline} />
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div className="panel p-5 flex flex-col gap-3">
          <h3 className="text-text-secondary uppercase tracking-wider text-xs">Top sellers · this week</h3>
          {data.topSellersThisWeek.length === 0 ? (
            <div className="text-text-tertiary text-sm py-4">No sales recorded this week.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pb-2">Product</TableHead>
                  <TableHead className="text-right pb-2">Units</TableHead>
                  <TableHead className="text-right pb-2">Revenue</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.topSellersThisWeek.map((p) => (
                  <TableRow key={p.productId}>
                    <TableCell className="py-2">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-text-tertiary text-xs font-mono">{p.sku}</div>
                    </TableCell>
                    <TableCell className="py-2 text-right font-mono tabular-nums">{p.unitsSold}</TableCell>
                    <TableCell className="py-2 text-right font-mono tabular-nums">
                      {formatMoneyWithCurrency(p.revenuePesewas)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className="panel p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-text-secondary uppercase tracking-wider text-xs">Slow movers · capital tied up</h3>
            <span className="text-text-tertiary text-xs">no sale in 14 days</span>
          </div>
          {data.slowMovers.length === 0 ? (
            <div className="text-text-tertiary text-sm py-4">
              Nothing sitting idle — every active SKU sold in the last 14 days.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pb-2">Product</TableHead>
                  <TableHead className="text-right pb-2">On hand</TableHead>
                  <TableHead className="text-right pb-2">Tied-up ₵</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.slowMovers.map((p) => (
                  <TableRow key={p.productId}>
                    <TableCell className="py-2">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-text-tertiary text-xs">
                        {p.daysSinceLastSale == null
                          ? 'never sold'
                          : `last sold ${p.daysSinceLastSale} day${p.daysSinceLastSale === 1 ? '' : 's'} ago`}
                      </div>
                    </TableCell>
                    <TableCell className="py-2 text-right font-mono tabular-nums">{p.unitsOnHand}</TableCell>
                    <TableCell className="py-2 text-right font-mono tabular-nums text-warning">
                      {formatMoneyWithCurrency(p.stockValueAtCostPesewas)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </section>

      <section className="panel p-5 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-text-secondary uppercase tracking-wider text-xs">Recent stocktake variance</h3>
          {onOpenStocktake && (
            <Button variant="link" className="text-accent no-underline hover:underline text-xs" onClick={onOpenStocktake}>
              Open stocktake <ArrowRightIcon aria-hidden="true" className="size-3.5" />
            </Button>
          )}
        </div>
        {data.recentVarianceEvents.length === 0 ? (
          <div className="text-text-tertiary text-sm py-4">No completed stocktake with variance yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pb-2">When</TableHead>
                <TableHead className="text-right pb-2">Loss</TableHead>
                <TableHead className="text-right pb-2">Found</TableHead>
                <TableHead className="text-right pb-2">Net</TableHead>
                <TableHead className="text-right pb-2">SKUs off</TableHead>
                <TableHead className="text-right pb-2">Shrinkage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.recentVarianceEvents.map((e) => {
                const net = e.lossValuePesewas - e.foundValuePesewas;
                return (
                  <TableRow key={e.stocktakeId}>
                    <TableCell className="py-2">{new Date(e.completedAt).toLocaleDateString()}</TableCell>
                    <TableCell className="py-2 text-right font-mono tabular-nums text-danger">
                      {formatMoneyWithCurrency(e.lossValuePesewas)}
                    </TableCell>
                    <TableCell className="py-2 text-right font-mono tabular-nums text-success">
                      {formatMoneyWithCurrency(e.foundValuePesewas)}
                    </TableCell>
                    <TableCell className={`py-2 text-right font-mono tabular-nums ${net > 0 ? 'text-danger' : net < 0 ? 'text-success' : ''}`}>
                      {net === 0 ? '0.00' : signedMoney(net)}
                    </TableCell>
                    <TableCell className="py-2 text-right font-mono tabular-nums">{e.productsWithVariance}</TableCell>
                    <TableCell className="py-2 text-right font-mono tabular-nums">
                      {e.shrinkageRate == null ? '—' : `${(e.shrinkageRate * 100).toFixed(2)}%`}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
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
        'panel p-5 flex flex-col gap-1 text-left',
        clickable ? 'hover:border-accent hover:bg-accent/5 cursor-pointer transition-colors' : '',
      ].join(' ')}
    >
      <div className="text-text-tertiary uppercase tracking-wider text-xs">{label}</div>
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="flex items-baseline justify-between">
        {sub && <div className="text-text-tertiary text-xs">{sub}</div>}
        {trend != null && trendLabel && (
          <div className={`inline-flex items-center gap-1 text-xs ${trendClass(trend)}`}>
            {trend >= 0 ? <TrendingUpIcon aria-label="Up" className="size-3.5" /> : <TrendingDownIcon aria-label="Down" className="size-3.5" />}
            <span className="font-mono tnum">{Math.abs(trend).toFixed(1)}%</span> <span className="text-text-tertiary">{trendLabel}</span>
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
      className="panel p-5 flex flex-col gap-3 text-left hover:border-accent hover:bg-accent/5 cursor-pointer transition-colors"
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
      <div className="grid grid-cols-2 @xl:grid-cols-4 gap-2 text-xs">
        <AgingPill label="0–30" amount={r.bucket0_30Pesewas} tone="" />
        <AgingPill label="31–60" amount={r.bucket31_60Pesewas} tone="text-text-secondary" />
        <AgingPill label="61–90" amount={r.bucket61_90Pesewas} tone="text-warning" />
        <AgingPill label="90+" amount={r.bucket90PlusPesewas} tone="text-danger" />
      </div>
      {ageWarn > 0 && (
        <div className="flex items-center gap-1.5 text-warning text-xs">
          <TriangleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span><span className="font-mono tnum">{formatMoneyWithCurrency(ageWarn)}</span> aged 60+ days — chase these first</span>
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
      className="panel p-5 flex flex-col gap-2 text-left hover:border-accent hover:bg-accent/5 cursor-pointer transition-colors"
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
      <div className="inline-flex items-center gap-1 text-text-tertiary text-xs">Click to open supplier payments <ArrowRightIcon aria-hidden="true" className="size-3.5" /></div>
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
