// CustomerCreateModal: opened from PaymentModal credit flow when no
// existing customer matches the search. On success, returns the new
// customer record so the sale flow can select them.

import { XIcon } from 'lucide-react';
import { useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';

const TYPES = [
  { code: 'WALK_IN_REGULAR', label: 'Regular walk-in' },
  { code: 'WHOLESALE', label: 'Wholesale buyer' },
  { code: 'ROUTE', label: 'Route customer' },
  { code: 'STAFF_FAMILY', label: 'Staff / family' },
] as const;

export interface NewCustomer {
  id: string;
  displayName: string;
  businessName: string | null;
  phone: string;
  currentBalancePesewas: number;
  cashOnly: boolean;
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
  const [cashOnly, setCashOnly] = useState(false);
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
      cashOnly,
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
        businessName: c.businessName,
        phone: c.phone,
        currentBalancePesewas: c.currentBalancePesewas,
        cashOnly: c.cashOnly,
      });
    } else {
      onCreated({
        id: r.data.customerId,
        displayName: displayName.trim(),
        businessName: businessName.trim() || null,
        phone: phone.trim(),
        currentBalancePesewas: 0,
        cashOnly,
      });
    }
  }

  return (
    <Dialog onClose={onCancel} busy={submitting}>
      <DialogContent showCloseButton={false} className="w-[min(30rem,calc(100%-2rem))] max-h-[92vh] gap-0 p-0">
        <header className="px-6 py-5 border-b border-border-subtle flex items-center justify-between gap-4">
          <DialogTitle className="text-xl">New customer</DialogTitle>
          <Button variant="ghost" size="icon-sm" aria-label="Close" disabled={submitting} onClick={onCancel}><XIcon aria-hidden="true" /></Button>
        </header>
        {error && <FeedbackBanner className="mx-6 mt-4">{error}</FeedbackBanner>}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">
          <Field label="Name"><Input autoFocus value={displayName} onChange={(e) => setDisplayName(e.target.value)} className="h-11" /></Field>
          <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. 0244111000" className="h-11 font-mono" /></Field>
          <Field label="Customer type">
            <NativeSelect value={customerType} onChange={(e) => setCustomerType(e.target.value as typeof customerType)} className="h-11">
              {TYPES.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Business name"><Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Optional" className="h-11" /></Field>
          <Field label="Location"><Input value={locationDescription} onChange={(e) => setLocationDescription(e.target.value)} placeholder="e.g. Behind GCB Adabraka" className="h-11" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Credit limit (cedis)"><Input value={creditLimit} onChange={(e) => setCreditLimit(e.target.value)} className="h-11 font-mono tnum" /></Field>
            <Field label="Terms (days)"><Input inputMode="numeric" value={creditTermsDays} onChange={(e) => setCreditTermsDays(e.target.value.replace(/\D/g, ''))} className="h-11 font-mono tnum" /></Field>
          </div>
          <label className="flex items-start gap-3 rounded-lg bg-bg-surface border border-border px-4 py-3 text-sm">
            <input type="checkbox" checked={cashOnly} onChange={(e) => setCashOnly(e.target.checked)} className="mt-1 size-4 accent-accent" />
            <span>
              <span className="block text-text-primary">Cash-only account</span>
              <span className="block text-text-tertiary text-xs">Credit tenders are hard-blocked even when a limit is set.</span>
            </span>
          </label>
          <Field label="Preferred channel" hint="When picked at the sale flow, the cart will offer to switch to this channel.">
            <NativeSelect value={preferredChannel} onChange={(e) => setPreferredChannel(e.target.value as typeof preferredChannel)} className="h-11">
              <option value="">No preference (use cart's channel)</option>
              <option value="WALK_IN">Walk-in</option>
              <option value="WHOLESALE">Wholesale</option>
              <option value="ROUTE">Route</option>
            </NativeSelect>
          </Field>
          <div className="text-text-tertiary text-xs">
            Limit shown: <span className="font-mono tnum">{formatMoney(parseCedisToPesewas(creditLimit) ?? 0)}</span>.
            Leave 0 for customers without a formal limit.
          </div>
        </div>
        <footer className="px-6 py-4 border-t border-border-subtle flex gap-3 justify-end">
          <Button size="lg" disabled={submitting} onClick={onCancel}>Cancel</Button>
          <Button size="lg" variant="primary" onClick={() => void submit()} disabled={submitting || !displayName.trim() || !phone.trim()}>
            {submitting ? 'Creating…' : 'Create customer'}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
