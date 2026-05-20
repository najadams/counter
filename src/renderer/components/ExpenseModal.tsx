// ExpenseModal — record a petty cash expense paid out of the till.
// Uses the same supervisor-PIN gate pattern as cash drops + breakage.

import { useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';

const CATEGORIES: Array<{ value: string; label: string }> = [
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
    <div className="fixed inset-0 bg-scrim flex items-center justify-center p-6 z-50">
      <div className="bg-bg-elevated rounded-lg shadow-xl w-full max-w-lg p-6 space-y-4">
        <h2 className="text-xl font-semibold">Petty cash expense</h2>
        <p className="text-sm text-text-tertiary">
          Cash going OUT of the till for a non-stock purpose (water bill, transport, etc.).
          For sending cash to the safe or owner, use Cash drop instead.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Amount</span>
            <input value={amountRaw} onChange={(e) => setAmountRaw(e.target.value)}
              autoFocus placeholder="0.00"
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle font-mono tnum text-right" />
          </label>
          <label className="block">
            <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm">
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
        </div>

        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Paid to (optional)</span>
          <input value={payee} onChange={(e) => setPayee(e.target.value)}
            placeholder="e.g. Ghana Water Company, Kwesi the runner"
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
        </label>

        {needsPhoto && (
          <label className="block">
            <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">
              Receipt photo (required for ≥ ₵50)
            </span>
            <input type="file" accept="image/*" onChange={onPickPhoto}
              className="w-full text-sm text-text-secondary" />
            {photoBase64 && <div className="text-xs text-success mt-1">Photo attached.</div>}
          </label>
        )}

        {needsSupervisor && !cashierIsSupervisor && (
          <div className="space-y-2 border-t border-border-subtle pt-3">
            <div className="text-xs text-warning uppercase tracking-wider">Supervisor approval required (≥ ₵100)</div>
            <div className="grid grid-cols-2 gap-3">
              <select
                value={supervisorWorkerId}
                onChange={(e) => setSupervisorWorkerId(e.target.value)}
                onFocus={() => void ensureSupervisors()}
                className="px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm">
                {supervisors.length === 0 && <option value="">— pick supervisor —</option>}
                {supervisors.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.role})</option>)}
              </select>
              <input
                type="password" inputMode="numeric" maxLength={6}
                value={supervisorPin}
                onChange={(e) => setSupervisorPin(e.target.value.replace(/\D/g, ''))}
                placeholder="supervisor PIN"
                className="px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm" />
            </div>
          </div>
        )}
        {needsSupervisor && cashierIsSupervisor && (
          <div className="text-xs text-text-tertiary border-t border-border-subtle pt-3">
            You're a supervisor — your approval is recorded automatically.
          </div>
        )}

        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Notes</span>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm" />
        </label>

        {error && <div className="text-sm text-danger bg-danger/10 border border-danger/40 rounded px-3 py-2">{error}</div>}

        <div className="flex justify-end gap-3">
          <button onClick={onCancel} disabled={submitting}
            className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">Cancel</button>
          <button onClick={() => void submit()} disabled={submitting || amount == null || amount <= 0}
            className="px-4 py-2 bg-accent text-ink font-semibold text-sm disabled:opacity-50">
            {submitting ? 'Recording…' : amount != null && amount > 0 ? `Record ${formatMoney(amount)}` : 'Record expense'}
          </button>
        </div>
      </div>
    </div>
  );
}
