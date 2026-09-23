import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import type { DrawingReportResponse } from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Button } from '../../components/ui/button';
import { NativeSelect } from '../../components/ui/native-select';
import { Input } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

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
      <div className="panel p-4 flex flex-wrap items-end gap-3">
        <label>
          <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Group</span>
          <NativeSelect value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            <option value="DAILY">Daily</option>
            <option value="WEEKLY">Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </NativeSelect>
        </label>
        <label>
          <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">From</span>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        </label>
        <label>
          <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">To</span>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </label>
        <Button onClick={() => void refresh()}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
        <div className="ml-auto text-text-tertiary text-sm">
          Total drawings <span className="text-text-primary font-mono tnum">{formatMoneyWithCurrency(total)}</span>
        </div>
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}

      <div className="panel overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Beneficiary</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={5} className="px-4 py-8 text-center text-text-tertiary">No drawings in this period.</TableCell></TableRow>
            )}
            {rows.map((r) => (
              <TableRow key={`${r.periodKey}:${r.category}:${r.beneficiaryName}`}>
                <TableCell className="px-4 py-3 font-mono">{r.periodKey}</TableCell>
                <TableCell className="px-4 py-3">{r.category.replace('_', ' ').toLowerCase()}</TableCell>
                <TableCell className="px-4 py-3">{r.beneficiaryName}</TableCell>
                <TableCell className="px-4 py-3 text-right font-mono tnum">{r.count}</TableCell>
                <TableCell className="px-4 py-3 text-right font-mono tnum">{formatMoneyWithCurrency(r.totalPesewas)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
