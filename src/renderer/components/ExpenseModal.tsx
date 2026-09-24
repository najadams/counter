// ExpenseModal — record a petty cash expense paid out of the till.
// Uses the same supervisor-PIN gate pattern as cash drops + breakage.

import { useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Textarea } from './ui/textarea';

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'STAFF_WAGES', label: 'Staff wages' },
  { value: 'STAFF_ADVANCE', label: 'Staff advance' },
  { value: 'COMMISSION', label: 'Commission / bonus' },
  { value: 'STAFF_WELFARE', label: 'Staff welfare' },
  { value: 'UTILITIES', label: 'Utilities (water, light, phone)' },
  { value: 'TRANSPORT', label: 'Transport (taxi, fuel, runner)' },
  { value: 'SUPPLIES',  label: 'Supplies (cleaning, packaging)' },
  { value: 'COMMS',     label: 'Communications (airtime, data)' },
  { value: 'REPAIRS',   label: 'Repairs (cooler, fridge, register)' },
  { value: 'RENT',      label: 'Rent / lease' },
  { value: 'BANK_FEES', label: 'Bank / MoMo fees' },
  { value: 'OTHER',     label: 'Other' },
];

const PHOTO_THRESHOLD = 5000;       // ₵50
const SUPERVISOR_THRESHOLD = 10000; // ₵100

export function ExpenseModal({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: () => void;
}) {
  const meId = useSession((s) => s.workerId);
  const meRole = useSession((s) => s.workerRole);

  const [amountRaw, setAmountRaw] = useState('');
  const [category, setCategory] = useState('UTILITIES');
  const [payee, setPayee] = useState('');
  const [notes, setNotes] = useState('');
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoExt, setPhotoExt] = useState<string | null>(null);

  const [supervisorWorkerId, setSupervisorWorkerId] = useState('');
  const [supervisorPin, setSupervisorPin] = useState('');
  const [supervisors, setSupervisors] = useState<Array<{ id: string; fullName: string; role: string }>>([]);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = parseCedisToPesewas(amountRaw);
  const needsPhoto = amount != null && amount >= PHOTO_THRESHOLD;
  const needsSupervisor = amount != null && amount >= SUPERVISOR_THRESHOLD;
  const cashierIsSupervisor = meRole === 'SUPERVISOR' || meRole === 'OWNER' || meRole === 'FOUNDER';

  // Lazy-load workers when supervisor PIN box appears.
  async function ensureSupervisors() {
    if (supervisors.length > 0) return;
    const r = await counter.adminListWorkers();
    if (r.success) {
      const ws = r.data.workers
        .filter((w: { role: string; active: boolean }) => w.active && ['SUPERVISOR','OWNER','FOUNDER'].includes(w.role))
        .map((w: { id: string; fullName: string; role: string }) => ({ id: w.id, fullName: w.fullName, role: w.role }));
      setSupervisors(ws);
      if (ws[0]) setSupervisorWorkerId(ws[0].id);
    }
  }

  function onPickPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      // Strip the "data:image/...;base64," prefix.
      const comma = result.indexOf(',');
      setPhotoBase64(comma >= 0 ? result.slice(comma + 1) : result);
      setPhotoExt(ext);
    };
    reader.readAsDataURL(file);
  }

  async function submit() {
    setError(null);
    if (amount == null || amount <= 0) return setError('Enter a positive amount.');
    if (needsPhoto && !photoBase64) return setError(`Receipts ≥ ₵50 need a photo of the receipt.`);
    if (needsSupervisor) {
      // Cashier who is themselves a supervisor can self-approve.
      if (cashierIsSupervisor && !supervisorWorkerId) {
        setSupervisorWorkerId(meId ?? '');
      } else if (!supervisorWorkerId || !supervisorPin) {
        return setError('Supervisor approval required for amounts ≥ ₵100.');
      }
    }

    setSubmitting(true);
    const r = await counter.recordExpense({
      amountPesewas: amount,
      category: category as any,
      payee: payee.trim() || null,
      notes: notes.trim() || null,
      supervisorWorkerId: needsSupervisor ? (supervisorWorkerId || meId) : null,
      supervisorPin: needsSupervisor && !cashierIsSupervisor ? supervisorPin : null,
      photoBase64,
      photoExtension: photoExt,
    });
    setSubmitting(false);
    if (!r.success) return setError(r.error);
    onDone();
  }

  return (
    <Dialog onClose={onCancel} busy={submitting}>
      <DialogContent showCloseButton={false} className="w-[min(32rem,calc(100%-2rem))] gap-4">
        <DialogHeader>
          <DialogTitle className="text-xl">Petty cash expense</DialogTitle>
          <DialogDescription>
            Cash going OUT of the till for a non-stock purpose (water bill, transport, etc.).
            For sending cash to the safe or owner, use Cash drop instead.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">
            <Input value={amountRaw} onChange={(e) => setAmountRaw(e.target.value)}
              autoFocus placeholder="0.00" inputMode="decimal"
              className="font-mono tnum text-right" />
          </Field>
          <Field label="Category">
            <NativeSelect value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </NativeSelect>
          </Field>
        </div>

        <Field label="Paid to (optional)">
          <Input value={payee} onChange={(e) => setPayee(e.target.value)}
            placeholder="e.g. Ghana Water Company, Kwesi the runner" />
        </Field>

        {needsPhoto && (
          <Field label="Receipt photo (required for ≥ ₵50)" hint={photoBase64 ? <span className="text-success">Photo attached.</span> : undefined}>
            <input type="file" accept="image/*" onChange={onPickPhoto}
              className="w-full text-sm text-text-secondary file:mr-3 file:rounded file:border file:border-border-strong file:bg-bg-elevated file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-text-primary" />
          </Field>
        )}

        {needsSupervisor && !cashierIsSupervisor && (
          <div className="space-y-2 border-t border-border-subtle pt-3">
            <div className="text-xs font-semibold text-warning uppercase tracking-wider">Supervisor approval required (≥ ₵100)</div>
            <div className="grid grid-cols-2 gap-3">
              <NativeSelect
                aria-label="Supervisor"
                value={supervisorWorkerId}
                onChange={(e) => setSupervisorWorkerId(e.target.value)}
                onFocus={() => void ensureSupervisors()}>
                {supervisors.length === 0 && <option value="">— pick supervisor —</option>}
                {supervisors.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.role})</option>)}
              </NativeSelect>
              <Input
                aria-label="Supervisor PIN"
                type="password" inputMode="numeric" maxLength={6}
                value={supervisorPin}
                onChange={(e) => setSupervisorPin(e.target.value.replace(/\D/g, ''))}
                placeholder="supervisor PIN" />
            </div>
          </div>
        )}
        {needsSupervisor && cashierIsSupervisor && (
          <div className="text-xs text-text-tertiary border-t border-border-subtle pt-3">
            You're a supervisor — your approval is recorded automatically.
          </div>
        )}

        <Field label="Notes">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>

        {error && <FeedbackBanner>{error}</FeedbackBanner>}

        <DialogFooter>
          <Button onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={submitting || amount == null || amount <= 0}>
            {submitting ? 'Recording…' : amount != null && amount > 0 ? `Record ${formatMoney(amount)}` : 'Record expense'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
