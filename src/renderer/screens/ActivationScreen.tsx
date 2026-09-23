// ActivationScreen — first-run licence gate.
//
// Shown when no activation key is on file. Keys are machine-bound, so
// onboarding is two-step and this screen has to serve both halves:
//   1. show the MACHINE CODE the shop sends to the vendor, and
//   2. take the pasted key that comes back.
//
// The key is ~150 characters (an Ed25519 signature can't be shorter), so the
// input is a textarea and the handler tolerates dashes, newlines and case.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { FeedbackBanner } from '../components/FeedbackBanner';

export default function ActivationScreen({
  onActivated,
  mode = 'first-run',
  onCancel,
}: {
  onActivated: () => void;
  /** 'reactivate' is reached from the mismatch banner on an install that is
   *  already running — it must be escapable, because read-only deliberately
   *  leaves reports and shift close available. */
  mode?: 'first-run' | 'reactivate';
  onCancel?: () => void;
}) {
  const [machineCode, setMachineCode] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await counter.activationStatus();
      if (res.success) setMachineCode(res.data.machineCode);
      else setErr(res.error);
    })();
  }, []);

  async function copyMachineCode() {
    if (!machineCode) return;
    try {
      await navigator.clipboard.writeText(machineCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked; the code is on screen to read out anyway.
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!key.trim()) return setErr('Paste the activation key you were sent.');

    setBusy(true);
    const res = await counter.activationActivate(key.trim());
    setBusy(false);

    if (!res.success) return setErr(res.error);
    if (!res.data.ok) return setErr(res.data.message ?? 'That key was not accepted.');
    onActivated();
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex items-center justify-center p-6">
      <div className="w-full max-w-xl bg-bg-elevated rounded-lg shadow-lg p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-bold mb-1">
            {mode === 'reactivate' ? 'Enter a new activation key' : 'Activate Counter'}
          </h1>
          <p className="text-sm text-text-tertiary">
            {mode === 'reactivate'
              ? 'The key on file was issued for a different PC. Send the machine code below to your supplier and paste the replacement key here.'
              : 'This copy of Counter needs a one-time activation key. The key is tied to this PC, so it only has to be done once — not every time you open the app.'}
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-xs text-text-tertiary uppercase tracking-wider">
            Step 1 — send this machine code to your supplier
          </div>
          <div className="bg-bg-deep border-2 border-accent rounded p-5 text-center">
            <div className="font-mono text-2xl font-bold tracking-widest break-all">
              {machineCode ?? '····-····-····-····'}
            </div>
          </div>
          <button
            type="button"
            onClick={() => void copyMachineCode()}
            disabled={!machineCode}
            className="text-xs text-accent hover:underline disabled:opacity-50"
          >
            {copied ? 'Copied' : 'Copy machine code'}
          </button>
          <p className="text-xs text-text-tertiary">
            Send it by WhatsApp or SMS. It identifies this PC only — it contains
            no sales, customer or worker information.
          </p>
        </div>

        <form onSubmit={(e) => void submit(e)} className="space-y-2">
          <div className="text-xs text-text-tertiary uppercase tracking-wider">
            Step 2 — paste the key you get back
          </div>
          <textarea
            value={key}
            onChange={(e) => setKey(e.target.value)}
            rows={5}
            autoFocus
            spellCheck={false}
            placeholder="XXXXX-XXXXX-XXXXX-…"
            className="w-full bg-bg-deep border border-border-strong rounded p-3 font-mono text-xs
                       tracking-wide resize-none focus:outline-hidden focus:border-accent"
          />
          <p className="text-xs text-text-tertiary">
            Paste the whole thing. Dashes, line breaks and capitals don&apos;t matter.
          </p>

          {err && <FeedbackBanner tone="error">{err}</FeedbackBanner>}

          <button
            type="submit"
            disabled={busy || !key.trim()}
            className="w-full bg-accent text-bg-deep font-bold rounded py-3 mt-2
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? 'Checking…' : mode === 'reactivate' ? 'Re-activate' : 'Activate'}
          </button>

          {mode === 'reactivate' && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="w-full text-xs text-text-tertiary underline py-2"
            >
              Back — shift close, reports and export still work
            </button>
          )}
        </form>

        <p className="text-xs text-text-tertiary border-t border-border-strong pt-4">
          Lost your key, or replaced this PC? Send the machine code above to your
          supplier and ask for a replacement — the old key stops working on the
          new machine.
        </p>
      </div>
    </div>
  );
}
