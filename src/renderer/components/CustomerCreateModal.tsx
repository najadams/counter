// CustomerCreateModal: opened from PaymentModal credit flow when no
// existing customer matches the search. On success, returns the new
// customer record so the sale flow can select them.

import { useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';

const TYPES = [
  { code: 'WALK_IN_REGULAR', label: 'Regular walk-in' },
  { code: 'WHOLESALE', label: 'Wholesale buyer' },
  { code: 'ROUTE', label: 'Route customer' },
  { code: 'STAFF_FAMILY', label: 'Staff / family' },
] as const;

export interface NewCustomer {
  id: string;
  displayName: string;
  phone: string;
  currentBalancePesewas: number;
}

export function CustomerCreateModal({
  initialPhone,
  onCancel,
  onCreated,
}: {
  initialPhone?: string;
  onCancel: () => void;
  onCreated: (customer: NewCustomer) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState(initialPhone ?? '');
  const [customerType, setCustomerType] = useState<typeof TYPES[number]['code']>('WALK_IN_REGULAR');
  const [businessName, setBusinessName] = useState('');
  const [locationDescription, setLocationDescription] = useState('');
  const [creditLimit, setCreditLimit] = useState('0.00');
  const [creditTermsDays, setCreditTermsDays] = useState('0');
  const [preferredChannel, setPreferredChannel] = useState<'' | 'WALK_IN' | 'WHOLESALE' | 'ROUTE'>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    const limit = parseCedisToPesewas(creditLimit);
    if (limit == null) { setError('Credit limit must be a valid number.'); setSubmitting(false); return; }
    const terms = Number(creditTermsDays.replace(/\D/g, '')) || 0;

    const r = await counter.createCustomer({
      displayName: displayName.trim(),
      phone: phone.trim(),
      customerType,
      businessName: businessName.trim() || null,
      locationDescription: locationDescription.trim() || null,
      creditLimitPesewas: limit,
      creditTermsDays: terms,
      preferredChannel: preferredChannel || null,
    });
    setSubmitting(false);
    if (!r.success) { setError(r.error); return; }

    // Refetch by phone to get the row (handles alreadyExisted case too).
    const search = await counter.searchCustomers(phone.trim(), 1);
    if (search.success && search.data.customers[0]) {
      const c = search.data.customers[0];
      onCreated({
        id: c.id,
        displayName: c.displayName,
        phone: c.phone,
        currentBalancePesewas: c.currentBalancePesewas,
      });
    } else {
      onCreated({
        id: r.data.customerId,
        displayName: displayName.trim(),
        phone: phone.trim(),
        currentBalancePesewas: 0,
      });
    }
  }

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center z-[60] overflow-y-auto py-8" onClick={onCancel}>
      <div className="bg-bg-surface border border-border w-full max-w-md p-8 flex flex-col gap-4 my-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">New customer</h3>
        <input autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Name" className="bg-bg-input border border-border-strong px-4 py-3" />
        <input value={phone} onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone (e.g. 0244111000)"
          className="bg-bg-input border border-border-strong px-4 py-3 font-mono" />
        <select value={customerType} onChange={(e) => setCustomerType(e.target.value as typeof customerType)}
          className="bg-bg-input border border-border-strong px-4 py-3 text-text-primary">
          {TYPES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
        </select>
        <input value={businessName} onChange={(e) => setBusinessName(e.target.value)}
          placeholder="Business name (optional)" className="bg-bg-input border border-border-strong px-4 py-3" />
        <input value={locationDescription} onChange={(e) => setLocationDescription(e.target.value)}
          placeholder="Location (e.g. Behind GCB Adabraka)"
          className="bg-bg-input border border-border-strong px-4 py-3" />
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-text-secondary uppercase tracking-wider text-xs">Credit limit (cedis)</span>
            <input value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)}
              className="bg-bg-input border border-border-strong px-4 py-3 font-mono tnum" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-text-secondary uppercase tracking-wider text-xs">Terms (days)</span>
            <input value={creditTermsDays} onChange={(e) => setCreditTermsDays(e.target.value.replace(/\D/g, ''))}
              className="bg-bg-input border border-border-strong px-4 py-3 font-mono tnum" />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-text-secondary uppercase tracking-wider text-xs">Preferred channel</span>
          <select value={preferredChannel} onChange={(e) => setPreferredChannel(e.target.value as typeof preferredChannel)}
            className="bg-bg-input border border-border-strong px-4 py-3">
            <option value="">No preference (use cart's channel)</option>
            <option value="WALK_IN">Walk-in</option>
            <option value="WHOLESALE">Wholesale</option>
            <option value="ROUTE">Route</option>
          </select>
          <span className="text-text-tertiary text-xs">When picked at the sale flow, the cart will offer to switch to this channel.</span>
        </div>
        <div className="text-text-tertiary text-xs">
          Limit shown: <span className="font-mono tnum">{formatMoney(parseCedisToPesewas(creditLimit) ?? 0)}</span>.
          Set 0 for cash-only customers.
        </div>
        {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}
        <div className="flex gap-3">
          <button onClick={onCancel} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
          <button onClick={() => void submit()}
            disabled={submitting || !displayName.trim() || !phone.trim()}
            className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
            {submitting ? 'Creating…' : 'Create customer'}
          </button>
        </div>
      </div>
    </div>
  );
}
