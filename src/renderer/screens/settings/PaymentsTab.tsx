// PaymentsTab — which ways of moving money this shop uses.
//
// One switch for now: does the shop pay and get paid through a bank? Turning
// it off hides Bank transfer as a payment choice and stops the owner reports
// listing an empty bank account. Stored in device_config (bank_in_use).
// OWNER or FOUNDER only; everyone else sees it read-only.

import { useEffect, useState } from 'react';
import { useSession } from '../../store/session';
import { usePaymentSettings } from '../../store/paymentSettings';
import { Checkbox } from '../../components/ui/checkbox';
import { FeedbackBanner } from '../../components/FeedbackBanner';

export function PaymentsTab() {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';
  const bankInUse = usePaymentSettings((s) => s.bankInUse);
  const load = usePaymentSettings((s) => s.load);
  const setBankInUse = usePaymentSettings((s) => s.setBankInUse);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => { void load(); }, [load]);

  async function change(next: boolean) {
    setSaving(true);
    setMessage(null);
    const error = await setBankInUse(next);
    setSaving(false);
    setMessage(error
      ? { tone: 'error', text: error }
      : { tone: 'success', text: next ? 'Bank transfer is offered again.' : 'Bank transfer is now hidden.' });
  }

  return (
    <div className="max-w-3xl flex flex-col gap-4">
      <div>
        <h2 className="text-text-secondary uppercase tracking-wider text-xs">Bank</h2>
        <p className="text-xs text-text-tertiary mt-1">
          How money moves in and out of this shop.
        </p>
      </div>
      <section className="panel p-4">
        <label className="flex items-start gap-3 text-sm">
          <Checkbox className="mt-0.5" checked={bankInUse} disabled={!isOwner || saving}
            onCheckedChange={(checked) => void change(checked === true)} />
          <span>This shop pays and gets paid through a bank
            <small className="block text-xs text-text-secondary mt-1">
              Turn this off if the shop only uses cash and MoMo. Bank transfer disappears from
              checkout and payment screens, and the owner reports stop listing an empty bank
              account. Past bank payments stay in the records.
            </small>
          </span>
        </label>
      </section>
      {!isOwner && (
        <p className="text-xs text-text-tertiary">Only OWNER or FOUNDER can change this.</p>
      )}
      {message && <FeedbackBanner tone={message.tone}>{message.text}</FeedbackBanner>}
    </div>
  );
}
