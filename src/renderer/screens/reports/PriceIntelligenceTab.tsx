import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../../shared/lib/money';
import type {
  ReportsLandedCostsResponse,
  ReportsPriceHistoryResponse,
  ReportsPriceIntelligenceResponse,
} from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

export function PriceIntelligenceTab({ reportAccessToken }: { reportAccessToken: string }) {
  const [prices, setPrices] = useState<ReportsPriceIntelligenceResponse | null>(null);
  const [history, setHistory] = useState<ReportsPriceHistoryResponse | null>(null);
  const [landed, setLanded] = useState<ReportsLandedCostsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [p, h, l] = await Promise.all([
        counter.reportsPriceIntelligence({ reportAccessToken }),
        counter.reportsPriceHistory({ limit: 50, reportAccessToken }),
        counter.reportsLandedCosts({ reportAccessToken }),
      ]);
      if (!p.success) { setError(p.error); return; }
      if (!h.success) { setError(h.error); return; }
      if (!l.success) { setError(l.error); return; }
      setPrices(p.data); setHistory(h.data); setLanded(l.data); setError(null);
    })();
  }, [reportAccessToken]);

  if (error) return <FeedbackBanner>{error}</FeedbackBanner>;
  if (!prices || !history || !landed) return <div className="text-text-tertiary text-sm">Loading…</div>;

  const pricierThanCompetitor = prices.rows.filter((r) => (r.walkInVsCompetitorPesewas ?? 0) > 0).length;
  const landedTotal = landed.rows.reduce((sum, r) => sum + r.landedLineTotalPesewas, 0);

  return (
    <div className="flex flex-col gap-5">
      <section className="grid grid-cols-2 @xl:grid-cols-3 gap-4">
        <Stat label="Products" value={String(prices.rows.length)} />
        <Stat label="Above competitor" value={String(pricierThanCompetitor)} />
        <Stat label="Landed receipts" value={formatMoneyWithCurrency(landedTotal)} />
      </section>

      <section className="panel">
        <Header title="Price position" count={prices.rows.length} />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Walk-in</TableHead>
              <TableHead className="text-right">Competitor</TableHead>
              <TableHead className="text-right">Gap</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {prices.rows.slice(0, 80).map((r) => (
              <TableRow key={r.productId}>
                <TableCell className="px-4 py-2">{r.productName}<span className="text-text-tertiary text-xs ml-2">{r.sku}</span></TableCell>
                <TableCell className="px-4 py-2 text-right font-mono tnum">{formatMoney(r.costPricePesewas)}</TableCell>
                <TableCell className="px-4 py-2 text-right font-mono tnum">{formatMoney(r.walkInPricePesewas)}</TableCell>
                <TableCell className="px-4 py-2 text-right font-mono tnum">
                  {r.competitorPricePesewas == null ? '—' : formatMoney(r.competitorPricePesewas)}
                </TableCell>
                <TableCell className={`px-4 py-2 text-right font-mono tnum ${(r.walkInVsCompetitorPesewas ?? 0) > 0 ? 'text-warning' : 'text-text-tertiary'}`}>
                  {r.walkInVsCompetitorPesewas == null ? '—' : formatMoney(r.walkInVsCompetitorPesewas)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="grid grid-cols-1 @4xl:grid-cols-2 gap-4">
        <div className="panel">
          <Header title="Recent price changes" count={history.rows.length} />
          <div className="divide-y divide-border-subtle">
            {history.rows.map((r) => (
              <div key={r.id} className="px-4 py-3 text-sm flex justify-between gap-3">
                <div>
                  <div>{r.productName} <span className="text-text-tertiary text-xs">{r.fieldName}</span></div>
                  <div className="text-text-tertiary text-xs">{r.changedBy} · {new Date(r.changedAt).toLocaleString()}</div>
                </div>
                <div className="font-mono tnum text-right">
                  {r.oldPesewas == null ? '—' : formatMoney(r.oldPesewas)} → {r.newPesewas == null ? '—' : formatMoney(r.newPesewas)}
                </div>
              </div>
            ))}
            {history.rows.length === 0 && <Empty>No price changes yet.</Empty>}
          </div>
        </div>
        <div className="panel">
          <Header title="Landed cost rows" count={landed.rows.length} />
          <div className="divide-y divide-border-subtle">
            {landed.rows.slice(0, 50).map((r) => (
              <div key={`${r.invoiceId}-${r.productId}`} className="px-4 py-3 text-sm flex justify-between gap-3">
                <div>
                  <div>{r.productName} <span className="text-text-tertiary text-xs">{r.invoiceNumber}</span></div>
                  <div className="text-text-tertiary text-xs">{r.supplierName}</div>
                </div>
                <div className="font-mono tnum text-right">
                  {formatMoney(r.landedLineTotalPesewas)}
                  <div className="text-text-tertiary text-xs">
                    +{formatMoney(r.allocatedTransportCostPesewas + r.allocatedLoadingCostPesewas)}
                  </div>
                </div>
              </div>
            ))}
            {landed.rows.length === 0 && <Empty>No landed cost allocations yet.</Empty>}
          </div>
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
    <div className="panel p-4">
      <div className="text-text-tertiary uppercase tracking-wider text-xs">{label}</div>
      <div className="font-mono tnum text-xl mt-1">{value}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-6 text-text-tertiary text-sm text-center">{children}</div>;
}
