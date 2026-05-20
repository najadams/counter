// Supplier Payments tab — record payments to suppliers and view the
// running ledger. OWNER/FOUNDER only for recording; others can view.
//
// Two panels:
//   1. "Who do we owe?" — one row per supplier with the cached current
//      balance, lifetime received cost, lifetime paid, and last activity.
//   2. "Recent payments" — chronological log of supplier_payments, filterable
//      by supplier and date.

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoneyWithCurrency, parseCedisToPesewas } from '../../../shared/lib/money';
import type {
  SupplierPaymentRow, SupplierStatementRow,
} from '../../../shared/types/ipc';

interface AdminSupplier {
  id: string;
  name: string;
  active: boolean;
}

const PAYMENT_METHODS: Array<{ code: string; label: string; needsRef: boolean }> = [
  { code: 'CASH', label: 'Cash', needsRef: false },
  { code: 'MOMO_MTN', label: 'MTN Mobile Money', needsRef: true },
  { code: 'MOMO_VODAFONE', label: 'Telecel Cash', needsRef: true },
  { code: 'MOMO_AIRTELTIGO', label: 'AirtelTigo Money', needsRef: true },
  { code: 'BANK_TRANSFER', label: 'Bank transfer', needsRef: true },
];

export function SupplierPaymentsTab() {
  const myRole = useSession((s) => s.workerRole);
  const isAdmin = myRole === 'OWNER' || myRole === 'FOUNDER';

  const [statements, setStatements] = useState<SupplierStatementRow[]>([]);
  const [payments, setPayments] = useState<SupplierPaymentRow[]>([]);
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [filterSupplier, setFilterSupplier] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showRecord, setShowRecord] = useState<{ presetSupplierId?: string } | null>(null);

  async function refresh() {
    const [stmtRes, payRes, supRes] = await Promise.all([
      counter.listSupplierStatements({ includeInactive: false }),
      counter.listSupplierPayments({
        supplierId: filterSupplier || null, limit: 100,
      }),
      counter.listSuppliersForAdmin(),
    ]);
    if (!stmtRes.success) { setError(stmtRes.error); return; }
    if (!payRes.success)  { setError(payRes.error); return; }
    if (!supRes.success)  { setError(supRes.error); return; }
    setStatements(stmtRes.data.rows);
    setPayments(payRes.data.payments);
    setSuppliers(
      supRes.data.suppliers.map((s) => ({ id: s.id, name: s.name, active: s.active })),
    );
    setError(null);
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filterSupplier]);

  function flash(msg: string, kind: 'info' | 'error') {
    if (kind === 'info') { setInfo(msg); setError(null); setTimeout(() => setInfo(null), 4000); }
    else { setError(msg); setInfo(null); }
  }

  const totalOwed = useMemo(
    () => statements.reduce((s, r) => s + Math.max(0, r.currentBalancePesewas), 0),
    [statements],
  );

  return (
    <div className="flex flex-col gap-5">
      {/* Header + action */}
      <div className="flex items-center justify-between">
        <div className="text-sm text-text-tertiary">
          Total currently owed across suppliers:&nbsp;
          <span className="text-text-primary tabular-nums font-semibold">
            {formatMoneyWithCurrency(totalOwed)}
          </span>
        </div>
        <button
          onClick={() => isAdmin && setShowRecord({})}
          disabled={!isAdmin}
          title={isAdmin ? '' : 'OWNER or FOUNDER role required to record payments'}
          className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light text-sm disabled:opacity-40 disabled:cursor-not-allowed">
          + Record payment
        </button>
      </div>

      {error && <div className="bg-danger/10 border border-danger/40 text-danger text-sm px-3 py-2 rounded">{error}</div>}
      {info && <div className="bg-success/10 border border-success/40 text-success text-sm px-3 py-2 rounded">{info}</div>}

      {/* Statements: who do we owe? */}
      <section>
        <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">Supplier balances</h3>
        <div className="bg-bg-elevated rounded border border-border-subtle overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-deep text-text-tertiary uppercase text-xs">
              <tr>
                <th className="text-left px-4 py-3">Supplier</th>
                <th className="text-right px-4 py-3">Cached balance</th>
                <th className="text-right px-4 py-3">Lifetime received</th>
                <th className="text-right px-4 py-3">Lifetime paid</th>
                <th className="text-left px-4 py-3">Last receipt</th>
                <th className="text-left px-4 py-3">Last payment</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {statements.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-text-tertiary">
                  No active suppliers. Add suppliers under the Suppliers tab.
                </td></tr>
              )}
              {statements.map((r) => {
                const owe = r.currentBalancePesewas;
                return (
                  <tr key={r.supplierId}
                      className="border-t border-border-subtle hover:bg-bg-deep/40">
                    <td className="px-4 py-3 font-medium">{r.supplierName}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span className={
                        owe > 0 ? 'text-warning'
                        : owe < 0 ? 'text-success'
                        : 'text-text-tertiary'
                      }>
                        {formatMoneyWithCurrency(owe)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-text-secondary">
                      {formatMoneyWithCurrency(r.lifetimeReceivedCostPesewas)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-text-secondary">
                      {formatMoneyWithCurrency(r.lifetimePaidPesewas)}
                    </td>
                    <td className="px-4 py-3 text-text-tertiary text-xs">
                      {r.lastReceiptAt ? new Date(r.lastReceiptAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-text-tertiary text-xs">
                      {r.lastPaidAt ? new Date(r.lastPaidAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => isAdmin && setShowRecord({ presetSupplierId: r.supplierId })}
                        disabled={!isAdmin}
                        className="text-xs px-3 py-1 border border-border hover:bg-bg-elevated disabled:opacity-40 disabled:cursor-not-allowed">
                        Pay
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-text-tertiary mt-2 leading-relaxed">
          "Cached balance" is what the system currently believes we owe. Positive = we owe them,
          negative = we've overpaid / paid in advance. "Lifetime received" comes from the audit
          log of past stock receipts — receipts older than the audit-tracking change will not
          appear here, so the number may be lower than reality on older shops.
        </p>
      </section>

      {/* Recent payments log */}
      <section>
        <div className="flex items-end justify-between mb-2">
          <h3 className="text-xs uppercase tracking-wider text-text-tertiary">Recent payments</h3>
          <label className="block">
            <span className="block text-xs text-text-tertiary mb-1">Filter by supplier</span>
            <select value={filterSupplier} onChange={(e) => setFilterSupplier(e.target.value)}
              className="px-3 py-1.5 rounded bg-bg-deep border border-border-subtle text-sm min-w-[14rem]">
              <option value="">All suppliers</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (inactive)'}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="bg-bg-elevated rounded border border-border-subtle overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-deep text-text-tertiary uppercase text-xs">
              <tr>
                <th className="text-left px-4 py-3">When</th>
                <th className="text-left px-4 py-3">Supplier</th>
                <th className="text-right px-4 py-3">Amount</th>
                <th className="text-left px-4 py-3">Method</th>
                <th className="text-left px-4 py-3">Reference</th>
                <th className="text-left px-4 py-3">Approved by</th>
                <th className="text-left px-4 py-3">Notes</th>
              </tr>
            </thead>
            <tbody>
              {payments.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-text-tertiary">
                  No payments recorded {filterSupplier ? 'for this supplier' : 'yet'}.
                </td></tr>
              )}
              {payments.map((p) => (
                <tr key={p.id} className="border-t border-border-subtle hover:bg-bg-deep/40">
                  <td className="px-4 py-3 text-text-secondary">
                    {new Date(p.paidAt).toLocaleString(undefined, {
                      year: 'numeric', month: 'short', day: '2-digit',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </td>
                  <td className="px-4 py-3 font-medium">{p.supplierName}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatMoneyWithCurrency(p.amountPesewas)}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{p.paymentMethod}</td>
                  <td className="px-4 py-3 text-text-secondary">{p.paymentReference ?? '—'}</td>
                  <td className="px-4 py-3 text-text-secondary">{p.approvedByName}</td>
                  <td className="px-4 py-3 text-text-tertiary text-xs">{p.notes ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {showRecord && (
        <RecordPaymentModal
          suppliers={suppliers.filter((s) => s.active)}
          presetSupplierId={showRecord.presetSupplierId}
          onClose={() => setShowRecord(null)}
          onSaved={async () => {
            setShowRecord(null);
            flash('Payment recorded.', 'info');
            await refresh();
          }}
        />
      )}
    </div>
  );
}

function RecordPaymentModal({
  suppliers, presetSupplierId, onClose, onSaved,
}: {
  suppliers: AdminSupplier[];
  presetSupplierId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [supplierId, setSupplierId] = useState(presetSupplierId ?? (suppliers[0]?.id ?? ''));
  const [amountStr, setAmountStr] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<string>('CASH');
  const [reference, setReference] = useState('');
  const [paidAtDate, setPaidAtDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const method = PAYMENT_METHODS.find((m) => m.code === paymentMethod)!;
  const needsRef = method.needsRef;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!supplierId) return setErr('Pick a supplier.');
    const amount = parseCedisToPesewas(amountStr);
    if (amount == null || amount <= 0) return setErr('Enter a valid amount in cedis (e.g. 250.00).');
    if (needsRef && !reference.trim()) return setErr(`${method.label} requires a reference number.`);

    setBusy(true);
    // Store paidAt as the chosen date at noon UTC so it sorts predictably
    // and doesn't accidentally fall into yesterday in any TZ.
    const paidAtISO = new Date(`${paidAtDate}T12:00:00Z`).toISOString();
    const r = await counter.recordSupplierPayment({
      supplierId,
      amountPesewas: amount,
      paymentMethod,
      paymentReference: reference.trim() || null,
      paidAt: paidAtISO,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (!r.success) return setErr(r.error);
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center p-6 z-50">
      <form onSubmit={submit}
        className="bg-bg-elevated rounded-lg shadow-xl w-full max-w-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold">Record supplier payment</h2>

        <label className="block">
          <span className="block text-sm text-text-secondary mb-1">Supplier</span>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle">
            {suppliers.length === 0 && <option value="">No active suppliers — add one first</option>}
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">Amount (₵)</span>
            <input autoFocus inputMode="decimal" placeholder="0.00"
              value={amountStr} onChange={(e) => setAmountStr(e.target.value)}
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle tabular-nums" />
          </label>
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">Date paid</span>
            <input type="date" value={paidAtDate}
              onChange={(e) => setPaidAtDate(e.target.value)}
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
          </label>
        </div>

        <label className="block">
          <span className="block text-sm text-text-secondary mb-1">Payment method</span>
          <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle">
            {PAYMENT_METHODS.map((m) => (
              <option key={m.code} value={m.code}>{m.label}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-sm text-text-secondary mb-1">
            Reference{needsRef ? '' : ' (optional)'}
          </span>
          <input value={reference} onChange={(e) => setReference(e.target.value)}
            placeholder={needsRef ? 'MoMo transaction ID, cheque #, etc.' : ''}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
        </label>

        <label className="block">
          <span className="block text-sm text-text-secondary mb-1">Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
        </label>

        {err && <div className="text-sm text-danger bg-danger/10 border border-danger/40 rounded px-3 py-2">{err}</div>}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} disabled={busy}
            className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">
            Cancel
          </button>
          <button type="submit" disabled={busy || suppliers.length === 0}
            className="px-4 py-2 bg-accent text-ink font-semibold hover:bg-accent-light text-sm disabled:opacity-50">
            {busy ? 'Saving…' : 'Record payment'}
          </button>
        </div>
      </form>
    </div>
  );
}
