import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import type { ReportsCashflowResponse, ReportsFinancialStatementLine } from '../../../shared/types/ipc';
import { DateRangePicker, defaultDateRange, type DateRange } from '../../components/DateRangePicker';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { buildCsvFilename, exportRowsAsCsv, pesewasToCsvNumber } from '../../lib/csv';
import { Button } from '../../components/ui/button';
import { Table, TableBody, TableCell, TableRow } from '../../components/ui/table';

export function CashflowTab({ reportAccessToken }: { reportAccessToken: string }) {
  const [range, setRangeState] = useState<DateRange>(defaultDateRange());
  const [data, setData] = useState<ReportsCashflowResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function setRange(next: DateRange) {
    setRangeState(next);
    setData(null);
  }

  async function load() {
    setLoading(true);
    const r = await counter.reportsCashflow({ fromDate: range.fromDate, toDate: range.toDate, reportAccessToken });
    setLoading(false);
    if (!r.success) {
      setData(null);
      setError(r.error);
      return;
    }
    setData(r.data);
    setError(null);
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [range.fromDate, range.toDate, reportAccessToken]);

  async function exportCsv() {
    if (!data) return;
    const audited = await counter.reportsAuditAction({ reportAccessToken, action: 'EXPORT', report: 'CASHFLOW' });
    if (!audited.success) { setError(audited.error); return; }
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
      <div className="panel p-4 flex items-end justify-between gap-3 flex-wrap">
        <DateRangePicker value={range} onChange={setRange} />
        <div className="flex items-end gap-3">
          <Button onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </Button>
          {data && (
            <Button onClick={() => void exportCsv()}>
              Export CSV
            </Button>
          )}
        </div>
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}

      {!data && !loading && !error && <div className="panel p-6 text-text-tertiary text-sm">No cashflow data is available for this range.</div>}

      {data && (
        <>
          <section className="grid grid-cols-1 @2xl:grid-cols-4 gap-3">
            <Stat label="Inflows" value={formatMoneyWithCurrency(data.inflows.totalPesewas)} tone="success" />
            <Stat label="Outflows" value={formatMoneyWithCurrency(data.outflows.totalPesewas)} />
            <Stat label="Net cashflow" value={formatMoneyWithCurrency(data.netCashflowPesewas)}
              tone={data.netCashflowPesewas < 0 ? 'danger' : 'success'} />
            <Stat label="Non-cash movement" value={formatMoneyWithCurrency(data.nonCash.totalPesewas)} />
          </section>

          <section className="grid grid-cols-1 @6xl:grid-cols-2 gap-5">
            <StatementSection title="Inflows" total={data.inflows.totalPesewas} lines={data.inflows.lines} empty="No recorded inflows." />
            <StatementSection title="Outflows" total={data.outflows.totalPesewas} lines={data.outflows.lines} empty="No recorded outflows." />
            <StatementSection title="Transfers" total={data.transfers.totalPesewas} lines={data.transfers.lines} empty="No generic cash transfers." />
            <StatementSection title="Non-cash movement" total={data.nonCash.totalPesewas} lines={data.nonCash.lines} empty="No non-cash movements." />
          </section>

          <section className="panel p-4">
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
    <div className="panel overflow-hidden">
      <div className="px-4 py-3 flex items-center justify-between bg-bg-deep">
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h3>
        <div className="font-mono tnum">{formatMoneyWithCurrency(total)}</div>
      </div>
      <Table>
        <TableBody>
          {lines.length === 0 && (
            <TableRow><TableCell className="px-4 py-6 text-center text-text-tertiary">{empty}</TableCell></TableRow>
          )}
          {lines.map((line) => (
            <TableRow key={line.label} className="align-top">
              <TableCell className="px-4 py-3">
                <div className="text-text-primary">{line.label}</div>
                {line.note && <div className="text-text-tertiary text-xs mt-1">{line.note}</div>}
              </TableCell>
              <TableCell className="px-4 py-3 text-right font-mono tnum whitespace-nowrap">
                {formatMoneyWithCurrency(line.amountPesewas)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'success' | 'danger' }) {
  const color = tone === 'success' ? 'text-success' : tone === 'danger' ? 'text-danger' : 'text-text-primary';
  return (
    <div className="panel p-4">
      <div className="text-xs uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className={`text-2xl font-mono tnum mt-1 ${color}`}>{value}</div>
    </div>
  );
}
