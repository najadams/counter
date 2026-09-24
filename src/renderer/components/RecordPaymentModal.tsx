// RecordPaymentModal: take money from a customer, allocate to open sales.
// Default = FIFO; toggle to manual to pick per-sale.

import { ArrowRightIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Segmented } from './ui/segmented';
import { Textarea } from './ui/textarea';

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
    <Dialog onClose={onCancel} busy={submitting}>
      <DialogContent showCloseButton={false} className="w-[min(42rem,calc(100%-2rem))] gap-4 p-8">
        <DialogHeader>
          <DialogTitle className="text-xl">Record payment — {customerName}</DialogTitle>
          <DialogDescription>
            Outstanding balance: <span className="font-mono tnum text-text-primary">{formatMoneyWithCurrency(totalOutstanding)}</span> across {openSales.length} sale(s).
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount (cedis)">
            <Input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00" inputMode="decimal"
              className="h-14 text-2xl font-mono tnum text-right" />
          </Field>
          <Field label="Method">
            <NativeSelect value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)} className="h-14 text-base">
              {PAYMENT_METHODS.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}
            </NativeSelect>
          </Field>
        </div>
        {paymentMethod.startsWith('MOMO_') && (
          <Input value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)}
            aria-label="Transaction reference"
            placeholder="Transaction reference (required)"
            className="font-mono" />
        )}

        <div className="flex items-center gap-3 mt-2">
          <span className="text-text-secondary text-sm">Allocate</span>
          <Segmented label="Allocate" value={mode} onChange={setMode}
            options={[{ value: 'fifo', label: 'FIFO (oldest first)' }, { value: 'manual', label: 'Manual' }]} />
        </div>

        {mode === 'fifo' && amountPesewas != null && amountPesewas > 0 && (
          <div className="rounded-lg bg-bg-surface border border-border p-3 text-sm">
            <div className="eyebrow mb-2">Will allocate</div>
            <ul className="space-y-1 font-mono tnum text-xs">
              {fifoPlan.map((a) => {
                const sale = openSales.find((s) => s.saleId === a.saleId)!;
                return (
                  <li key={a.saleId} className="flex justify-between">
                    <span>#{a.saleId.slice(-6)} ({a.ageDays}d, owed {formatMoney(sale.outstandingPesewas)})</span>
                    <span className="inline-flex items-center gap-1"><ArrowRightIcon aria-hidden="true" className="size-3" />{formatMoney(a.amountPesewas)}</span>
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
          <div className="rounded-lg bg-bg-surface border border-border p-3 text-sm">
            <div className="eyebrow mb-2">Pick sales to apply</div>
            <ul className="space-y-1 text-sm">
              {openSales.map((s) => (
                <li key={s.saleId} className="grid grid-cols-[1fr_auto] gap-2 items-center">
                  <span className="font-mono tnum text-xs">
                    #{s.saleId.slice(-6)} · {s.ageDays}d old · owed {formatMoney(s.outstandingPesewas)}
                  </span>
                  <Input
                    aria-label={`Amount for sale ${s.saleId.slice(-6)}`}
                    value={manual[s.saleId] ?? ''}
                    onChange={(e) => setManual((p) => ({ ...p, [s.saleId]: e.target.value }))}
                    placeholder="0.00" inputMode="decimal"
                    className="h-8 w-24 px-2 font-mono tnum text-right" />
                </li>
              ))}
              {openSales.length === 0 && <li className="text-text-tertiary">No open sales.</li>}
            </ul>
            {amountPesewas != null && (
              <div className="text-text-tertiary text-xs mt-2 flex justify-between font-mono tnum">
                <span>Allocated: {formatMoney(manualSum)}</span>
                <span>Remaining: {formatMoney(amountPesewas - manualSum)}</span>
              </div>
            )}
          </div>
        )}

        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          aria-label="Notes" placeholder="Notes (optional)" rows={2} />

        {error && <FeedbackBanner>{error}</FeedbackBanner>}

        <div className="flex gap-3 mt-2">
          <Button size="lg" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button size="lg" variant="primary" onClick={() => void submit()}
            disabled={submitting || amountPesewas == null || amountPesewas <= 0}>
            {submitting ? 'Recording…' : 'Record payment'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
