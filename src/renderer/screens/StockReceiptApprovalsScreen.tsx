import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '../components/AppHeader';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { counter } from '../lib/ipc';
import { formatMoneyWithCurrency } from '../../shared/lib/money';
import type { StockReceiptRequestDetail, StockReceiptRequestSummary } from '../../shared/types/ipc';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { reviewStatusTone } from '../lib/tones';
import { Segmented } from '../components/ui/segmented';
import { Textarea } from '../components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

export default function StockReceiptApprovalsScreen({ onExit, backLabel }: { onExit: () => void; backLabel?: string }) {
  const [tab, setTab] = useState<'PENDING' | 'HISTORY'>('PENDING');
  const [rows, setRows] = useState<StockReceiptRequestSummary[]>([]);
  const [selected, setSelected] = useState<StockReceiptRequestDetail | null>(null);
  const [note, setNote] = useState('');
  const [acceptCostSwing, setAcceptCostSwing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const result = await counter.stockReceiptRequestList({
      scope: 'REVIEWABLE', status: tab === 'PENDING' ? 'PENDING' : 'RESOLVED', limit: 150,
    });
    setLoading(false);
    if (!result.success) { setError(result.error); return; }
    setRows(result.data.requests); setError(null);
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
        event.preventDefault(); if (selected) setSelected(null); else onExit();
      }
    };
    window.addEventListener('focus', onFocus); window.addEventListener('keydown', onKey);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', onFocus); window.removeEventListener('keydown', onKey); };
  }, [refresh, selected, onExit]);

  async function open(row: StockReceiptRequestSummary) {
    setError(null); setMessage(null); setNote(''); setAcceptCostSwing(false);
    const result = await counter.stockReceiptRequestGet(row.id);
    if (!result.success) { setError(result.error); return; }
    setSelected(result.data);
  }

  async function decide(decision: 'APPROVE' | 'DECLINE') {
    if (!selected || deciding) return;
    if (decision === 'DECLINE' && note.trim().length < 3) { setError('Explain why this receipt is being declined.'); return; }
    if (decision === 'APPROVE' && selected.costSwingWarnings.length > 0 && !acceptCostSwing) {
      setError('Confirm that the large cost change is correct before approving.'); return;
    }
    setDeciding(true); setError(null);
    const result = await counter.stockReceiptRequestReview({ requestId: selected.id, decision,
      note: note.trim() || null, allowLargeCostSwing: decision === 'APPROVE' && acceptCostSwing });
    setDeciding(false);
    if (!result.success) { setError(result.error); return; }
    setMessage(decision === 'APPROVE'
      ? `Request #${selected.id.slice(-8)} approved. ${result.data.movementCount} stock movement(s) and ${formatMoneyWithCurrency(result.data.totalPayablePesewas)} payable are now recorded. Physically count and shelve the delivery.`
      : `Request #${selected.id.slice(-8)} declined. Stock, cost, PO, supplier balance, and ledger remain unchanged.`);
    setSelected(null); setNote(''); setAcceptCostSwing(false); await refresh();
  }

  return <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
    <AppHeader subtitle="stock approvals" onBack={onExit} backLabel={backLabel} />
    <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-8 py-6 flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><div className="eyebrow">Senior review queue</div><h1 className="text-2xl font-semibold mt-1">Stock receipt approvals</h1><p className="text-sm text-text-secondary mt-1">Verify the delivery, quantities, purchase units, costs, invoice, PO, and payable before stock is posted.</p></div>
        <Segmented label="Show" value={tab} onChange={(next) => { setTab(next); setSelected(null); }}
          options={[{ value: 'PENDING', label: 'Pending' }, { value: 'HISTORY', label: 'History' }]} />
      </header>
      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      {message && <div className="notice border-success/50 text-success">{message}</div>}
      <section className="panel overflow-hidden"><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>Requested</TableHead><TableHead>Supplier / invoice</TableHead><TableHead>Requested by</TableHead><TableHead>Lines</TableHead><TableHead>Payable</TableHead><TableHead>Status</TableHead><TableHead></TableHead></TableRow></TableHeader><TableBody>{rows.map((row) => <TableRow key={row.id}>
        <TableCell className="font-mono">{new Date(row.requestedAt).toLocaleString()}</TableCell>
        <TableCell><div>{row.supplierName ?? 'Opening stock'}</div><div className="text-xs text-text-tertiary">{row.supplierInvoiceNumber ?? row.purchaseOrderNumber ?? `#${row.id.slice(-8)}`}</div></TableCell>
        <TableCell>{row.requesterName}</TableCell><TableCell>{row.lineCount}</TableCell><TableCell className="text-right font-mono tnum">{formatMoneyWithCurrency(row.totalPayablePesewas)}</TableCell><TableCell><Status status={row.status} /></TableCell>
        <TableCell className="text-right"><Button variant="secondary" size="sm" onClick={() => void open(row)}>{row.status === 'PENDING' ? 'Review' : 'View'}</Button></TableCell>
      </TableRow>)}</TableBody></Table></div>{loading && <div className="empty-state">Loading requests…</div>}{!loading && rows.length === 0 && <div className="empty-state">{tab === 'PENDING' ? 'No stock receipts are waiting.' : 'No reviewed stock receipts yet.'}</div>}</section>

      {selected && <section className="panel p-5 sm:p-6 flex flex-col gap-5 border-warning/60">
        <div className="flex justify-between gap-3"><div><div className="eyebrow">Request #{selected.id.slice(-8)}</div><h2 className="text-xl font-semibold mt-1">{selected.supplierName ?? 'Opening stock'} · {formatMoneyWithCurrency(selected.totalPayablePesewas)}</h2><p className="text-sm text-text-secondary">Requested by {selected.requesterName} on {new Date(selected.requestedAt).toLocaleString()}</p></div><Status status={selected.status} /></div>
        <div className="notice notice-warning"><strong>Pending means unposted:</strong> stock on hand, product costs, supplier balance, purchase order, invoice, obligations, and ledger do not change until approval succeeds.</div>
        <div className="grid sm:grid-cols-4 gap-3"><Info label="Goods" value={formatMoneyWithCurrency(selected.goodsValuePesewas)} /><Info label="Transport" value={formatMoneyWithCurrency(selected.transportCostPesewas)} /><Info label="Loading" value={formatMoneyWithCurrency(selected.loadingCostPesewas)} /><Info label="Total payable" value={formatMoneyWithCurrency(selected.totalPayablePesewas)} /></div>
        <div className="grid md:grid-cols-2 gap-4"><div className="subpanel"><h3>Supplier evidence</h3><Detail label="Supplier" value={selected.supplierName ?? 'None — opening stock'} /><Detail label="Invoice" value={selected.supplierInvoiceNumber ?? 'Auto-number on approval'} /><Detail label="Invoice date" value={selected.supplierInvoiceDate ?? 'Approval date'} /><Detail label="Due date" value={selected.supplierDueDate ?? 'Supplier terms'} /><Detail label="Purchase order" value={selected.purchaseOrderNumber ?? 'Not matched'} />{selected.notes && <Detail label="Request notes" value={selected.notes} />}</div><div className="subpanel"><h3>Posting effect on approval</h3><p className="text-sm text-text-secondary mt-2">Creates {selected.lineCount} stock movement(s), updates the matched PO, creates the supplier invoice and payable, allocates landed costs, and posts inventory/creditor journals when the management ledger is active.</p></div></div>
        <div className="subpanel overflow-x-auto"><h3>Products and units</h3><Table className="mt-2"><TableHeader><TableRow><TableHead>Product</TableHead><TableHead>Purchase unit</TableHead><TableHead>Qty</TableHead><TableHead>Canonical qty</TableHead><TableHead>Cost / unit</TableHead><TableHead>Line total</TableHead><TableHead>Canonical cost</TableHead></TableRow></TableHeader><TableBody>{selected.lines.map((line) => <TableRow key={line.id}><TableCell>{line.productName}<div className="text-xs text-text-tertiary">{line.productSku}</div></TableCell><TableCell>{line.unitName} {line.conversionFactor > 1 ? `×${line.conversionFactor}` : ''}</TableCell><TableCell className="text-right font-mono">{line.quantity}</TableCell><TableCell className="text-right font-mono">{line.canonicalQuantity}</TableCell><TableCell className="text-right font-mono">{formatMoneyWithCurrency(line.unitCostPesewas)}</TableCell><TableCell className="text-right font-mono">{formatMoneyWithCurrency(line.lineTotalPesewas)}</TableCell><TableCell className="text-right text-xs"><span className="text-text-tertiary">was {formatMoneyWithCurrency(line.currentCanonicalCostPesewas)}</span><br />becomes about {formatMoneyWithCurrency(line.proposedCanonicalCostPesewas)}</TableCell></TableRow>)}</TableBody></Table></div>
        {selected.costSwingWarnings.length > 0 && <div className="notice notice-warning"><div className="font-semibold">Large cost change detected</div><ul className="list-disc ml-5 mt-2 text-sm">{selected.costSwingWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>{selected.status === 'PENDING' && <label className="flex items-start gap-2 mt-3 text-sm"><input type="checkbox" checked={acceptCostSwing} onChange={(event) => setAcceptCostSwing(event.target.checked)} /><span>I checked the purchase unit and supplier invoice. These costs are correct.</span></label>}</div>}
        {selected.status === 'PENDING' ? <><label className="text-sm text-text-secondary">Review note <span className="text-text-tertiary">(required when declining)</span><Textarea className="mt-1" rows={3} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} placeholder="What did you verify, or why are you declining?" /></label><div className="flex flex-wrap gap-3"><Button variant="secondary" onClick={() => setSelected(null)}>Cancel</Button><Button variant="danger" disabled={deciding || note.trim().length < 3} onClick={() => void decide('DECLINE')}>Decline request</Button><Button variant="primary" disabled={deciding || (selected.costSwingWarnings.length > 0 && !acceptCostSwing)} onClick={() => void decide('APPROVE')}>{deciding ? 'Posting receipt…' : 'Approve and receive stock'}</Button></div></>
          : <div className="notice"><strong>{selected.status === 'APPROVED' ? 'Approved and posted' : selected.status === 'DECLINED' ? 'Declined' : 'Withdrawn'}</strong>{selected.reviewerName ? ` by ${selected.reviewerName}` : ''}{selected.reviewedAt ? ` on ${new Date(selected.reviewedAt).toLocaleString()}` : ''}. {selected.reviewNote ?? ''}{selected.status === 'APPROVED' ? ` ${selected.movementCount} movement(s); invoice ${selected.postedSupplierInvoiceId?.slice(-8) ?? 'not applicable'}.` : ''}</div>}
      </section>}
    </main>
  </div>;
}

function Status({ status }: { status: StockReceiptRequestSummary['status'] }) { return <Badge tone={reviewStatusTone(status)}>{status[0] + status.slice(1).toLowerCase()}</Badge>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="subpanel"><div className="text-xs text-text-tertiary">{label}</div><div className="font-mono tnum mt-1">{value}</div></div>; }
function Detail({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-4 py-2 border-t border-border-subtle text-sm"><span className="text-text-secondary">{label}</span><span className="text-right">{value}</span></div>; }
