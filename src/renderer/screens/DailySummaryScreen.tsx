import { FRIENDLY_UI_ENABLED } from '../../shared/lib/buildFlags';
// DailySummaryScreen: list recent + view detail. "Generate today" button.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { AppHeader } from '../components/AppHeader';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';
import type { DailySummaryGenerateResponse } from '../../shared/types/ipc';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { PinUnlockPanel } from '../components/PinUnlockPanel';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

interface SummaryRow { date: string; locationId: string; revenuePesewas: number; numSales: number;
  shrinkageRate: number | null; generatedAt: string; whatsappSentAt: string | null }

type FullSummary = DailySummaryGenerateResponse;

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}

export default function DailySummaryScreen({ onExit }: { onExit: () => void }) {
  const [list, setList] = useState<SummaryRow[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayIso());
  const [detail, setDetail] = useState<FullSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [activeClose, setActiveClose] = useState<{ id: string; sealedAt: string; sealedByName: string } | null>(null);
  const [reopenReason, setReopenReason] = useState('');
  const [showReopen, setShowReopen] = useState(false);
  const [varianceUnlocked, setVarianceUnlocked] = useState(false);
  const myRole = useSession((s) => s.workerRole);
  const isOwner = myRole === 'OWNER' || myRole === 'FOUNDER';

  async function refreshClose(date: string) {
    const r = await counter.periodGetActiveClose(date);
    if (r.success) setActiveClose(r.data.close ? {
      id: r.data.close.id,
      sealedAt: r.data.close.sealedAt,
      sealedByName: r.data.close.sealedByName,
    } : null);
  }

  async function sealDay() {
    const r = await counter.periodSeal(selectedDate);
    if (!r.success) { setError(r.error); return; }
    setInfo(`Day ${selectedDate} sealed.`);
    setError(null);
    await refreshClose(selectedDate);
  }
  async function reopenDay() {
    if (!reopenReason.trim()) { setError('Reopen reason required.'); return; }
    const r = await counter.periodReopen(selectedDate, reopenReason.trim());
    if (!r.success) { setError(r.error); return; }
    setInfo(`Day ${selectedDate} reopened.`);
    setError(null);
    setShowReopen(false);
    setReopenReason('');
    await refreshClose(selectedDate);
  }


  async function refreshList() {
    const r = await counter.listDailySummaries({});
    if (r.success) setList(r.data.summaries);
  }
  async function loadDetail(date: string) {
    setSelectedDate(date);
    setVarianceUnlocked(false);
    void refreshClose(date);
    const r = await counter.getDailySummary({ date });
    if (r.success) setDetail(r.data);
  }
  async function generate() {
    setError(null);
    const r = await counter.generateDailySummary({ date: selectedDate });
    if (!r.success) { setError(r.error); return; }
    setInfo(`Generated summary for ${selectedDate}.`);
    setDetail(r.data);
    await refreshList();
  }

  useEffect(() => {
    void refreshList();
    void loadDetail(todayIso());
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') { e.preventDefault(); onExit(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle={FRIENDLY_UI_ENABLED ? "Today’s summary" : "daily summary"} onBack={onExit} />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-12 py-6 grid grid-cols-1 lg:grid-cols-[1fr_2fr] gap-6">
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-text-secondary uppercase tracking-wider text-xs">Recent</h2>
            <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
          </div>
          <ul className="panel max-h-[60vh] overflow-y-auto">
            {list.map((s) => (
              <li key={`${s.date}-${s.locationId}`}>
                <button
                  onClick={() => void loadDetail(s.date)}
                  className={[
                    'w-full text-left px-4 py-3 border-b border-border',
                    selectedDate === s.date ? 'bg-accent/10' : 'hover:bg-bg-surface',
                  ].join(' ')}>
                  <div className="flex justify-between">
                    <span className="font-mono tnum">{s.date}</span>
                    <span className="font-mono tnum text-text-primary">{formatMoney(s.revenuePesewas)}</span>
                  </div>
                  <div className="text-text-tertiary text-xs mt-1 flex justify-between">
                    <span>{s.numSales} sales</span>
                    <span>{varianceUnlocked ? (s.shrinkageRate == null ? 'no stocktake' : `shrinkage ${(s.shrinkageRate * 100).toFixed(2)}%`) : 'variance locked'}</span>
                  </div>
                </button>
              </li>
            ))}
            {list.length === 0 && (
              <li className="px-4 py-3 text-text-tertiary text-sm">No summaries yet.</li>
            )}
          </ul>
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Input className="font-mono tnum" type="date" value={selectedDate} onChange={(e) => void loadDetail(e.target.value)} />
            <Button variant="primary" onClick={() => void generate()}>
              Generate / refresh
            </Button>
            {activeClose ? (
              <span className="ml-auto inline-flex items-center gap-2 px-3 py-1 bg-success/10 border border-success/40 text-success text-xs">
                Sealed by {activeClose.sealedByName} · {new Date(activeClose.sealedAt).toLocaleString()}
                {isOwner && (
                  <Button variant="link" className="ml-2 hover:text-success text-inherit" onClick={() => setShowReopen(true)}>
                    Reopen
                  </Button>
                )}
              </span>
            ) : (
              isOwner && (
                <Button size="sm" className="ml-auto" onClick={() => void sealDay()}>
                  Seal day (lock {selectedDate})
                </Button>
              )
            )}
          </div>

          {showReopen && (
            <div className="bg-bg-elevated border border-border-subtle rounded p-4 space-y-2">
              <div className="text-sm text-text-secondary">Reopen {selectedDate}. This is logged.</div>
              <Input
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder="reason — e.g. forgot a sale, wrong cash count" />
              <div className="flex justify-end gap-2">
                <Button size="sm" onClick={() => { setShowReopen(false); setReopenReason(''); }}>Cancel</Button>
                <Button variant="warning" size="sm" onClick={() => void reopenDay()}>Reopen</Button>
              </div>
            </div>
          )}

          {info && <div className="bg-bg-surface border border-success px-4 py-2 text-success text-sm">{info}</div>}
          {error && <FeedbackBanner>{error}</FeedbackBanner>}

          {!detail && <div className="text-text-tertiary text-sm">No summary for {selectedDate} yet — click Generate.</div>}

          {detail && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-3">
                <KPI label="Net revenue" value={formatMoneyWithCurrency(detail.totalRevenuePesewas)} />
                <KPI label="Net margin" value={formatMoneyWithCurrency(detail.grossMarginPesewas)} subtle={`${detail.totalRevenuePesewas > 0 ? ((detail.grossMarginPesewas / detail.totalRevenuePesewas) * 100).toFixed(1) + '%' : '—'}`} />
                <KPI label="Sales" value={String(detail.numSales)} subtle={`${detail.numUniqueCustomers} customers`} />
                <KPI label="Breakage loss" value={formatMoneyWithCurrency(detail.totalBreakageValuePesewas)} tone={detail.totalBreakageValuePesewas > 0 ? 'danger' : 'ok'} />
                <KPI label="Consumption value" value={formatMoneyWithCurrency(detail.totalConsumptionValuePesewas)} />
                <KPI label="Expenses" value={formatMoneyWithCurrency(detail.totalExpensesValuePesewas ?? 0)} tone={(detail.totalExpensesValuePesewas ?? 0) > 0 ? 'warn' : 'ok'} subtle={(detail.expensesByCategory ?? []).slice(0, 2).map(c => `${c.category} ${formatMoneyWithCurrency(c.totalPesewas)}`).join(', ') || undefined} />
                {varianceUnlocked ? (
                  <KPI label="Cash variance"
                    value={`${detail.cashCountVariancePesewas >= 0 ? '+' : ''}${formatMoney(detail.cashCountVariancePesewas)}`}
                    tone={detail.cashCountVariancePesewas < 0 ? 'danger' : detail.cashCountVariancePesewas > 0 ? 'warn' : 'ok'} />
                ) : (
                  <KPI label="Cash variance" value="Locked" subtle="PIN required" tone="warn" />
                )}
                <KPI label="Credit extended" value={formatMoneyWithCurrency(detail.creditExtendedPesewas)} />
                <KPI label="Credit collected" value={formatMoneyWithCurrency(detail.creditCollectedPesewas)} />
                <KPI label="Outstanding credit" value={formatMoneyWithCurrency(detail.totalOutstandingCreditPesewas)} />
              </div>

              {!varianceUnlocked && (
                <PinUnlockPanel
                  title="Unlock variance"
                  description="Re-enter your PIN to view cash variance, shift variance, and stocktake shrinkage on the daily summary."
                  onUnlocked={() => setVarianceUnlocked(true)}
                  buttonLabel="Unlock variance"
                />
              )}

              {varianceUnlocked && (
                <div className="panel p-5">
                  <div className="flex items-baseline justify-between mb-3">
                    <span className="text-text-secondary uppercase tracking-wider text-xs">Shrinkage (stocktake-derived)</span>
                    {detail.stocktakeShrinkageRate == null && (
                      <span className="text-text-tertiary text-xs">No completed stocktake on this date</span>
                    )}
                  </div>
                  {detail.stocktakeShrinkageRate != null && detail.stocktakeShrinkageValuePesewas != null && (
                    <div className="flex items-baseline gap-6">
                      <span className={`font-mono tnum text-3xl ${detail.stocktakeShrinkageRate > 0.02 ? 'text-danger' : 'text-success'}`}>
                        {(detail.stocktakeShrinkageRate * 100).toFixed(2)}%
                      </span>
                      <span className="text-text-secondary">
                        Loss value <span className="font-mono tnum text-text-primary">{formatMoneyWithCurrency(detail.stocktakeShrinkageValuePesewas)}</span>
                      </span>
                    </div>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="panel p-4">
                  <h4 className="text-text-secondary uppercase tracking-wider text-xs mb-2">Top SKUs</h4>
                  <ul className="text-sm">
                    {detail.topSkus.map((s) => (
                      <li key={s.sku} className="flex justify-between border-b border-border py-1">
                        <span>{s.name}</span>
                        <span className="font-mono tnum">{formatMoney(s.revenuePesewas)} · {s.unitsSold}u</span>
                      </li>
                    ))}
                    {detail.topSkus.length === 0 && <li className="text-text-tertiary text-sm">—</li>}
                  </ul>
                </div>
                <div className="panel p-4">
                  <h4 className="text-text-secondary uppercase tracking-wider text-xs mb-2">Reorder alerts</h4>
                  <ul className="text-sm">
                    {detail.reorderAlerts.map((r) => (
                      <li key={r.sku} className="flex justify-between border-b border-border py-1">
                        <span>{r.name}</span>
                        <span className="font-mono tnum text-warning">{r.unitsOnHand} ≤ {r.reorderThreshold}</span>
                      </li>
                    ))}
                    {detail.reorderAlerts.length === 0 && <li className="text-text-tertiary text-sm">All stocked above threshold.</li>}
                  </ul>
                </div>
              </div>

              <div className="panel p-4">
                <h4 className="text-text-secondary uppercase tracking-wider text-xs mb-2">Shifts</h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Worker</TableHead>
                      <TableHead>Closed</TableHead>
                      <TableHead className="text-right">Sales</TableHead>
                      <TableHead className="text-right">Variance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.shiftSummaries.map((s) => (
                      <TableRow key={s.shiftId}>
                        <TableCell className="py-1">{s.workerName}</TableCell>
                        <TableCell className="py-1 text-text-tertiary text-xs">{s.closedAt ? new Date(s.closedAt).toLocaleTimeString() : 'open'}</TableCell>
                        <TableCell className="py-1 text-right font-mono tnum">{formatMoney(s.totalSalesPesewas)}</TableCell>
                        {varianceUnlocked ? (
                          <TableCell className={`py-1 text-right font-mono tnum ${s.cashVariancePesewas == null ? 'text-text-tertiary' : s.cashVariancePesewas < 0 ? 'text-danger' : s.cashVariancePesewas > 0 ? 'text-warning' : 'text-success'}`}>
                            {s.cashVariancePesewas == null ? '—' : (s.cashVariancePesewas >= 0 ? '+' : '') + formatMoney(s.cashVariancePesewas)}
                          </TableCell>
                        ) : (
                          <TableCell className="py-1 text-right font-mono tnum text-warning">Locked</TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="text-text-tertiary text-xs">Generated {new Date(detail.generatedAt).toLocaleString()}</div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function KPI({ label, value, subtle, tone = 'ok' }: { label: string; value: string; subtle?: string; tone?: 'ok' | 'warn' | 'danger' }) {
  const c = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warning' : 'text-text-primary';
  return (
    <div className="panel p-4">
      <div className="text-text-secondary uppercase tracking-wider text-xs">{label}</div>
      <div className={`font-mono tnum text-xl mt-1 ${c}`}>{value}</div>
      {subtle && <div className="text-text-tertiary text-xs mt-1">{subtle}</div>}
    </div>
  );
}
