import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '../components/AppHeader';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { counter } from '../lib/ipc';
import { formatMoneyWithCurrency } from '../../shared/lib/money';
import type { SaleVoidRequestDetail, SaleVoidRequestSummary } from '../../shared/types/ipc';

type Tab = 'PENDING' | 'HISTORY';

export default function VoidApprovalsScreen({ onExit }: { onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('PENDING');
  const [rows, setRows] = useState<SaleVoidRequestSummary[]>([]);
  const [selected, setSelected] = useState<SaleVoidRequestDetail | null>(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await counter.saleVoidRequestList({
      scope: 'REVIEWABLE', status: tab === 'PENDING' ? 'PENDING' : 'RESOLVED', limit: 100,
    });
    setLoading(false);
    if (!result.success) { setError(result.error); return; }
    setRows(result.data.requests);
    setError(null);
    if (selected) {
      const current = result.data.requests.find((row) => row.id === selected.id);
      if (!current || current.status !== selected.status) setSelected(null);
    }
  }, [tab, selected]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    const onFocus = () => void refresh();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F9' || event.key === 'Escape') {
        event.preventDefault();
        if (selected) setSelected(null); else onExit();
      }
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('keydown', onKey);
    };
  }, [refresh, selected, onExit]);

  async function open(row: SaleVoidRequestSummary) {
    setError(null); setMessage(null); setNote('');
    const result = await counter.saleVoidRequestGet(row.id);
    if (!result.success) { setError(result.error); return; }
    setSelected(result.data);
  }

  async function decide(decision: 'APPROVE' | 'DECLINE') {
    if (!selected || deciding) return;
    if (decision === 'DECLINE' && note.trim().length < 3) {
      setError('Enter a short reason for declining this request.');
      return;
    }
    setDeciding(true); setError(null);
    const result = await counter.saleVoidRequestReview({
      requestId: selected.id, decision, note: note.trim() || null,
    });
    setDeciding(false);
    if (!result.success) { setError(result.error); return; }
    const affected = result.data.payments.map((payment) => payment.method.replace(/_/g, ' ')).join(', ');
    setMessage(decision === 'APPROVE'
      ? `Receipt #${result.data.saleId.slice(-8)} is voided. Complete the physical refund/restocking for: ${affected || 'the original tender'}.`
      : `Request for receipt #${result.data.saleId.slice(-8)} was declined; the sale remains valid.`);
    setSelected(null); setNote('');
    await refresh();
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="void approvals" onBack={onExit} />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-8 py-6 flex flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="eyebrow">Senior review queue</div>
            <h1 className="text-2xl font-semibold mt-1">Void approvals</h1>
            <p className="text-sm text-text-secondary mt-1">Review the receipt and its full stock, credit, tax, and cash effect before deciding.</p>
          </div>
          <div className="segmented-control">
            <button className={tab === 'PENDING' ? 'active' : ''} onClick={() => { setTab('PENDING'); setSelected(null); }}>Pending</button>
            <button className={tab === 'HISTORY' ? 'active' : ''} onClick={() => { setTab('HISTORY'); setSelected(null); }}>History</button>
          </div>
        </header>

        {error && <FeedbackBanner>{error}</FeedbackBanner>}
        {message && <div className="panel border-success/50 p-4 text-sm text-success">{message}</div>}

        <section className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="data-table w-full">
              <thead><tr><th>Requested</th><th>Receipt</th><th>Requested by</th><th>Reason</th><th>Amount</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="font-mono">{new Date(row.requestedAt).toLocaleString()}</td>
                    <td><div className="font-mono">#{row.saleId.slice(-8)}</div><div className="text-xs text-text-tertiary">{row.saleWorkerName}</div></td>
                    <td>{row.requesterName}</td>
                    <td className="max-w-xs">{row.reason}</td>
                    <td className="text-right font-mono tnum">{formatMoneyWithCurrency(row.totalPesewas)}</td>
                    <td><Status status={row.status} /></td>
                    <td className="text-right"><button className="btn btn-quiet text-xs" onClick={() => void open(row)}>{row.status === 'PENDING' ? 'Review' : 'View'}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!loading && rows.length === 0 && <div className="empty-state">{tab === 'PENDING' ? 'No void requests are waiting.' : 'No reviewed requests yet.'}</div>}
          {loading && <div className="empty-state">Loading requests…</div>}
        </section>

        {selected && <ReviewPanel request={selected} note={note} setNote={setNote} deciding={deciding} onClose={() => setSelected(null)} onDecide={decide} />}
      </main>
    </div>
  );
}

function ReviewPanel({ request, note, setNote, deciding, onClose, onDecide }: {
  request: SaleVoidRequestDetail;
  note: string;
  setNote: (value: string) => void;
  deciding: boolean;
  onClose: () => void;
  onDecide: (decision: 'APPROVE' | 'DECLINE') => Promise<void>;
}) {
  const inventoryValue = request.lines.reduce((sum, line) => sum + line.inventoryValuePesewas, 0);
  return (
    <section className="panel p-5 sm:p-6 flex flex-col gap-5 border-warning/60">
      <div className="flex justify-between gap-3">
        <div><div className="eyebrow">Receipt #{request.saleId.slice(-8)}</div><h2 className="text-xl font-semibold mt-1">{formatMoneyWithCurrency(request.totalPesewas)} · {request.channel}</h2></div>
        <Status status={request.status} />
      </div>
      <div className="grid sm:grid-cols-3 gap-3">
        <Info label="Cashier" value={request.saleWorkerName} />
        <Info label="Customer" value={request.customerName ?? 'Walk-in'} />
        <Info label="Requested by" value={`${request.requesterName} · ${new Date(request.requestedAt).toLocaleString()}`} />
      </div>
      <div className="notice notice-warning"><strong>Requested reason:</strong> {request.reason}</div>
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="subpanel">
          <h3>Receipt lines and stock effect</h3>
          {request.lines.map((line) => <div key={`${line.productId}-${line.unitName ?? ''}`} className="flex justify-between gap-3 py-2 border-t border-border-subtle text-sm"><span>{line.quantity} × {line.productName}{line.unitName ? ` (${line.unitName})` : ''}</span><span className="font-mono">{formatMoneyWithCurrency(line.lineTotalPesewas)}</span></div>)}
          <p className="text-xs text-text-secondary mt-2">Approval restores {request.lines.reduce((sum, line) => sum + line.canonicalQuantity, 0)} canonical unit(s) at the original recorded cost of {formatMoneyWithCurrency(inventoryValue)}.</p>
        </div>
        <div className="subpanel">
          <h3>Money and accounting effect</h3>
          {request.payments.map((payment) => <div key={payment.method} className="flex justify-between py-2 border-t border-border-subtle text-sm"><span>{payment.method.replace(/_/g, ' ')}</span><span className="font-mono">{formatMoneyWithCurrency(payment.amountPesewas)}</span></div>)}
          <div className="mt-2 pt-2 border-t border-border-subtle text-xs text-text-secondary space-y-1">
            <div className="flex justify-between"><span>Net sales reversed</span><span className="font-mono">{formatMoneyWithCurrency(request.accountingEffect.netSalesPesewas)}</span></div>
            <div className="flex justify-between"><span>COGS reversed</span><span className="font-mono">{formatMoneyWithCurrency(request.accountingEffect.cogsPesewas)}</span></div>
            {(request.accountingEffect.vatPesewas + request.accountingEffect.nhilPesewas + request.accountingEffect.getfundPesewas) > 0 && <>
              <div className="flex justify-between"><span>VAT reversed</span><span className="font-mono">{formatMoneyWithCurrency(request.accountingEffect.vatPesewas)}</span></div>
              <div className="flex justify-between"><span>NHIL reversed</span><span className="font-mono">{formatMoneyWithCurrency(request.accountingEffect.nhilPesewas)}</span></div>
              <div className="flex justify-between"><span>GETFund reversed</span><span className="font-mono">{formatMoneyWithCurrency(request.accountingEffect.getfundPesewas)}</span></div>
            </>}
          </div>
          <p className="text-xs text-text-secondary mt-2">Approval reverses inventory, payment rails, and {request.creditBalanceDeltaPesewas ? `customer credit by ${formatMoneyWithCurrency(Math.abs(request.creditBalanceDeltaPesewas))}` : 'no customer credit'} in the same transaction.</p>
        </div>
      </div>
      {request.status === 'PENDING' ? <>
        <label className="text-sm text-text-secondary">Review note <span className="text-text-tertiary">(required when declining)</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} rows={3} className="input mt-1 w-full" placeholder="Why are you approving or declining?" />
        </label>
        <div className="flex flex-wrap gap-3">
          <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button className="btn border-danger text-danger" disabled={deciding || note.trim().length < 3} onClick={() => void onDecide('DECLINE')}>Decline request</button>
          <button className="btn btn-primary" disabled={deciding} onClick={() => void onDecide('APPROVE')}>{deciding ? 'Posting reversal…' : 'Approve and void sale'}</button>
        </div>
      </> : <div className="notice"><strong>{request.status === 'APPROVED' ? 'Approved' : request.status === 'DECLINED' ? 'Declined' : 'Withdrawn'}</strong>{request.reviewerName ? ` by ${request.reviewerName}` : ''}{request.reviewedAt ? ` on ${new Date(request.reviewedAt).toLocaleString()}` : ''}. {request.reviewNote ?? ''}</div>}
    </section>
  );
}

function Status({ status }: { status: SaleVoidRequestSummary['status'] }) {
  return <span className={`status-badge status-${status.toLowerCase()}`}>{status.toLowerCase()}</span>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="subpanel"><div className="eyebrow">{label}</div><div className="text-sm mt-1">{value}</div></div>;
}
