import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import type { DrawingReportResponse } from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';

type Period = 'DAILY' | 'WEEKLY' | 'MONTHLY';

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function DrawingsTab({ reportAccessToken }: { reportAccessToken: string }) {
  const [period, setPeriod] = useState<Period>('DAILY');
  const [fromDate, setFromDate] = useState(monthStart);
  const [toDate, setToDate] = useState(today);
  const [rows, setRows] = useState<DrawingReportResponse['rows']>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    const r = await counter.drawingReport({ period, fromDate, toDate, reportAccessToken });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setRows(r.data.rows);
    setError(null);
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [period, fromDate, toDate, reportAccessToken]);

  const total = rows.reduce((sum, r) => sum + r.totalPesewas, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="bg-bg-surface border border-border p-4 flex flex-wrap items-end gap-3">
        <label>
          <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Group</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}
            className="bg-bg-input border border-border-strong px-3 py-2">
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </select>
        </label>
        <label>
          <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">From</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)}
            className="bg-bg-input border border-border-strong px-3 py-2" />
        </label>
        <label>
          <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">To</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)}
            className="bg-bg-input border border-border-strong px-3 py-2" />
        </label>
        <button onClick={() => void refresh()} className="px-4 py-2 border border-border hover:bg-bg-elevated">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        <div className="ml-auto text-text-tertiary text-sm">
          Total drawings <span className="text-text-primary font-mono tnum">{formatMoneyWithCurrency(total)}</span>
        </div>
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}

      <div className="bg-bg-surface border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-deep text-text-tertiary uppercase text-xs">
            <tr>
              <th className="text-left px-4 py-3">Period</th>
              <th className="text-left px-4 py-3">Category</th>
              <th className="text-left px-4 py-3">Beneficiary</th>
              <th className="text-right px-4 py-3">Count</th>
              <th className="text-right px-4 py-3">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-text-tertiary">No drawings in this period.</td></tr>
            )}
            {rows.map((r) => (
              <tr key={`${r.periodKey}:${r.category}:${r.beneficiaryName}`} className="border-t border-border-subtle">
                <td className="px-4 py-3 font-mono">{r.periodKey}</td>
                <td className="px-4 py-3">{r.category.replace('_', ' ').toLowerCase()}</td>
                <td className="px-4 py-3">{r.beneficiaryName}</td>
                <td className="px-4 py-3 text-right font-mono tnum">{r.count}</td>
                <td className="px-4 py-3 text-right font-mono tnum">{formatMoneyWithCurrency(r.totalPesewas)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
