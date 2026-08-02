import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import type { ReportsBalanceSheetResponse, ReportsFinancialStatementLine } from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { buildCsvFilename, exportRowsAsCsv, pesewasToCsvNumber } from '../../lib/csv';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function BalanceSheetTab({ reportAccessToken }: { reportAccessToken: string }) {
  const [asOfDate, setAsOfDate] = useState(today);
  const [data, setData] = useState<ReportsBalanceSheetResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await counter.reportsBalanceSheet({ asOfDate, reportAccessToken });
    setLoading(false);
    if (!r.success) {
      setData(null);
      setError(r.error);
      return;
    }
    setData(r.data);
    setError(null);
  }

  function changeDate(value: string) {
    setAsOfDate(value);
    setData(null);
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [asOfDate, reportAccessToken]);

  async function exportCsv() {
    if (!data) return;
    const audited = await counter.reportsAuditAction({ reportAccessToken, action: 'EXPORT', report: 'BALANCE_SHEET' });
    if (!audited.success) { setError(audited.error); return; }
    const rows = [
      ...data.assets.lines.map((line) => ({ section: 'Assets', ...line })),
      ...data.liabilities.lines.map((line) => ({ section: 'Liabilities', ...line })),
      ...data.equity.lines.map((line) => ({ section: 'Equity', ...line })),
    ];
    exportRowsAsCsv(
      buildCsvFilename('balance_sheet', [data.asOfDate]),
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
      <div className="bg-bg-surface border border-border p-4 flex flex-wrap items-end gap-3">
        <label>
          <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">As of</span>
          <input type="date" value={asOfDate} onChange={(e) => changeDate(e.target.value)}
            className="bg-bg-input border border-border-strong px-3 py-2 font-mono" />
        </label>
        <button onClick={() => void load()} disabled={loading}
          className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm disabled:opacity-40">
          {loading ? 'Loading...' : 'Refresh'}
        </button>
        {data && (
          <button onClick={() => void exportCsv()} className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
            Export CSV
          </button>
        )}
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}

      {!data && !loading && !error && <div className="panel p-6 text-text-tertiary text-sm">No position data is available.</div>}

      {data && (
        <>
          <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Stat label="Assets" value={formatMoneyWithCurrency(data.assets.totalPesewas)} />
            <Stat label="Liabilities" value={formatMoneyWithCurrency(data.liabilities.totalPesewas)} />
            <Stat label="Owner equity" value={formatMoneyWithCurrency(data.equity.totalPesewas)}
              tone={data.equity.totalPesewas < 0 ? 'danger' : 'success'} />
          </section>

          <section className="grid grid-cols-1 xl:grid-cols-3 gap-5">
            <StatementSection title="Assets" total={data.assets.totalPesewas} lines={data.assets.lines} />
            <StatementSection title="Liabilities" total={data.liabilities.totalPesewas} lines={data.liabilities.lines} />
            <StatementSection title="Equity" total={data.equity.totalPesewas} lines={data.equity.lines} />
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

function StatementSection({ title, total, lines }: {
  title: string;
  total: number;
  lines: ReportsFinancialStatementLine[];
}) {
  return (
    <div className="bg-bg-surface border border-border overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between bg-bg-deep">
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h3>
        <div className="font-mono tnum">{formatMoneyWithCurrency(total)}</div>
      </div>
      <table className="w-full text-sm">
        <tbody>
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
