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
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';

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

  // The fresh code is shown once: until it is acknowledged, nothing but
  // "Done" closes this.
  const locked = step === 'done' && !acknowledged;
  return (
    <Dialog onClose={locked ? undefined : onClose} busy={busy} disablePointerDismissal={step === 'done'}>
      <DialogContent showCloseButton={false} className="w-[min(32rem,calc(100%-2rem))] gap-4">
        {step === 'pick' && (
          <>
            <DialogTitle className="text-xl">Forgot OWNER PIN?</DialogTitle>
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
                    className={`flex items-center justify-between gap-3 px-4 py-3 rounded-lg border ${
                      workerId === o.id ? 'border-accent bg-accent/8' : 'border-border'
                    } ${o.hasCode ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}>
                    <div className="flex items-center gap-3">
                      <input
                        type="radio" name="owner" disabled={!o.hasCode} className="size-4 accent-accent"
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
            {error && <FeedbackBanner>{error}</FeedbackBanner>}
            <div className="flex justify-end gap-3 pt-2">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="primary" disabled={!workerId} onClick={() => setStep('reset')}>Continue</Button>
            </div>
          </>
        )}

        {step === 'reset' && (
          <>
            <DialogTitle className="text-xl">Enter recovery code</DialogTitle>
            <p className="text-sm text-text-secondary">
              Type the recovery code exactly as you wrote it down. Hyphens and
              case don't matter.
            </p>
            <Field label="Recovery code">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="XXXX-XXXX-XXXX-XXXX"
                autoFocus
                className="font-mono tracking-widest" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="New PIN">
                <Input
                  type="password" inputMode="numeric" maxLength={6}
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                  className="font-mono tracking-widest" />
              </Field>
              <Field label="Confirm">
                <Input
                  type="password" inputMode="numeric" maxLength={6}
                  value={confirmPin}
                  onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                  className="font-mono tracking-widest" />
              </Field>
            </div>
            {error && <FeedbackBanner>{error}</FeedbackBanner>}
            <div className="flex justify-end gap-3 pt-2">
              <Button onClick={() => setStep('pick')} disabled={busy}>Back</Button>
              <Button variant="primary" onClick={() => void submit()} disabled={busy}>
                {busy ? 'Resetting…' : 'Reset PIN'}
              </Button>
            </div>
          </>
        )}

        {step === 'done' && issued && (
          <>
            <DialogTitle className="text-xl">PIN reset for {issued.fullName}</DialogTitle>
            <p className="text-sm text-text-secondary">
              Your new PIN is now active. Below is a fresh recovery code — write
              it down. The old code can no longer be used.
            </p>
            <div className="bg-bg-surface border-2 border-accent rounded-xl p-6 text-center">
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
              <input type="checkbox" className="size-4 accent-accent" checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)} />
              I have written this new code down somewhere safe.
            </label>
            <div className="flex justify-end pt-2">
              <Button variant="primary" onClick={onClose} disabled={!acknowledged}>
                Done — sign in with new PIN
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
