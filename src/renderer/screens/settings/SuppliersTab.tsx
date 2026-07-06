// Suppliers admin tab — list, add, edit, deactivate. OWNER/FOUNDER only.

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoneyWithCurrency, parseCedisToPesewas, formatMoney } from '../../../shared/lib/money';
import { FeedbackBanner } from '../../components/FeedbackBanner';

interface AdminSupplier {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  paymentTermsDays: number;
  creditLimitPesewas: number;
  paymentSchedule: 'ON_RECEIPT' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'CUSTOM';
  currentBalancePesewas: number;
  notes: string | null;
  active: boolean;
}

export function SuppliersTab() {
  const myRole = useSession((s) => s.workerRole);
  const isAdmin = myRole === 'OWNER' || myRole === 'FOUNDER';

  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<AdminSupplier | null>(null);

  async function refresh() {
    const r = await counter.listSuppliersForAdmin();
    if (r.success) setSuppliers(r.data.suppliers);
    else setError(r.error);
  }
  useEffect(() => { void refresh(); }, []);

  function flash(message: string, kind: 'info' | 'error') {
    if (kind === 'info') { setInfo(message); setError(null); setTimeout(() => setInfo(null), 4000); }
    else { setError(message); setInfo(null); }
  }

  async function deactivate(id: string) {
    const r = await counter.deactivateSupplier(id);
    if (!r.success) flash(r.error, 'error');
    else { flash('Supplier deactivated.', 'info'); await refresh(); }
  }
  async function reactivate(id: string) {
    const r = await counter.reactivateSupplier(id);
    if (!r.success) flash(r.error, 'error');
    else { flash('Supplier reactivated.', 'info'); await refresh(); }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-3">
        <button
          onClick={() => isAdmin && setShowAdd(true)}
          disabled={!isAdmin}
          title={isAdmin ? '' : 'OWNER or FOUNDER role required to add suppliers'}
          className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light text-sm disabled:opacity-40 disabled:cursor-not-allowed">
          + Add supplier
        </button>
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      {info && <div className="bg-success/10 border border-success/40 text-success text-sm px-3 py-2 rounded">{info}</div>}

      <div className="bg-bg-elevated rounded border border-border-subtle overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-deep text-text-tertiary uppercase text-xs">
            <tr>
              <th className="text-left px-4 py-3">Name</th>
              <th className="text-left px-4 py-3">Contact</th>
              <th className="text-left px-4 py-3">Phone</th>
              <th className="text-right px-4 py-3">Terms</th>
              <th className="text-right px-4 py-3">Limit</th>
              <th className="text-right px-4 py-3">Balance</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {suppliers.length === 0 && (
              <tr><td colSpan={8} className="px-4 py-8 text-center text-text-tertiary">
                No suppliers yet. {isAdmin ? 'Add the first one above.' : ''}
              </td></tr>
            )}
            {suppliers.map((s) => (
              <tr key={s.id} className="border-t border-border-subtle hover:bg-bg-deep/40">
                <td className="px-4 py-3 font-medium">{s.name}</td>
                <td className="px-4 py-3 text-text-secondary">{s.contactPerson ?? '—'}</td>
                <td className="px-4 py-3 text-text-secondary">{s.phone ?? '—'}</td>
                <td className="px-4 py-3 text-right">{s.paymentTermsDays} days · {s.paymentSchedule.replace('_', ' ').toLowerCase()}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {s.creditLimitPesewas > 0 ? formatMoneyWithCurrency(s.creditLimitPesewas) : '—'}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {formatMoneyWithCurrency(s.currentBalancePesewas)}
                </td>
                <td className="px-4 py-3">
                  {s.active
                    ? <span className="text-success">Active</span>
                    : <span className="text-text-tertiary">Inactive</span>}
                </td>
                <td className="px-4 py-3 text-right">
                  {isAdmin ? (
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => setEditing(s)}
                        className="text-xs px-3 py-1 border border-border hover:bg-bg-elevated">
                        Edit
                      </button>
                      {s.active
                        ? <button onClick={() => deactivate(s.id)}
                            className="text-xs px-3 py-1 border border-border hover:bg-bg-elevated text-danger">
                            Deactivate
                          </button>
                        : <button onClick={() => reactivate(s.id)}
                            className="text-xs px-3 py-1 border border-border hover:bg-bg-elevated text-success">
                            Reactivate
                          </button>}
                    </div>
                  ) : (
                    <span className="text-text-tertiary text-xs" title="OWNER or FOUNDER role required">admin only</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <SupplierFormModal
          mode="add"
          onClose={() => setShowAdd(false)}
          onSaved={async () => { setShowAdd(false); flash('Supplier added.', 'info'); await refresh(); }}
        />
      )}
      {editing && (
        <SupplierFormModal
          mode="edit"
          supplier={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); flash('Supplier updated.', 'info'); await refresh(); }}
        />
      )}
    </div>
  );
}

function SupplierFormModal({
  mode, supplier, onClose, onSaved,
}: {
  mode: 'add' | 'edit';
  supplier?: AdminSupplier;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(supplier?.name ?? '');
  const [contactPerson, setContactPerson] = useState(supplier?.contactPerson ?? '');
  const [phone, setPhone] = useState(supplier?.phone ?? '');
  const [email, setEmail] = useState(supplier?.email ?? '');
  const [paymentTermsDays, setPaymentTermsDays] = useState(supplier?.paymentTermsDays ?? 0);
  const [creditLimit, setCreditLimit] = useState(formatMoney(supplier?.creditLimitPesewas ?? 0));
  const [paymentSchedule, setPaymentSchedule] = useState<AdminSupplier['paymentSchedule']>(supplier?.paymentSchedule ?? 'ON_RECEIPT');
  const [notes, setNotes] = useState(supplier?.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) return setErr('Name is required.');
    const creditLimitPesewas = parseCedisToPesewas(creditLimit);
    if (creditLimitPesewas == null || creditLimitPesewas < 0) return setErr('Credit limit must be a valid amount.');
    setBusy(true);
    if (mode === 'add') {
      const r = await counter.addSupplier({
        name: name.trim(),
        contactPerson: contactPerson.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        paymentTermsDays,
        creditLimitPesewas,
        paymentSchedule,
        notes: notes.trim() || null,
      });
      setBusy(false);
      if (!r.success) return setErr(r.error);
      onSaved();
    } else if (supplier) {
      const r = await counter.updateSupplier({
        supplierId: supplier.id,
        fields: {
          name: name.trim(),
          contactPerson: contactPerson.trim() || null,
          phone: phone.trim() || null,
          email: email.trim() || null,
          paymentTermsDays,
          creditLimitPesewas,
          paymentSchedule,
          notes: notes.trim() || null,
        },
      });
      setBusy(false);
      if (!r.success) return setErr(r.error);
      onSaved();
    }
  }

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center p-6 z-50">
      <form onSubmit={submit} className="bg-bg-elevated rounded-lg shadow-xl w-full max-w-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold">{mode === 'add' ? 'Add supplier' : 'Edit supplier'}</h2>

        <label className="block">
          <span className="block text-sm text-text-secondary mb-1">Business name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">Contact person</span>
            <input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)}
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
          </label>
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">Phone</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="0244 123 456"
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
          </label>
        </div>

        <label className="block">
          <span className="block text-sm text-text-secondary mb-1">Email (optional)</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
        </label>

        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">Terms (days)</span>
            <input type="number" min={0} value={paymentTermsDays}
              onChange={(e) => setPaymentTermsDays(parseInt(e.target.value || '0', 10))}
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
          </label>
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">Credit limit (₵)</span>
            <input value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)}
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle tabular-nums" />
          </label>
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">Schedule</span>
            <select value={paymentSchedule} onChange={(e) => setPaymentSchedule(e.target.value as AdminSupplier['paymentSchedule'])}
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle">
              <option value="ON_RECEIPT">On receipt</option>
              <option value="WEEKLY">Weekly</option>
              <option value="BIWEEKLY">Biweekly</option>
              <option value="MONTHLY">Monthly</option>
              <option value="CUSTOM">Custom</option>
            </select>
          </label>
        </div>

        <label className="block">
          <span className="block text-sm text-text-secondary mb-1">Notes</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
        </label>

        {err && <FeedbackBanner>{err}</FeedbackBanner>}

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} disabled={busy}
            className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">
            Cancel
          </button>
          <button type="submit" disabled={busy}
            className="px-4 py-2 bg-accent text-ink font-semibold hover:bg-accent-light text-sm disabled:opacity-50">
            {busy ? 'Saving…' : (mode === 'add' ? 'Add supplier' : 'Save changes')}
          </button>
        </div>
      </form>
    </div>
  );
}
