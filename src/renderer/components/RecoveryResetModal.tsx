// RecoveryResetModal — "Forgot OWNER PIN?" flow.
//
// Three-step wizard:
//   1. Pick which OWNER (only OWNERs/FOUNDERs with a recovery code set
//      appear; the others can't self-reset).
//   2. Enter the recovery code + new PIN twice.
//   3. Show the freshly-issued recovery code with a "saved this" checkbox
//      before letting the user dismiss the modal.
//
// On dismissal, the modal closes and the user signs in normally with the
// new PIN. We do NOT auto-login from this flow — we want the new PIN
// exercised through the same auth path everyone else uses.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';

interface OwnerRow { id: string; fullName: string; hasCode: boolean }

export function RecoveryResetModal({ onClose }: { onClose: () => void }) {
  const [owners, setOwners] = useState<OwnerRow[]>([]);
  const [step, setStep] = useState<'pick' | 'reset' | 'done'>('pick');
  const [workerId, setWorkerId] = useState('');
  const [code, setCode] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ fullName: string; code: string } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await counter.recoveryListOwners();
      if (!r.success) { setError(r.error); return; }
      setOwners(r.data.owners);
      const firstWithCode = r.data.owners.find((o) => o.hasCode);
      if (firstWithCode) setWorkerId(firstWithCode.id);
    })();
  }, []);

  async function submit() {
    setError(null);
    if (!workerId) return setError('Pick an owner.');
    if (!/^\d{4,6}$/.test(newPin)) return setError('New PIN must be 4–6 digits.');
    if (newPin !== confirmPin) return setError('PIN and confirmation do not match.');
    if (code.trim().length < 8) return setError('Enter your recovery code.');

    setBusy(true);
    const r = await counter.recoveryResetPin(workerId, code.trim(), newPin);
    setBusy(false);
    if (!r.success) return setError(r.error);
    setIssued({ fullName: r.data.fullName, code: r.data.newRecoveryCode });
    setStep('done');
  }

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center p-6 z-50">
      <div className="bg-bg-elevated rounded-lg shadow-xl w-full max-w-lg p-6 space-y-4">
        {step === 'pick' && (
          <>
            <h2 className="text-xl font-semibold">Forgot OWNER PIN?</h2>
            <p className="text-sm text-text-secondary">
              You can reset the PIN with the recovery code that was shown when
              the owner account was first set up. Pick the owner, then continue.
            </p>
            {owners.length === 0 ? (
              <div className="text-text-tertiary text-sm">No owner accounts found.</div>
            ) : (
              <div className="space-y-2">
                {owners.map((o) => (
                  <label key={o.id}
                    className={`flex items-center justify-between gap-3 px-4 py-3 rounded border ${
                      workerId === o.id ? 'border-accent bg-bg-deep' : 'border-border-subtle'
                    } ${o.hasCode ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
                    <div className="flex items-center gap-3">
                      <input
                        type="radio" name="owner" disabled={!o.hasCode}
                        checked={workerId === o.id}
                        onChange={() => setWorkerId(o.id)}
                      />
                      <div>
                        <div className="font-medium">{o.fullName}</div>
                        {!o.hasCode && (
                          <div className="text-xs text-text-tertiary">No recovery code on file — cannot self-reset.</div>
                        )}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            )}
            {error && <div className="text-sm text-danger bg-danger/10 border border-danger/40 rounded px-3 py-2">{error}</div>}
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={onClose} className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">Cancel</button>
              <button
                disabled={!workerId}
                onClick={() => setStep('reset')}
                className="px-4 py-2 bg-accent text-ink font-semibold text-sm disabled:opacity-50">
                Continue
              </button>
            </div>
          </>
        )}

        {step === 'reset' && (
          <>
            <h2 className="text-xl font-semibold">Enter recovery code</h2>
            <p className="text-sm text-text-secondary">
              Type the recovery code exactly as you wrote it down. Hyphens and
              case don't matter.
            </p>
            <label className="block">
              <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Recovery code</span>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                autoFocus
                className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle font-mono tracking-widest" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">New PIN</span>
                <input
                  type="password" inputMode="numeric" maxLength={6}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                  className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle font-mono tracking-widest" />
              </label>
              <label className="block">
                <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Confirm</span>
                <input
                  type="password" inputMode="numeric" maxLength={6}
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                  className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle font-mono tracking-widest" />
              </label>
            </div>
            {error && <div className="text-sm text-danger bg-danger/10 border border-danger/40 rounded px-3 py-2">{error}</div>}
            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setStep('pick')} disabled={busy}
                className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">Back</button>
              <button onClick={() => void submit()} disabled={busy}
                className="px-4 py-2 bg-accent text-ink font-semibold text-sm disabled:opacity-50">
                {busy ? 'Resetting…' : 'Reset PIN'}
              </button>
            </div>
          </>
        )}

        {step === 'done' && issued && (
          <>
            <h2 className="text-xl font-semibold">PIN reset for {issued.fullName}</h2>
            <p className="text-sm text-text-secondary">
              Your new PIN is now active. Below is a fresh recovery code — write
              it down. The old code can no longer be used.
            </p>
            <div className="bg-bg-deep border-2 border-accent rounded p-6 text-center">
              <div className="text-xs text-text-tertiary uppercase tracking-wider mb-2">
                New recovery code
              </div>
              <div className="font-mono text-2xl font-bold tracking-widest break-all">
                {issued.code}
              </div>
              <div className="text-xs text-text-tertiary mt-3">
                Shown only once. Hyphens and case are ignored when typed.
              </div>
            </div>
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)} />
              I have written this new code down somewhere safe.
            </label>
            <div className="flex justify-end pt-2">
              <button onClick={onClose} disabled={!acknowledged}
                className="px-4 py-2 bg-accent text-ink font-semibold text-sm disabled:opacity-50">
                Done — sign in with new PIN
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
