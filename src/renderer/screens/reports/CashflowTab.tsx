import { useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import type { ReportsCashflowResponse, ReportsFinancialStatementLine } from '../../../shared/types/ipc';
import { DateRangePicker, defaultDateRange, type DateRange } from '../../components/DateRangePicker';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { buildCsvFilename, exportRowsAsCsv, pesewasToCsvNumber } from '../../lib/csv';

export function CashflowTab() {
  const [range, setRangeState] = useState<DateRange>(defaultDateRange());
  const [pin, setPin] = useState('');
  const [data, setData] = useState<ReportsCashflowResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setRange(next: DateRange) {
    setRangeState(next);
    setData(null);
    setPin('');
  }

  async function load() {
    if (pin.length < 4) return;
    setLoading(true);
    const r = await counter.reportsCashflow({ fromDate: range.fromDate, toDate: range.toDate, pin });
    setLoading(false);
    if (!r.success) {
      setData(null);
      setPin('');
      setError(r.error);
      return;
    }
    setData(r.data);
    setError(null);
  }

  function exportCsv() {
    if (!data) return;
    const rows = [
      ...data.inflows.lines.map((line) => ({ section: 'Inflows', ...line })),
      ...data.outflows.lines.map((line) => ({ section: 'Outflows', ...line })),
      ...data.transfers.lines.map((line) => ({ section: 'Transfers', ...line })),
      ...data.nonCash.lines.map((line) => ({ section: 'Non-cash', ...line })),
    ];
    exportRowsAsCsv(
      buildCsvFilename('cashflow', [data.fromDate, data.toDate]),
      rows,
      [
        { header: 'section', get: (r) => r.section },
        { header: 'label', get: (r) => r.label },
        { header: 'amount_ghs', get: (r) => pesewasToCsvNumber(r.amountPesewas) },
        { header: 'note', get: (r) => r.note ?? '' },
      ],
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-bg-surface border border-border p-4 flex items-end justify-between gap-3 flex-wrap">
        <DateRangePicker value={range} onChange={setRange} />
        <div className="flex items-end gap-3">
          <label>
            <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Your PIN</span>
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              maxLength={6}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') void load(); }}
              className="bg-bg-input border border-border-strong px-3 py-2 font-mono tnum tracking-[0.35em] w-36"
            />
          </label>
          <button onClick={() => void load()} disabled={loading || pin.length < 4}
            className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm disabled:opacity-40">
            {loading ? 'Loading...' : data ? 'Refresh' : 'Unlock'}
          </button>
          {data && (
            <button onClick={exportCsv} className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Export CSV
            </button>
          )}
        </div>
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}

      {!data && !loading && (
        <div className="bg-bg-surface border border-border p-6 text-text-tertiary text-sm">
          Re-enter your own PIN to view cashflow for this date range.
        </div>
      )}

      {data && (
        <>
          <section className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <Stat label="Inflows" value={formatMoneyWithCurrency(data.inflows.totalPesewas)} tone="success" />
            <Stat label="Outflows" value={formatMoneyWithCurrency(data.outflows.totalPesewas)} />
            <Stat label="Net cashflow" value={formatMoneyWithCurrency(data.netCashflowPesewas)}
              tone={data.netCashflowPesewas < 0 ? 'danger' : 'success'} />
            <Stat label="Non-cash movement" value={formatMoneyWithCurrency(data.nonCash.totalPesewas)} />
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <StatementSection title="Inflows" total={data.inflows.totalPesewas} lines={data.inflows.lines} empty="No recorded inflows." />
            <StatementSection title="Outflows" total={data.outflows.totalPesewas} lines={data.outflows.lines} empty="No recorded outflows." />
            <StatementSection title="Transfers" total={data.transfers.totalPesewas} lines={data.transfers.lines} empty="No generic cash transfers." />
            <StatementSection title="Non-cash movement" total={data.nonCash.totalPesewas} lines={data.nonCash.lines} empty="No non-cash movements." />
          </section>

          <section className="bg-bg-surface border border-border p-4">
            <h3 className="text-text-secondary uppercase tracking-wider text-xs mb-3">Notes</h3>
            <div className="flex flex-col gap-2 text-sm text-text-tertiary">
              {data.caveats.map((c) => <div key={c}>{c}</div>)}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function StatementSection({ title, total, lines, empty }: {
  title: string;
  total: number;
  lines: ReportsFinancialStatementLine[];
  empty: string;
}) {
  return (
    <div className="bg-bg-surface border border-border overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between bg-bg-deep">
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h3>
        <div className="font-mono tnum">{formatMoneyWithCurrency(total)}</div>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {lines.length === 0 && (
            <tr><td className="px-4 py-6 text-center text-text-tertiary">{empty}</td></tr>
          )}
          {lines.map((line) => (
            <tr key={line.label} className="border-t border-border-subtle align-top">
              <td className="px-4 py-3">
                <div className="text-text-primary">{line.label}</div>
                {line.note && <div className="text-text-tertiary text-xs mt-1">{line.note}</div>}
              </td>
              <td className="px-4 py-3 text-right font-mono tnum whitespace-nowrap">
                {formatMoneyWithCurrency(line.amountPesewas)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' }) {
  const color = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-text-primary';
  return (
    <div className="bg-bg-surface border border-border p-4">
      <div className="text-xs uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className={`text-2xl font-mono tnum mt-1 ${color}`}>{value}</div>
    </div>
  );
}
