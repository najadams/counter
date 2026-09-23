// Recent sales and the asynchronous same-day void-request workflow.

import { useEffect, useState } from 'react';
import { useCart } from '../store/cart';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { CorrectSaleModal } from '../components/CorrectSaleModal';
import { ReceiptPrintModal } from '../components/ReceiptPrintModal';
import type { SaleReceipt } from '../../shared/lib/receipt';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { useSession } from '../store/session';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { reviewStatusTone } from '../lib/tones';
import { Input } from '../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';

interface RecentSale {
  id: string; createdAt: string; channel: string; totalPesewas: number;
  paymentMethod: string; workerName: string; customerName: string | null;
  voided: boolean; lineCount: number;
  voidRequest: {
    id: string; status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'WITHDRAWN';
    reason: string; requestedAt: string; requesterId: string; requesterName: string;
    reviewedAt: string | null; reviewerName: string | null; reviewNote: string | null;
  } | null;
}

export default function VoidSaleScreen({ onExit, onDuplicate }: { onExit: () => void; onDuplicate?: () => void }) {
  const loadLines = useCart((s) => s.loadLines);
  const workerId = useSession((s) => s.workerId);
  const [sales, setSales] = useState<RecentSale[]>([]);
  const [selected, setSelected] = useState<RecentSale | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [receiptDetail, setReceiptDetail] = useState<{
    receipt: SaleReceipt; amountPaidPesewas: number; amountOutstandingPesewas: number | null;
  } | null>(null);
  const [loadingReceiptId, setLoadingReceiptId] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState<RecentSale | null>(null);

  async function refresh() {
    const r = await counter.listRecentSales(50);
    if (r.success) setSales(r.data.sales);
  }
  useEffect(() => {
    void refresh();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') { e.preventDefault(); if (selected) setSelected(null); else onExit(); }
    }
    window.addEventListener('keydown', onKey);
    const poll = window.setInterval(() => void refresh(), 10_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('focus', onFocus); window.clearInterval(poll); };
  }, [selected, onExit]);

  async function reprint(saleId: string) {
    // Open the on-screen receipt preview; the user prints via the OS dialog
    // (or saves as PDF). Works on any printer the OS sees — no dependency on
    // a thermal-printer interface being configured. In production with a
    // thermal printer set as the OS default, the print dialog still picks it.
    setError(null);
    setInfo(null);
    setLoadingReceiptId(saleId);
    const r = await counter.getSaleReceipt(saleId);
    setLoadingReceiptId(null);
    if (!r.success) {
      setError(`Could not load receipt: ${r.error}`);
      return;
    }
    setReceiptDetail(r.data);
  }

  async function duplicate(saleId: string) {
    setError(null);
    const r = await counter.getSaleLines(saleId);
    if (!r.success) { setError(r.error); return; }
    const data = r.data;
    // A duplicate is a NEW sale, so it rings at today's prices, not the
    // original's snapshot prices — the backend refuses lines priced below
    // the current list (price floor), and stale prices would trip it.
    const repriced = await counter.repriceLines({
      channel: data.channel,
      lines: data.lines.map((l) => ({ productId: l.productId, unitId: l.unitId })),
    });
    if (!repriced.success) { setError(repriced.error); return; }
    const freshPrice = new Map(
      repriced.data.lines.map((l) => [`${l.productId}:${l.unitId ?? ''}`, l.unitPricePesewas]),
    );
    loadLines(
      data.lines.map((l) => {
        const price = freshPrice.get(`${l.productId}:${l.unitId ?? ''}`) ?? l.unitPricePesewas;
        return {
          productId: l.productId, sku: l.productSku, name: l.productName,
          unitId: l.unitId, unitName: l.unitName, factor: l.factor,
          basePricePesewas: price, unitPricePesewas: price,
          appliedTierId: null, appliedTierMinQuantity: null,
          quantity: l.quantity, unitsOnHand: l.unitsOnHand,
        };
      }),
      data.channel,
      data.customerId && data.customerName
        ? { id: data.customerId, displayName: data.customerName, phone: '', currentBalancePesewas: 0 }
        : null,
    );
    onDuplicate?.();
  }

  async function submitRequest() {
    if (!selected) return;
    setError(null);
    const res = await counter.saleVoidRequestCreate({ saleId: selected.id, reason: reason.trim() });
    if (!res.success) { setError(res.error); return; }
    setInfo(`Void request submitted for receipt #${selected.id.slice(-8)}. The sale remains valid until a senior worker approves it.`);
    setSelected(null);
    setReason('');
    await refresh();
  }

  async function withdraw(requestId: string) {
    setError(null);
    const result = await counter.saleVoidRequestWithdraw(requestId);
    if (!result.success) { setError(result.error); return; }
    setInfo(`Void request for receipt #${result.data.saleId.slice(-8)} was withdrawn. The sale remains valid.`);
    await refresh();
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="void sale" onBack={onExit} />
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-12 py-8 flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">Recent sales</h2>
          <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
        </div>
        {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}
        <div className="panel overflow-y-auto" style={{ maxHeight: '60vh' }}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Worker</TableHead>
                <TableHead>Channel · Payment</TableHead>
                <TableHead className="text-right">Total</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="text-sm">
              {sales.map((s) => (
                <TableRow key={s.id} className={`border-t border-border ${s.voided ? 'text-text-tertiary' : ''} ${s.voidRequest?.status === 'PENDING' ? 'bg-warning/10' : ''}`}>
                  <TableCell className="px-4 py-3 font-mono tnum">
                    {new Date(s.createdAt).toLocaleTimeString()}
                    <span className="text-text-tertiary ml-2">#{s.id.slice(-6)}</span>
                    {s.voidRequest && <div className="mt-1"><Badge tone={reviewStatusTone(s.voidRequest.status)}>{s.voidRequest.status.toLowerCase()}</Badge></div>}
                  </TableCell>
                  <TableCell className="px-4 py-3">{s.workerName}</TableCell>
                  <TableCell className="px-4 py-3">{s.channel} · {s.paymentMethod}{s.customerName ? ` · ${s.customerName}` : ''}</TableCell>
                  <TableCell className="px-4 py-3 text-right font-mono tnum">{formatMoney(s.totalPesewas)}</TableCell>
                  <TableCell className="px-4 py-3 text-right">
                    <div className="flex gap-2 justify-end">
                      <Button size="sm" className="text-text-tertiary"
                        onClick={() => void reprint(s.id)}
                        disabled={loadingReceiptId === s.id}>
                        {loadingReceiptId === s.id ? 'Loading…' : 'Print receipt'}
                      </Button>
                      <Button size="sm" className="text-text-tertiary"
                        onClick={() => void duplicate(s.id)}>
                        Duplicate
                      </Button>
                      {s.voided
                        ? <Badge tone="danger">Voided</Badge>
                        : s.voidRequest?.status === 'PENDING'
                        ? <>
                            <Badge tone="warning">Pending approval</Badge>
                            {s.voidRequest.requesterId === workerId && (
                              <Button variant="secondary" size="sm" onClick={() => void withdraw(s.voidRequest!.id)}>Withdraw</Button>
                            )}
                          </>
                        : <>
                            <Button size="sm" className="text-text-tertiary"
                              onClick={() => { setCorrecting(s); setError(null); setInfo(null); }}>
                              Correct
                            </Button>
                            <Button variant="danger" size="sm"
                              onClick={() => { setSelected(s); setReason(''); setError(null); setInfo(null); }}>
                              Submit void request
                            </Button>
                          </>}
                    </div>
                  </TableCell>
                </TableRow>
              )).flatMap((row, index) => {
                const sale = sales[index];
                return sale?.voidRequest && sale.voidRequest.status !== 'PENDING'
                  ? [row, <TableRow key={`${sale.id}-decision`} className="bg-bg-elevated/35"><TableCell colSpan={5} className="px-4 py-2 text-xs text-text-secondary">{sale.voidRequest.status === 'WITHDRAWN' ? `Withdrawn by ${sale.voidRequest.requesterName}.` : `${sale.voidRequest.status === 'APPROVED' ? 'Approved' : 'Declined'} by ${sale.voidRequest.reviewerName ?? 'senior worker'}${sale.voidRequest.reviewedAt ? ` on ${new Date(sale.voidRequest.reviewedAt).toLocaleString()}` : ''}.`}{sale.voidRequest.reviewNote ? ` ${sale.voidRequest.reviewNote}` : ''}</TableCell></TableRow>]
                  : [row];
              })}
              {sales.length === 0 && (
                <TableRow><TableCell colSpan={5} className="px-4 py-6 text-text-tertiary text-center">No sales yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        {selected && (
          <div className="panel p-6 flex flex-col gap-4">
            <div>
              <div className="eyebrow">Same-day review</div>
              <h3 className="text-lg font-semibold mt-1">Request void for receipt #{selected.id.slice(-8)}</h3>
            </div>
            <div className="text-text-tertiary text-sm">
              {selected.workerName} · {selected.channel} · {selected.paymentMethod} ·
              <span className="ml-2 font-mono tnum text-text-primary">{formatMoneyWithCurrency(selected.totalPesewas)}</span>
            </div>
            <label className="text-text-secondary text-xs uppercase tracking-wider">Reason (required)</label>
            <Input className="h-12 px-4"
              autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. customer changed mind, wrong product, accidental double-scan" />
            {error && <FeedbackBanner>{error}</FeedbackBanner>}
            <div className="flex gap-3">
              <Button size="lg" onClick={() => setSelected(null)}>Cancel</Button>
              <Button variant="primary"
                onClick={() => void submitRequest()}
                disabled={reason.trim().length < 3 || reason.trim().length > 200}
                className="disabled:opacity-40">
                Submit void request
              </Button>
            </div>
            <p className="text-xs text-warning">Do not refund cash or return stock yet. The original sale remains valid until approval.</p>
          </div>
        )}
      </main>

      {correcting && (
        <CorrectSaleModal
          sale={correcting}
          onCancel={() => setCorrecting(null)}
          onDone={(msg) => { setCorrecting(null); setInfo(msg); void refresh(); }}
        />
      )}

      {receiptDetail && (
        <ReceiptPrintModal
          receipt={receiptDetail.receipt}
          amountPaidPesewas={receiptDetail.amountPaidPesewas}
          amountOutstandingPesewas={receiptDetail.amountOutstandingPesewas}
          onClose={() => setReceiptDetail(null)}
        />
      )}
    </div>
  );
}
