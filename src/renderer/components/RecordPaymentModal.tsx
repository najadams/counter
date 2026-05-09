// RecordPaymentModal: take money from a customer, allocate to open sales.
// Default = FIFO; toggle to manual to pick per-sale.

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';

interface OpenSale { saleId: string; createdAt: string; totalPesewas: number; paidPesewas: number; outstandingPesewas: number; ageDays: number }

const PAYMENT_METHODS = [
  { code: 'CASH', label: 'Cash' },
  { code: 'MOMO_MTN', label: 'MTN MoMo' },
  { code: 'MOMO_VODAFONE', label: 'Telecel Cash' },
  { code: 'MOMO_AIRTELTIGO', label: 'AirtelTigo' },
  { code: 'BANK_TRANSFER', label: 'Bank transfer' },
] as const;

export function RecordPaymentModal({
  customerId, customerName, onCancel, onDone,
}: {
  customerId: string;
  customerName: string;
  onCancel: () => void;
  onDone: (result: { paymentId: string; totalAllocatedPesewas: number; unallocatedPesewas: number }) => void;
}) {
  const [openSales, setOpenSales] = useState<OpenSale[]>([]);
  const [amount, setAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<typeof PAYMENT_METHODS[number]['code']>('CASH');
  const [paymentReference, setPaymentReference] = useState('');
  const [notes, setNotes] = useState('');
  const [mode, setMode] = useState<'fifo' | 'manual'>('fifo');
  const [manual, setManual] = useState<Record<string, string>>({}); // saleId -> raw input
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await counter.customerOpenSales(customerId);
      if (r.success) setOpenSales(r.data.sales);
    })();
  }, [customerId]);

  const amountPesewas = parseCedisToPesewas(amount);

  // FIFO preview
  const fifoPlan = useMemo(() => {
    if (amountPesewas == null) return [];
    const plan: Array<{ saleId: string; amountPesewas: number; ageDays: number }> = [];
    let remaining = amountPesewas;
    for (const s of openSales) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, s.outstandingPesewas);
      if (take > 0) plan.push({ saleId: s.saleId, amountPesewas: take, ageDays: s.ageDays });
      remaining -= take;
    }
    return plan;
  }, [amountPesewas, openSales]);

  const fifoUnallocated = amountPesewas != null
    ? amountPesewas - fifoPlan.reduce((s, a) => s + a.amountPesewas, 0)
    : 0;

  const manualPlan = openSales
    .map((s) => {
      const raw = manual[s.saleId];
      const v = raw == null || raw === '' ? null : parseCedisToPesewas(raw);
      return v != null && v > 0 ? { saleId: s.saleId, amountPesewas: v, outstanding: s.outstandingPesewas } : null;
    })
    .filter((x): x is { saleId: string; amountPesewas: number; outstanding: number } => x !== null);
  const manualSum = manualPlan.reduce((s, a) => s + a.amountPesewas, 0);

  async function submit() {
    if (amountPesewas == null || amountPesewas <= 0) { setError('Enter a valid amount.'); return; }
    if (paymentMethod.startsWith('MOMO_') && paymentReference.trim() === '') {
      setError('MoMo payment requires a transaction reference.');
      return;
    }
    if (mode === 'manual') {
      if (manualSum > amountPesewas) {
        setError(`Allocations total ${formatMoney(manualSum)} exceeds payment amount ${formatMoney(amountPesewas)}.`);
        return;
      }
      for (const a of manualPlan) {
        if (a.amountPesewas > a.outstanding) {
          setError(`Allocation on one sale exceeds its outstanding amount.`);
          return;
        }
      }
    }
    setSubmitting(true);
    setError(null);
    const r = await counter.recordCustomerPayment({
      customerId,
      amountPesewas,
      paymentMethod,
      paymentReference: paymentMethod.startsWith('MOMO_') ? paymentReference.trim() : null,
      allocations: mode === 'manual' ? manualPlan.map(a => ({ saleId: a.saleId, amountPesewas: a.amountPesewas })) : undefined,
      notes: notes.trim() || null,
    });
    setSubmitting(false);
    if (!r.success) { setError(r.error); return; }
    onDone({
      paymentId: r.data.paymentId,
      totalAllocatedPesewas: r.data.totalAllocatedPesewas,
      unallocatedPesewas: r.data.unallocatedPesewas,
    });
  }

  const totalOutstanding = openSales.reduce((s, l) => s + l.outstandingPesewas, 0);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 overflow-y-auto py-8" onClick={onCancel}>
      <div className="bg-bg-surface border border-border w-full max-w-2xl p-8 flex flex-col gap-4 my-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">Record payment — {customerName}</h3>
        <div className="text-text-tertiary text-sm">
          Outstanding balance: <span className="font-mono tnum text-text-primary">{formatMoneyWithCurrency(totalOutstanding)}</span> across {openSales.length} sale(s).
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-text-secondary text-xs uppercase tracking-wider">Amount (cedis)</label>
            <input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="bg-bg-input border border-border-strong px-3 py-3 text-2xl font-mono tnum text-right" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-text-secondary text-xs uppercase tracking-wider">Method</label>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)}
              className="bg-bg-input border border-border-strong px-3 py-3">
              {PAYMENT_METHODS.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
            </select>
          </div>
        </div>
        {paymentMethod.startsWith('MOMO_') && (
          <input value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)}
            placeholder="Transaction reference (required)"
            className="bg-bg-input border border-border-strong px-3 py-2 font-mono" />
        )}

        <div className="flex items-center gap-3 mt-2">
          <span className="text-text-secondary text-xs uppercase tracking-wider">Allocate</span>
          <div className="flex">
            <button onClick={() => setMode('fifo')} className={`px-3 py-1 border ${mode === 'fifo' ? 'border-accent text-accent' : 'border-border text-text-secondary'} text-xs`}>FIFO (oldest first)</button>
            <button onClick={() => setMode('manual')} className={`px-3 py-1 border ${mode === 'manual' ? 'border-accent text-accent' : 'border-border text-text-secondary'} text-xs`}>Manual</button>
          </div>
        </div>

        {mode === 'fifo' && amountPesewas != null && amountPesewas > 0 && (
          <div className="bg-bg-deep border border-border p-3 text-sm">
            <div className="text-text-secondary uppercase tracking-wider text-xs mb-2">Will allocate</div>
            <ul className="space-y-1 font-mono tnum text-xs">
              {fifoPlan.map((a) => {
                const sale = openSales.find((s) => s.saleId === a.saleId)!;
                return (
                  <li key={a.saleId} className="flex justify-between">
                    <span>#{a.saleId.slice(-6)} ({a.ageDays}d, owed {formatMoney(sale.outstandingPesewas)})</span>
                    <span>→ {formatMoney(a.amountPesewas)}</span>
                  </li>
                );
              })}
              {fifoUnallocated > 0 && (
                <li className="flex justify-between text-warning">
                  <span>Overpayment</span>
                  <span>{formatMoney(fifoUnallocated)}</span>
                </li>
              )}
              {fifoPlan.length === 0 && <li className="text-text-tertiary">No open sales to allocate against.</li>}
            </ul>
          </div>
        )}

        {mode === 'manual' && (
          <div className="bg-bg-deep border border-border p-3 text-sm">
            <div className="text-text-secondary uppercase tracking-wider text-xs mb-2">Pick sales to apply</div>
            <ul className="space-y-1 text-sm">
              {openSales.map((s) => (
                <li key={s.saleId} className="grid grid-cols-[1fr_auto] gap-2 items-baseline">
                  <span className="font-mono tnum text-xs">
                    #{s.saleId.slice(-6)} · {s.ageDays}d old · owed {formatMoney(s.outstandingPesewas)}
                  </span>
                  <input
                    value={manual[s.saleId] ?? ''}
                    onChange={(e) => setManual((p) => ({ ...p, [s.saleId]: e.target.value }))}
                    placeholder="0.00"
                    className="bg-bg-input border border-border-strong px-2 py-1 font-mono tnum text-right w-24 text-sm" />
                </li>
              ))}
              {openSales.length === 0 && <li className="text-text-tertiary">No open sales.</li>}
            </ul>
            {amountPesewas != null && (
              <div className="text-text-tertiary text-xs mt-2 flex justify-between">
                <span>Allocated: {formatMoney(manualSum)}</span>
                <span>Remaining: {formatMoney(amountPesewas - manualSum)}</span>
              </div>
            )}
          </div>
        )}

        <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)" className="bg-bg-input border border-border-strong px-3 py-2 text-sm" rows={2} />

        {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}

        <div className="flex gap-3 mt-2">
          <button onClick={onCancel} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
          <button onClick={() => void submit()}
            disabled={submitting || amountPesewas == null || amountPesewas <= 0}
            className="bg-accent text-bg-deep px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
            {submitting ? 'Recording…' : 'Record payment'}
          </button>
        </div>
      </div>
    </div>
  );
}
