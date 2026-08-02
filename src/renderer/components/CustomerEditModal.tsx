import { useState, type ReactNode } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import { FeedbackBanner } from './FeedbackBanner';

const CUSTOMER_TYPES = [
  { code: 'WALK_IN_REGULAR', label: 'Regular walk-in' },
  { code: 'WHOLESALE', label: 'Wholesale buyer' },
  { code: 'ROUTE', label: 'Route customer' },
  { code: 'STAFF_FAMILY', label: 'Staff / family' },
] as const;

export interface EditableCustomer {
  id: string;
  displayName: string;
  phone: string;
  alternatePhone: string | null;
  customerType: string;
  businessName: string | null;
  locationDescription: string | null;
  creditLimitPesewas: number;
  creditTermsDays: number;
  cashOnly: boolean;
  preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  notes: string | null;
}

export function CustomerEditModal({ customer, canEditCreditPolicy, onCancel, onSaved }: {
  customer: EditableCustomer;
  canEditCreditPolicy: boolean;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(customer.displayName);
  const [phone, setPhone] = useState(customer.phone);
  const [alternatePhone, setAlternatePhone] = useState(customer.alternatePhone ?? '');
  const [customerType, setCustomerType] = useState(customer.customerType as typeof CUSTOMER_TYPES[number]['code']);
  const [businessName, setBusinessName] = useState(customer.businessName ?? '');
  const [locationDescription, setLocationDescription] = useState(customer.locationDescription ?? '');
  const [creditLimit, setCreditLimit] = useState((customer.creditLimitPesewas / 100).toFixed(2));
  const [creditTermsDays, setCreditTermsDays] = useState(String(customer.creditTermsDays));
  const [cashOnly, setCashOnly] = useState(customer.cashOnly);
  const [preferredChannel, setPreferredChannel] = useState<'' | 'WALK_IN' | 'WHOLESALE' | 'ROUTE'>(customer.preferredChannel ?? '');
  const [notes, setNotes] = useState(customer.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const name = displayName.trim();
    if (!name) { setError('Customer name is required.'); return; }
    const fields: Parameters<typeof counter.updateCustomer>[0]['fields'] = {};
    if (name !== customer.displayName) fields.displayName = name;
    const alternate = alternatePhone.trim() || null;
    if (alternate !== customer.alternatePhone) fields.alternatePhone = alternate;
    const business = businessName.trim() || null;
    if (business !== customer.businessName) fields.businessName = business;
    const location = locationDescription.trim() || null;
    if (location !== customer.locationDescription) fields.locationDescription = location;
    const preferred = preferredChannel || null;
    if (preferred !== customer.preferredChannel) fields.preferredChannel = preferred;
    const cleanNotes = notes.trim() || null;
    if (cleanNotes !== customer.notes) fields.notes = cleanNotes;

    if (canEditCreditPolicy) {
      if (!phone.trim()) { setError('Primary phone is required.'); return; }
      const limit = parseCedisToPesewas(creditLimit);
      if (limit === null) { setError('Credit limit must be a valid non-negative amount.'); return; }
      const terms = Number(creditTermsDays);
      if (!Number.isInteger(terms) || terms < 0) { setError('Credit terms must be a non-negative whole number of days.'); return; }
      if (phone.trim() !== customer.phone) fields.phone = phone.trim();
      if (customerType !== customer.customerType) fields.customerType = customerType;
      if (limit !== customer.creditLimitPesewas) fields.creditLimitPesewas = limit;
      if (terms !== customer.creditTermsDays) fields.creditTermsDays = terms;
      if (cashOnly !== customer.cashOnly) fields.cashOnly = cashOnly;
    }

    if (Object.keys(fields).length === 0) { onCancel(); return; }
    setSubmitting(true); setError(null);
    const result = await counter.updateCustomer({ customerId: customer.id, fields });
    setSubmitting(false);
    if (!result.success) { setError(result.error); return; }
    onSaved();
  }

  return <div className="fixed inset-0 bg-scrim flex items-center justify-center z-[70] overflow-y-auto py-6" onClick={onCancel}>
    <div className="panel w-full max-w-2xl max-h-[94vh] flex flex-col my-auto" onClick={(event) => event.stopPropagation()}>
      <header className="px-6 py-5 border-b border-border-subtle flex items-center justify-between gap-4">
        <div><div className="eyebrow">Customer record</div><h2 className="text-xl font-semibold mt-1">Edit customer information</h2></div>
        <button className="btn btn-quiet" onClick={onCancel} aria-label="Close">Close</button>
      </header>
      {error && <FeedbackBanner className="mx-6 mt-4">{error}</FeedbackBanner>}
      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
        <section className="grid sm:grid-cols-2 gap-4">
          <Field label="Customer name"><input autoFocus className="input w-full" value={displayName} onChange={(e) => setDisplayName(e.target.value)} /></Field>
          <Field label="Primary phone" hint={canEditCreditPolicy ? 'A unique login/search identifier.' : 'Supervisor or above can change this.'}>
            <input className="input w-full font-mono" value={phone} disabled={!canEditCreditPolicy} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Alternate phone"><input className="input w-full font-mono" value={alternatePhone} onChange={(e) => setAlternatePhone(e.target.value)} placeholder="Optional" /></Field>
          <Field label="Business name"><input className="input w-full" value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Optional" /></Field>
          <Field label="Location description"><input className="input w-full" value={locationDescription} onChange={(e) => setLocationDescription(e.target.value)} placeholder="Landmark or delivery area" /></Field>
          <Field label="Preferred sales channel">
            <select className="input w-full" value={preferredChannel} onChange={(e) => setPreferredChannel(e.target.value as typeof preferredChannel)}>
              <option value="">No preference</option><option value="WALK_IN">Walk-in</option><option value="WHOLESALE">Wholesale</option><option value="ROUTE">Route</option>
            </select>
          </Field>
        </section>

        <section className="subpanel p-4 flex flex-col gap-4">
          <div><h3 className="font-semibold">Credit policy</h3><p className="text-xs text-text-tertiary mt-1">These fields affect what the customer may buy and require supervisor, owner, or founder access.</p></div>
          <div className="grid sm:grid-cols-3 gap-4">
            <Field label="Customer type"><select className="input w-full" value={customerType} disabled={!canEditCreditPolicy} onChange={(e) => setCustomerType(e.target.value as typeof customerType)}>{CUSTOMER_TYPES.map((type) => <option key={type.code} value={type.code}>{type.label}</option>)}</select></Field>
            <Field label="Credit limit (cedis)"><input className="input w-full font-mono tnum" value={creditLimit} disabled={!canEditCreditPolicy} onChange={(e) => setCreditLimit(e.target.value)} /></Field>
            <Field label="Terms (days)"><input className="input w-full font-mono tnum" inputMode="numeric" value={creditTermsDays} disabled={!canEditCreditPolicy} onChange={(e) => setCreditTermsDays(e.target.value.replace(/\D/g, ''))} /></Field>
          </div>
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={cashOnly} disabled={!canEditCreditPolicy} onChange={(e) => setCashOnly(e.target.checked)} /><span><span className="block">Cash-only account</span><span className="text-xs text-text-tertiary">Blocks credit tenders even when a credit limit exists.</span></span></label>
          <div className="text-xs text-text-tertiary">Current entered limit: <span className="font-mono tnum">{formatMoney(parseCedisToPesewas(creditLimit) ?? 0)}</span></div>
        </section>

        <Field label="Notes"><textarea className="input w-full" rows={4} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Delivery instructions, contact context, or account notes" /></Field>
      </div>
      <footer className="px-6 py-4 border-t border-border-subtle flex justify-end gap-3"><button className="btn btn-quiet" onClick={onCancel}>Cancel</button><button className="btn btn-primary" disabled={submitting || !displayName.trim()} onClick={() => void submit()}>{submitting ? 'Saving…' : 'Save changes'}</button></footer>
    </div>
  </div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="flex flex-col gap-1 text-sm"><span className="text-text-secondary">{label}</span>{children}{hint && <span className="text-xs text-text-tertiary">{hint}</span>}</label>;
}
