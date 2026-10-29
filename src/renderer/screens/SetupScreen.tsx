// SetupScreen — first-run owner bootstrap.
//
// Shown when the database has no human workers (only the SYSTEM row).
// Creates the first OWNER, auto-logs them in, shows the recovery code, then
// offers to start the shop's books with the money it opens with — a new shop
// has nothing to reconcile, so its reports can be real from the first sale.
// Then App.tsx routes them into the open-shift flow.

import { useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { usePaymentSettings } from '../store/paymentSettings';
import { parseCedisToPesewas } from '../../shared/lib/money';
import type { SetupBooksOptionsResponse } from '../../shared/types/ipc';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import { Input } from '../components/ui/input';

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
  const [books, setBooks] = useState<SetupBooksOptionsResponse | null>(null);
  const [bankInUse, setBankInUse] = useState(true);
  const [money, setMoney] = useState<Record<string, string>>({});
  const [booksErr, setBooksErr] = useState<string | null>(null);

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

  async function continueAfterRecovery() {
    if (!created) return;
    setBusy(true);
    const options = await counter.setupBooksOptions().catch(() => null);
    setBusy(false);
    if (options?.success && options.data.canStart) {
      setBankInUse(options.data.bankInUse);
      setBooks(options.data);
      return;
    }
    enterCounter();
  }

  const startingAccounts = (books?.accounts ?? []).filter((account) => bankInUse || account.kind !== 'BANK');

  async function startBooks() {
    setBooksErr(null);
    const startingMoney = [];
    for (const account of startingAccounts) {
      const raw = (money[account.id] ?? '').trim();
      if (!raw) continue;
      const amountPesewas = parseCedisToPesewas(raw);
      if (amountPesewas == null) return setBooksErr(`Enter ${account.name} in cedis, like 250.00.`);
      startingMoney.push({ financialAccountId: account.id, amountPesewas });
    }
    setBusy(true);
    const res = await counter.setupStartBooks({ bankInUse, startingMoney });
    setBusy(false);
    if (!res.success) return setBooksErr(res.error);
    usePaymentSettings.setState({ bankInUse, loaded: true });
    enterCounter();
  }

  function enterCounter() {
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

  if (created && books) {
    return (
      <div className="min-h-screen bg-bg-deep text-text-primary flex items-center justify-center p-6">
        <div className="w-full max-w-lg bg-bg-elevated rounded-lg shadow-lg p-8 space-y-5">
          <div>
            <h1 className="text-2xl font-bold mb-1">Start the shop's books</h1>
            <p className="text-sm text-text-tertiary">
              Counter keeps the shop's books from today, so profit and cash are real figures from
              the first sale. Count the money the shop starts with. Leave a place blank if it is
              empty. Stock comes in later, through Receive stock → Opening stock.
            </p>
          </div>

          <label className="flex items-start gap-3 text-sm">
            <Checkbox className="mt-0.5" checked={bankInUse}
              onCheckedChange={(checked) => setBankInUse(checked === true)} />
            <span>This shop pays and gets paid through a bank
              <small className="block text-xs text-text-secondary">
                Turn this off if the shop only uses cash and MoMo. You can change it later in Settings → Payments.
              </small>
            </span>
          </label>

          <div className="grid grid-cols-2 gap-3">
            {startingAccounts.map((account) => (
              <label key={account.id} className="block">
                <span className="block text-sm text-text-secondary mb-1">{account.name}</span>
                <Input className="font-mono" inputMode="decimal" placeholder="GH¢ 0.00"
                  value={money[account.id] ?? ''}
                  onChange={(e) => setMoney((current) => ({ ...current, [account.id]: e.target.value }))} />
              </label>
            ))}
          </div>

          {booksErr && <FeedbackBanner>{booksErr}</FeedbackBanner>}

          <Button variant="primary" size="lg" className="w-full" disabled={busy}
            onClick={() => void startBooks()}>
            {busy ? 'Starting…' : 'Start the books'}
          </Button>
          <Button className="w-full" disabled={busy} onClick={enterCounter}>
            Not now
          </Button>
          <p className="text-xs text-text-tertiary">
            If you skip this, start them later from Reports → Owner Summary. Once the shop has sold
            something, that also needs a sealed day and a stocktake.
          </p>
        </div>
      </div>
    );
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

          <Button variant="primary" size="lg" className="w-full"
            onClick={() => void continueAfterRecovery()}
            disabled={!acknowledgedRecovery || busy}>
            Continue
          </Button>
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
          <Input
            type="text"
            autoFocus
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
           
            placeholder="e.g. Kwame Adams" />
        </label>

        <label className="block">
          <span className="block text-sm text-text-secondary mb-1">Phone number</span>
          <Input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
           
            placeholder="0244 123 456" />
          <span className="block text-xs text-text-tertiary mt-1">
            10-digit Ghana number. Used as the unique identifier.
          </span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">PIN (4–6 digits)</span>
            <Input className="tracking-widest"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label className="block">
            <span className="block text-sm text-text-secondary mb-1">Confirm PIN</span>
            <Input className="tracking-widest"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ''))} />
          </label>
        </div>

        {err && (
          <FeedbackBanner>
            {err}
          </FeedbackBanner>
        )}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={busy}
          className="w-full"
        >
          {busy ? 'Creating account…' : 'Create owner account'}
        </Button>

        <p className="text-xs text-text-tertiary">
          Write the PIN down somewhere safe. There is no password reset for
          the only OWNER account — if you forget it, the database has to be
          rebuilt from a backup.
        </p>
      </form>
    </div>
  );
}
