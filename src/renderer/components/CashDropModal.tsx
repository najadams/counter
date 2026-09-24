// CashDropModal: enter amount + recipient, then supervisor PIN.
// Shown over HomeScreen on F2.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { SupervisorPinModal } from './SupervisorPinModal';
import { formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import type { DrawingPolicyRow } from '../../shared/types/ipc';
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Textarea } from './ui/textarea';

const COMMON_RECIPIENTS = ['Owner', 'Bank deposit', 'Supplier payment', 'Other'];
const CATEGORIES = [
  { value: 'GENERIC_DROP', label: 'Generic cash drop' },
  { value: 'OWNER_DRAWING', label: 'Owner drawing' },
  { value: 'FAMILY_SUPPORT', label: 'Family support' },
  { value: 'OWNER_SALARY', label: 'Owner salary' },
  { value: 'OTHER_DRAWING', label: 'Other drawing' },
] as const;

export function CashDropModal({ shiftId, onClose, onDone }: {
  shiftId: string; onClose: () => void; onDone: () => void;
}) {
  const [expected, setExpected] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState(COMMON_RECIPIENTS[0]!);
  const [category, setCategory] = useState<typeof CATEGORIES[number]['value']>('GENERIC_DROP');
  const [policies, setPolicies] = useState<DrawingPolicyRow[]>([]);
  const [drawingPolicyId, setDrawingPolicyId] = useState('');
  const [customRecipient, setCustomRecipient] = useState('');
  const [notes, setNotes] = useState('');
  const [askingSupervisor, setAskingSupervisor] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await counter.getExpectedCash(shiftId);
      if (r.success) setExpected(r.data.expectedCashPesewas);
      const p = await counter.listDrawingPolicies();
      if (p.success) setPolicies(p.data.policies.filter((row) => row.active));
    })();
  }, [shiftId]);

  const amountPesewas = parseCedisToPesewas(amount);
  const selectedPolicy = policies.find((p) => p.id === drawingPolicyId);
  const finalRecipient = selectedPolicy?.beneficiaryName
    ?? (recipient === 'Other' ? customRecipient.trim() : recipient);
  const valid = amountPesewas !== null && amountPesewas > 0 && finalRecipient.length > 0
    && (expected === null || amountPesewas <= expected);

  async function approve(supervisorWorkerId: string, supervisorPin: string) {
    if (!amountPesewas) return;
    setError(null);
    const r = await counter.recordCashDrop({
      shiftId, amountPesewas, recipient: finalRecipient,
      category,
      drawingPolicyId: drawingPolicyId || null,
      notes: notes.trim() || null,
      supervisorWorkerId, supervisorPin,
    });
    setAskingSupervisor(false);
    if (!r.success) { setError(r.error); return; }
    onDone();
  }

  // The supervisor dialog renders inside this one so the two stack as
  // parent and child: only the top one answers Escape.
  return (
    <Dialog onClose={onClose}>
      <DialogContent showCloseButton={false} className="w-[min(28rem,calc(100%-2rem))] gap-4 p-8">
        <DialogHeader>
          <DialogTitle className="text-xl">Cash drop</DialogTitle>
          {expected !== null && (
            <DialogDescription>
              Current expected cash: <span className="font-mono tnum text-text-primary">{formatMoneyWithCurrency(expected)}</span>
            </DialogDescription>
          )}
        </DialogHeader>
        <Field label="Amount (cedis)">
          <Input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00" inputMode="decimal"
            className="h-14 text-2xl font-mono tnum text-right" />
        </Field>
        {amountPesewas !== null && expected !== null && amountPesewas > expected && (
          <div className="text-danger text-xs">
            Exceeds expected cash by {formatMoneyWithCurrency(amountPesewas - expected)}.
          </div>
        )}
        <Field label="Category">
          <NativeSelect
            value={category}
            onChange={(e) => { setCategory(e.target.value as typeof category); setDrawingPolicyId(''); }}
            className="h-11">
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </NativeSelect>
        </Field>
        {category !== 'GENERIC_DROP' && (
          <Field label="Drawing policy">
            <NativeSelect value={drawingPolicyId} onChange={(e) => setDrawingPolicyId(e.target.value)} className="h-11">
              <option value="">No recurring policy</option>
              {policies.filter((p) => p.category === category).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.beneficiaryName} · {p.cadence.toLowerCase()} cap {formatMoneyWithCurrency(p.limitPesewas)}
                </option>
              ))}
            </NativeSelect>
          </Field>
        )}
        <Field label="Recipient">
          <NativeSelect value={recipient} onChange={(e) => setRecipient(e.target.value)} className="h-11">
            {COMMON_RECIPIENTS.map((r) => <option key={r}>{r}</option>)}
          </NativeSelect>
        </Field>
        {recipient === 'Other' && (
          <Input value={customRecipient} onChange={(e) => setCustomRecipient(e.target.value)}
            aria-label="Recipient name" placeholder="Who?" />
        )}
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          aria-label="Notes" placeholder="Notes (optional)" rows={2} />
        {error && <FeedbackBanner>{error}</FeedbackBanner>}
        <div className="flex gap-3">
          <Button size="lg" onClick={onClose}>Cancel</Button>
          <Button size="lg" variant="primary" onClick={() => setAskingSupervisor(true)} disabled={!valid}>
            Get supervisor approval
          </Button>
        </div>
        {askingSupervisor && (
          <SupervisorPinModal
            title={`Approve cash drop of ${amountPesewas != null ? formatMoneyWithCurrency(amountPesewas) : ''} to ${finalRecipient}`}
            onCancel={() => setAskingSupervisor(false)}
            onApprove={approve}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
