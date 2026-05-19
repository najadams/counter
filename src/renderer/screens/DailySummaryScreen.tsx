// DailySummaryScreen: list recent + view detail. "Generate today" button.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { AppHeader } from '../components/AppHeader';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';
import type { DailySummaryGenerateResponse } from '../../shared/types/ipc';

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
      <AppHeader subtitle="daily summary" />
      <main className="flex-1 max-w-6xl w-full mx-auto px-12 py-6 grid grid-cols-[1fr_2fr] gap-6">
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-text-secondary uppercase tracking-wider text-xs">Recent</h2>
            <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
          </div>
          <ul className="bg-bg-surface border border-border max-h-[60vh] overflow-y-auto">
            {list.map((s) => (
              <li key={`${s.date}-${s.locationId}`}>
                <button
                  onClick={() => void loadDetail(s.date)}
                  className={[
                    'w-full text-left px-4 py-3 border-b border-border',
                    selectedDate === s.date ? 'bg-bg-elevated' : 'hover:bg-bg-elevated',
                  ].join(' ')}>
                  <div className="flex justify-between">
                    <span className="font-mono tnum">{s.date}</span>
                    <span className="font-mono tnum text-text-primary">{formatMoney(s.revenuePesewas)}</span>
                  </div>
                  <div className="text-text-tertiary text-xs mt-1 flex justify-between">
                    <span>{s.numSales} sales</span>
                    <span>{s.shrinkageRate == null ? 'no stocktake' : `shrinkage ${(s.shrinkageRate * 100).toFixed(2)}%`}</span>
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
            <input type="date" value={selectedDate} onChange={(e) => void loadDetail(e.target.value)}
              className="bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
            <button onClick={() => void generate()}
              className="bg-accent text-bg-deep px-4 py-2 font-semibold hover:bg-accent-light">
              Generate / refresh
            </button>
            {activeClose ? (
              <span className="ml-auto inline-flex items-center gap-2 px-3 py-1 bg-emerald-950/30 border border-emerald-900/50 text-emerald-300 text-xs">
                Sealed by {activeClose.sealedByName} · {new Date(activeClose.sealedAt).toLocaleString()}
                {isOwner && (
                  <button onClick={() => setShowReopen(true)}
                    className="ml-2 underline hover:text-emerald-100">
                    Reopen
                  </button>
                )}
              </span>
            ) : (
              isOwner && (
                <button onClick={() => void sealDay()}
                  className="ml-auto px-3 py-1 border border-border hover:bg-bg-elevated text-sm">
                  Seal day (lock {selectedDate})
                </button>
              )
            )}
          </div>

          {showReopen && (
            <div className="bg-bg-elevated border border-border-subtle rounded p-4 space-y-2">
              <div className="text-sm text-text-secondary">Reopen {selectedDate}. This is logged.</div>
              <input
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder="reason — e.g. forgot a sale, wrong cash count"
                className="w-full bg-bg-deep border border-border-subtle px-3 py-2 text-sm rounded" />
              <div className="flex justify-end gap-2">
                <button onClick={() => { setShowReopen(false); setReopenReason(''); }}
                  className="px-3 py-1 border border-border text-sm">Cancel</button>
                <button onClick={() => void reopenDay()}
                  className="px-3 py-1 bg-warning text-bg-deep font-semibold text-sm">Reopen</button>
              </div>
            </div>
          )}

          {info && <div className="bg-bg-surface border border-success px-4 py-2 text-success text-sm">{info}</div>}
          {error && <div className="bg-bg-surface border border-danger px-4 py-2 text-danger text-sm">{error}</div>}

          {!detail && <div className="text-text-tertiary text-sm">No summary for {selectedDate} yet — click Generate.</div>}

          {detail && (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-3 gap-3">
                <KPI label="Revenue" value={formatMoneyWithCurrency(detail.totalRevenuePesewas)} />
                <KPI label="Margin" value={formatMoneyWithCurrency(detail.grossMarginPesewas)} subtle={`${detail.totalRevenuePesewas > 0 ? ((detail.grossMarginPesewas / detail.totalRevenuePesewas) * 100).toFixed(1) + '%' : '—'}`} />
                <KPI label="Sales" value={String(detail.numSales)} subtle={`${detail.numUniqueCustomers} customers`} />
                <KPI label="Breakage loss" value={formatMoneyWithCurrency(detail.totalBreakageValuePesewas)} tone={detail.totalBreakageValuePesewas > 0 ? 'danger' : 'ok'} />
                <KPI label="Consumption value" value={formatMoneyWithCurrency(detail.totalConsumptionValuePesewas)} />
                <KPI label="Expenses" value={formatMoneyWithCurrency(detail.totalExpensesValuePesewas ?? 0)} tone={(detail.totalExpensesValuePesewas ?? 0) > 0 ? 'warn' : 'ok'} subtle={(detail.expensesByCategory ?? []).slice(0, 2).map(c => `${c.category} ${formatMoneyWithCurrency(c.totalPesewas)}`).join(', ') || undefined} />
                <KPI label="Cash variance"
                  value={`${detail.cashCountVariancePesewas >= 0 ? '+' : ''}${formatMoney(detail.cashCountVariancePesewas)}`}
                  tone={detail.cashCountVariancePesewas < 0 ? 'danger' : detail.cashCountVariancePesewas > 0 ? 'warn' : 'ok'} />
                <KPI label="Credit extended" value={formatMoneyWithCurrency(detail.creditExtendedPesewas)} />
                <KPI label="Credit collected" value={formatMoneyWithCurrency(detail.creditCollectedPesewas)} />
                <KPI label="Outstanding credit" value={formatMoneyWithCurrency(detail.totalOutstandingCreditPesewas)} />
              </div>

              <div className="bg-bg-surface border border-border p-5">
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

              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg-surface border border-border p-4">
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
                <div className="bg-bg-surface border border-border p-4">
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

              <div className="bg-bg-surface border border-border p-4">
                <h4 className="text-text-secondary uppercase tracking-wider text-xs mb-2">Shifts</h4>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-text-secondary text-xs uppercase tracking-wider">
                      <th className="text-left">Worker</th>
                      <th className="text-left">Closed</th>
                      <th className="text-right">Sales</th>
                      <th className="text-right">Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.shiftSummaries.map((s) => (
                      <tr key={s.shiftId} className="border-t border-border">
                        <td className="py-1">{s.workerName}</td>
                        <td className="py-1 text-text-tertiary text-xs">{s.closedAt ? new Date(s.closedAt).toLocaleTimeString() : 'open'}</td>
                        <td className="py-1 text-right font-mono tnum">{formatMoney(s.totalSalesPesewas)}</td>
                        <td className={`py-1 text-right font-mono tnum ${s.cashVariancePesewas == null ? 'text-text-tertiary' : s.cashVariancePesewas < 0 ? 'text-danger' : s.cashVariancePesewas > 0 ? 'text-warning' : 'text-success'}`}>
                          {s.cashVariancePesewas == null ? '—' : (s.cashVariancePesewas >= 0 ? '+' : '') + formatMoney(s.cashVariancePesewas)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
    <div className="bg-bg-surface border border-border p-4">
      <div className="text-text-secondary uppercase tracking-wider text-xs">{label}</div>
      <div className={`font-mono tnum text-xl mt-1 ${c}`}>{value}</div>
      {subtle && <div className="text-text-tertiary text-xs mt-1">{subtle}</div>}
    </div>
  );
}
