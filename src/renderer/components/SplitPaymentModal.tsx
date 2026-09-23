// SplitPaymentModal — multiple tenders for one sale.
//
// Cashier adds one row per tender (CASH, MOMO_MTN, etc.) with an amount.
// Confirm is enabled only when remaining balance == 0. Submitted to
// completeSale as `payments[]`.

import { PlusIcon, XIcon } from 'lucide-react';
import { useState } from 'react';
import { FRIENDLY_UI_ENABLED } from '../../shared/lib/buildFlags';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';

export type TenderMethod = 'CASH' | 'MOMO_MTN' | 'MOMO_VODAFONE' | 'MOMO_AIRTELTIGO' | 'CREDIT' | 'BANK_TRANSFER';

export interface TenderRow {
  id: string;
  method: TenderMethod;
  amountRaw: string;     // user's input, parsed at submit
  reference: string;
  cashGivenRaw: string;  // CASH only
}

const METHOD_OPTIONS: Array<{ value: TenderMethod; label: string }> = [
  { value: 'CASH', label: 'Cash' },
  { value: 'MOMO_MTN', label: 'MoMo (MTN)' },
  { value: 'MOMO_VODAFONE', label: 'MoMo (Vodafone)' },
  { value: 'MOMO_AIRTELTIGO', label: 'MoMo (AirtelTigo)' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CREDIT', label: 'Credit (customer owes)' },
];

export interface SplitPaymentResult {
  payments: Array<{
    method: TenderMethod;
    amountPesewas: number;
    reference: string | null;
    cashGivenPesewas: number | null;
  }>;
}

export function SplitPaymentModal({
  totalPesewas,
  hasCustomer,
  customerCashOnly,
  submitting = false,
  submitError = null,
  onCancel,
  onConfirm,
}: {
  totalPesewas: number;
  hasCustomer: boolean;
  customerCashOnly?: boolean;
  /** True while the parent is saving the sale; blocks a second submit. */
  submitting?: boolean;
  /** Refusal from the save. The dialog stays open with every tender intact. */
  submitError?: string | null;
  onCancel: () => void;
  onConfirm: (result: SplitPaymentResult) => void;
}) {
  const [rows, setRows] = useState<TenderRow[]>([
    { id: 'r1', method: 'CASH', amountRaw: '', reference: '', cashGivenRaw: '' },
    { id: 'r2', method: 'MOMO_MTN', amountRaw: '', reference: '', cashGivenRaw: '' },
  ]);
  const [error, setError] = useState<string | null>(null);

  const tenderTotal = rows.reduce((sum, r) => {
    const v = parseCedisToPesewas(r.amountRaw);
    return sum + (v ?? 0);
  }, 0);
  const remaining = totalPesewas - tenderTotal;

  function update(id: string, patch: Partial<TenderRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, {
      id: `r${prev.length + 1}-${Date.now()}`,
      method: 'CASH', amountRaw: '', reference: '', cashGivenRaw: '',
    }]);
  }
  function removeRow(id: string) {
    setRows((prev) => prev.length > 1 ? prev.filter((r) => r.id !== id) : prev);
  }
  function autoFillRemaining(id: string) {
    if (remaining <= 0) return;
    const cedis = (remaining / 100).toFixed(2);
    update(id, { amountRaw: cedis });
  }

  function submit() {
    if (submitting) return;
    setError(null);
    const out: SplitPaymentResult['payments'] = [];
    for (const r of rows) {
      const amount = parseCedisToPesewas(r.amountRaw);
      if (amount == null || amount <= 0) {
        return setError(`Enter an amount greater than zero for each payment.`);
      }
      if (r.method.startsWith('MOMO_') && r.reference.trim() === '') {
        return setError(`Enter the MoMo transaction number.`);
      }
      if (r.method === 'CREDIT' && !hasCustomer) {
        return setError(`Choose a customer in the cart before using Pay later.`);
      }
      if (r.method === 'CREDIT' && customerCashOnly) {
        return setError(`This customer must pay now. Choose another payment method.`);
      }
      let cashGiven: number | null = null;
      if (r.method === 'CASH' && r.cashGivenRaw.trim() !== '') {
        const cg = parseCedisToPesewas(r.cashGivenRaw);
        if (cg == null) return setError(`Cash given must be a number.`);
        if (cg < amount) return setError(`Cash given (${formatMoney(cg)}) less than tender (${formatMoney(amount)}).`);
        cashGiven = cg;
      }
      out.push({
        method: r.method,
        amountPesewas: amount,
        reference: r.reference.trim() || null,
        cashGivenPesewas: cashGiven,
      });
    }
    const sum = out.reduce((s, p) => s + p.amountPesewas, 0);
    if (sum !== totalPesewas) {
      return setError(
        `Tenders total ${formatMoney(sum)} but sale total is ${formatMoney(totalPesewas)}. ` +
        `Adjust amounts so they sum exactly to ${formatMoney(totalPesewas)}.`,
      );
    }
    onConfirm({ payments: out });
  }

  const onShortcut = (key: string) => { if (key === 'F2') submit(); };

  if (FRIENDLY_UI_ENABLED) return (
    <Dialog onClose={onCancel} busy={submitting} onShortcut={onShortcut}>
      <DialogContent showCloseButton={false} className="w-[min(48rem,calc(100%-1.5rem))] max-h-[94dvh] gap-0 overflow-hidden p-0">
        <header className="p-4 border-b border-border flex flex-wrap items-baseline justify-between gap-2">
          <DialogTitle className="text-2xl">Split payment</DialogTitle>
          <span className="text-xl">Total: <strong className="font-mono tnum">{formatMoneyWithCurrency(totalPesewas)}</strong></span>
        </header>
        <div className="min-h-0 overflow-y-auto p-4">
        <fieldset disabled={submitting} className="min-w-0 space-y-4">
          <p className="text-lg">Enter how much the customer pays with each method.</p>
          {rows.map((r, index) => (
            <section key={r.id} aria-label={`Payment ${index + 1}`} className="rounded-xl border-2 border-border bg-bg-elevated p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1 text-lg">Payment method
                <NativeSelect value={r.method} onChange={(e) => update(r.id, { method: e.target.value as TenderMethod })} className="h-14 rounded-lg text-lg">
                  {METHOD_OPTIONS.map((m) => <option key={m.value} value={m.value}>{m.value === 'CREDIT' ? 'Pay later' : m.value === 'MOMO_VODAFONE' ? 'MoMo (Telecel)' : m.label}</option>)}
                </NativeSelect>
              </label>
              <label className="flex flex-col gap-1 text-lg">Amount (GHS)
                <Input inputMode="decimal" value={r.amountRaw} onChange={(e) => update(r.id, { amountRaw: e.target.value })} placeholder="0.00" className="h-14 rounded-lg text-2xl font-mono tnum" />
              </label>
              {(r.method.startsWith('MOMO_') || r.method === 'BANK_TRANSFER') && <label className="flex flex-col gap-1 text-lg">Transaction reference
                <Input value={r.reference} onChange={(e) => update(r.id, { reference: e.target.value })} placeholder="ref / txn id" className="h-14 rounded-lg text-xl" />
              </label>}
              {r.method === 'CASH' && <label className="flex flex-col gap-1 text-lg">Money received (optional)
                <Input inputMode="decimal" value={r.cashGivenRaw} onChange={(e) => update(r.id, { cashGivenRaw: e.target.value })} placeholder="cash given" className="h-14 rounded-lg text-2xl font-mono tnum" />
              </label>}
              <div className="flex flex-wrap gap-2 items-end">
                <Button type="button" size="xl" className="text-lg" onClick={() => autoFillRemaining(r.id)} disabled={remaining <= 0}>Use remaining amount</Button>
                <Button type="button" size="xl" className="text-lg" onClick={() => removeRow(r.id)} disabled={rows.length === 1}>Remove payment {index + 1}</Button>
              </div>
            </section>
          ))}
          <Button type="button" size="xl" className="text-lg" onClick={addRow}><PlusIcon aria-hidden="true" />Add another payment</Button>
          {(error ?? submitError) && <FeedbackBanner className="text-lg">{error ?? submitError}</FeedbackBanner>}
        </fieldset>
        </div>
        <footer className="shrink-0 p-4 border-t border-border space-y-3">
          <p aria-live="polite" className="text-xl font-semibold">{remaining < 0 ? 'Too much' : 'Remaining'}: <span className="font-mono tnum">{formatMoneyWithCurrency(Math.abs(remaining))}</span></p>
          <div className="grid grid-cols-2 gap-3">
            <Button type="button" size="xl" onClick={onCancel} disabled={submitting}>Back to cart</Button>
            <Button type="button" size="xl" variant="primary" onClick={submit} disabled={remaining !== 0 || submitting}>{submitting ? 'Saving the sale…' : 'Complete sale'}</Button>
          </div>
        </footer>
      </DialogContent>
    </Dialog>
  );

  return (
    <Dialog onClose={onCancel} busy={submitting} onShortcut={onShortcut}>
      <DialogContent showCloseButton={false} className="w-[min(42rem,calc(100%-2rem))] gap-4">
        <div className="flex items-baseline justify-between gap-4">
          <DialogTitle className="text-xl">Split payment</DialogTitle>
          <div className="text-sm text-text-secondary">
            Total: <span className="font-mono tnum text-text-primary">{formatMoneyWithCurrency(totalPesewas)}</span>
          </div>
        </div>

        <fieldset disabled={submitting} className="space-y-2">
          {rows.map((r, index) => (
            <div key={r.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
              <NativeSelect
                aria-label={`Payment ${index + 1} method`}
                value={r.method}
                onChange={(e) => update(r.id, { method: e.target.value as TenderMethod })}>
                {METHOD_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </NativeSelect>
              <div className="flex items-center gap-1">
                <Input
                  aria-label={`Payment ${index + 1} amount`}
                  value={r.amountRaw}
                  onChange={(e) => update(r.id, { amountRaw: e.target.value })}
                  placeholder="0.00" inputMode="decimal"
                  className="w-28 font-mono tnum text-right" />
                <Button variant="ghost" size="sm" onClick={() => autoFillRemaining(r.id)}
                  disabled={remaining <= 0}
                  title="Fill with remaining balance">
                  fill
                </Button>
              </div>
              {r.method.startsWith('MOMO_') || r.method === 'BANK_TRANSFER' ? (
                <Input
                  aria-label={`Payment ${index + 1} reference`}
                  value={r.reference}
                  onChange={(e) => update(r.id, { reference: e.target.value })}
                  placeholder="ref / txn id"
                  className="w-40" />
              ) : r.method === 'CASH' ? (
                <Input
                  aria-label={`Payment ${index + 1} cash given`}
                  value={r.cashGivenRaw}
                  onChange={(e) => update(r.id, { cashGivenRaw: e.target.value })}
                  placeholder="cash given" inputMode="decimal"
                  className="w-32 font-mono tnum text-right" />
              ) : (
                <span className="w-40 text-text-tertiary text-xs">—</span>
              )}
              <Button variant="ghost" size="icon" onClick={() => removeRow(r.id)}
                disabled={rows.length === 1}
                aria-label={`Remove payment ${index + 1}`}
                className="hover:not-disabled:text-danger">
                <XIcon aria-hidden="true" />
              </Button>
            </div>
          ))}
        </fieldset>

        <div className="flex items-center justify-between gap-4">
          <Button size="sm" disabled={submitting} onClick={addRow}>
            <PlusIcon aria-hidden="true" />Add another payment
          </Button>
          <div className="text-sm">
            <span className="text-text-tertiary">Tendered:</span>{' '}
            <span className="font-mono tnum">{formatMoneyWithCurrency(tenderTotal)}</span>
            <span className="text-text-tertiary mx-2">·</span>
            <span className="text-text-tertiary">Remaining:</span>{' '}
            <span className={`font-mono tnum ${remaining === 0 ? 'text-success' : remaining > 0 ? 'text-warning' : 'text-danger'}`}>
              {formatMoneyWithCurrency(remaining)}
            </span>
          </div>
        </div>

        {(error ?? submitError) && <FeedbackBanner>{error ?? submitError}</FeedbackBanner>}

        <DialogFooter>
          <Button onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button variant="primary" shortcut="F2" onClick={submit} disabled={remaining !== 0 || submitting}>
            {submitting ? 'Saving the sale…' : remaining === 0 ? 'Complete sale' : remaining > 0 ? `Need ${formatMoney(remaining)} more` : `${formatMoney(-remaining)} too much`}
          </Button>
        </DialogFooter>

        <p className="text-xs text-text-tertiary">
          Sum of all tenders must equal the sale total before you can complete the sale.
          Enter the MoMo transaction number. Credit tenders need a customer selected.
          Cash-only customers cannot receive credit tenders.
        </p>
      </DialogContent>
    </Dialog>
  );
}
