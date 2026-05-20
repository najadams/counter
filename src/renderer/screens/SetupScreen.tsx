// SetupScreen — first-run owner bootstrap.
//
// Shown when the database has no human workers (only the SYSTEM row).
// Creates the first OWNER, auto-logs them in, then App.tsx routes them
// into the open-shift flow.

import { useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';

export default function SetupScreen() {
  const setupCreateOwner = async (full: string, phone: string, pin: string) =>
    counter.setupCreateOwner({ fullName: full, phone, pin });

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    workerId: string; fullName: string; role: string; recoveryCode: string;
  } | null>(null);
  const [acknowledgedRecovery, setAcknowledgedRecovery] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);

    if (!fullName.trim()) return setErr('Full name is required.');
    if (!phone.trim()) return setErr('Phone number is required.');
    if (!/^\d{4,6}$/.test(pin)) return setErr('PIN must be 4–6 digits.');
    if (pin !== confirm) return setErr('PIN and confirmation do not match.');

    setBusy(true);
    const res = await setupCreateOwner(fullName.trim(), phone.trim(), pin);
    setBusy(false);

    if (!res.success) {
      setErr(res.error);
      return;
    }
    // Stash the result and show the recovery-code panel before we push the
    // session — the user must explicitly acknowledge they've saved the code.
    setCreated({
      workerId: res.data.workerId,
      fullName: res.data.fullName,
      role: res.data.role,
      recoveryCode: res.data.recoveryCode,
    });
  };

  function continueAfterRecovery() {
    if (!created) return;
    useSession.setState({
      workerId: created.workerId,
      workerName: created.fullName,
      workerRole: created.role,
      loginError: null,
      loginAttemptsRemaining: null,
      loginLockedUntil: null,
    });
  }

  if (created) {
    return (
      <div className="min-h-screen bg-bg-deep text-text-primary flex items-center justify-center p-6">
        <div className="w-full max-w-lg bg-bg-elevated rounded-lg shadow-lg p-8 space-y-5">
          <div>
            <h1 className="text-2xl font-bold mb-1">Save your recovery code</h1>
            <p className="text-sm text-text-tertiary">
              Owner account <strong>{created.fullName}</strong> is ready. Before
              you continue, write down the recovery code below. It is the
              ONLY way to reset your PIN if you forget it.
            </p>
          </div>

          <div className="bg-bg-deep border-2 border-accent rounded p-6 text-center">
            <div className="text-xs text-text-tertiary uppercase tracking-wider mb-2">
              Recovery code
            </div>
            <div className="font-mono text-3xl font-bold tracking-widest break-all">
              {created.recoveryCode}
            </div>
            <div className="text-xs text-text-tertiary mt-3">
              Hyphens and case are ignored when typed. This code is shown only once.
            </div>
          </div>

          <div className="bg-warning/10 border border-warning/40 rounded p-3 text-warning text-sm">
            <strong>Save it somewhere safe:</strong> a locked drawer, a photo
            on your phone, an envelope at home. Without it, a forgotten PIN
            means restoring the whole database from a backup.
          </div>

          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={acknowledgedRecovery}
              onChange={(e) => setAcknowledgedRecovery(e.target.checked)}
            />
            I have written this code down somewhere safe.
          </label>

          <button
            onClick={continueAfterRecovery}
            disabled={!acknowledgedRecovery}
            className="w-full py-3 rounded bg-accent text-ink font-semibold disabled:opacity-50">
            Continue to Counter
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md bg-bg-elevated rounded-lg shadow-lg p-8 space-y-5"
      >
        <div>
          <h1 className="text-2xl font-bold text-text-primary mb-1">
            Welcome to Counter
          </h1>
          <p className="text-sm text-text-tertiary">
            This is the first time the app is running. Set up the owner
            account — this is the master account that can add workers,
            change settings, and run reports.
          </p>
        </div>

        <label className="block">
          <span className="block text-sm text-text-secondary mb-1">Full name</span>
          <input
            type="text"
            autoFocus
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-text-primary"
            placeholder="e.g. Kwame Adams"
          />
        </label>

        <label className="block">
          <span className="block text-sm text-text-secondary mb-1">Phone number</span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-text-primary"
            placeholder="0244 123 456"
          />
          <span className="block text-xs text-text-tertiary mt-1">
            10-digit Ghana number. Used as the unique identifier.
          </span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">PIN (4–6 digits)</span>
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-text-primary tracking-widest"
            />
          </label>
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">Confirm PIN</span>
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))}
              className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-text-primary tracking-widest"
            />
          </label>
        </div>

        {err && (
          <div className="text-sm text-danger bg-danger/10 border border-danger/40 rounded px-3 py-2">
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full py-3 rounded bg-accent-primary text-ink font-semibold disabled:opacity-50"
        >
          {busy ? 'Creating account…' : 'Create owner account'}
        </button>

        <p className="text-xs text-text-tertiary">
          Write the PIN down somewhere safe. There is no password reset for
          the only OWNER account — if you forget it, the database has to be
          rebuilt from a backup.
        </p>
      </form>
    </div>
  );
}
