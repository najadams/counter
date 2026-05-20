// SplitPaymentModal — multiple tenders for one sale.
//
// Cashier adds one row per tender (CASH, MOMO_MTN, etc.) with an amount.
// Confirm is enabled only when remaining balance == 0. Submitted to
// completeSale as `payments[]`.

import { useState } from 'react';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';

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
  onCancel,
  onConfirm,
}: {
  totalPesewas: number;
  hasCustomer: boolean;
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
    setError(null);
    const out: SplitPaymentResult['payments'] = [];
    for (const r of rows) {
      const amount = parseCedisToPesewas(r.amountRaw);
      if (amount == null || amount <= 0) {
        return setError(`Each tender needs a positive amount.`);
      }
      if (r.method.startsWith('MOMO_') && r.reference.trim() === '') {
        return setError(`MoMo tenders need a transaction reference.`);
      }
      if (r.method === 'CREDIT' && !hasCustomer) {
        return setError(`Credit tender requires a customer. Pick one before splitting.`);
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

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center p-6 z-50">
      <div className="bg-bg-elevated rounded-lg shadow-xl w-full max-w-2xl p-6 space-y-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold">Split payment</h2>
          <div className="text-sm text-text-secondary">
            Total: <span className="font-mono text-text-primary">{formatMoneyWithCurrency(totalPesewas)}</span>
          </div>
        </div>

        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
              <select
                value={r.method}
                onChange={(e) => update(r.id, { method: e.target.value as TenderMethod })}
                className="bg-bg-deep border border-border-subtle px-2 py-2 text-sm rounded">
                {METHOD_OPTIONS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              <div className="flex items-center gap-1">
                <input
                  value={r.amountRaw}
                  onChange={(e) => update(r.id, { amountRaw: e.target.value })}
                  placeholder="0.00"
                  className="w-28 bg-bg-deep border border-border-subtle px-2 py-2 font-mono tnum text-right text-sm rounded" />
                <button onClick={() => autoFillRemaining(r.id)}
                  className="text-xs px-2 py-1 border border-border hover:bg-bg-deep"
                  disabled={remaining <= 0}
                  title="Fill with remaining balance">
                  fill
                </button>
              </div>
              {r.method.startsWith('MOMO_') || r.method === 'BANK_TRANSFER' ? (
                <input
                  value={r.reference}
                  onChange={(e) => update(r.id, { reference: e.target.value })}
                  placeholder="ref / txn id"
                  className="w-40 bg-bg-deep border border-border-subtle px-2 py-2 text-sm rounded" />
              ) : r.method === 'CASH' ? (
                <input
                  value={r.cashGivenRaw}
                  onChange={(e) => update(r.id, { cashGivenRaw: e.target.value })}
                  placeholder="cash given"
                  className="w-32 bg-bg-deep border border-border-subtle px-2 py-2 font-mono tnum text-right text-sm rounded" />
              ) : (
                <span className="w-40 text-text-tertiary text-xs">—</span>
              )}
              <button onClick={() => removeRow(r.id)}
                disabled={rows.length === 1}
                className="text-xs px-2 py-2 border border-border text-text-tertiary hover:text-danger disabled:opacity-30">
                ✕
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between">
          <button onClick={addRow}
            className="text-sm px-3 py-1 border border-border hover:bg-bg-deep">
            + Add another payment
          </button>
          <div className="text-sm">
            <span className="text-text-tertiary">Tendered:</span>{' '}
            <span className="font-mono">{formatMoneyWithCurrency(tenderTotal)}</span>
            <span className="text-text-tertiary mx-2">·</span>
            <span className="text-text-tertiary">Remaining:</span>{' '}
            <span className={`font-mono ${remaining === 0 ? 'text-success' : remaining > 0 ? 'text-warning' : 'text-danger'}`}>
              {formatMoneyWithCurrency(remaining)}
            </span>
          </div>
        </div>

        {error && <div className="text-sm text-danger bg-danger/10 border border-danger/40 rounded px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-3 pt-2">
          <button onClick={onCancel}
            className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">
            Cancel
          </button>
          <button onClick={submit}
            disabled={remaining !== 0}
            className="px-4 py-2 bg-accent text-ink font-semibold hover:bg-accent-light text-sm disabled:opacity-40">
            {remaining === 0 ? 'Complete sale' : `Need ${formatMoney(Math.abs(remaining))} more`}
          </button>
        </div>

        <p className="text-xs text-text-tertiary">
          Sum of all tenders must equal the sale total before you can complete the sale.
          MoMo tenders need a transaction reference. Credit tenders need a customer selected.
        </p>
      </div>
    </div>
  );
}
