// CashDropModal: enter amount + recipient, then supervisor PIN.
// Shown over HomeScreen on F2.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { SupervisorPinModal } from './SupervisorPinModal';
import { formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';

const COMMON_RECIPIENTS = ['Owner', 'Bank deposit', 'Supplier payment', 'Other'];

export function CashDropModal({ shiftId, onClose, onDone }: {
  shiftId: string; onClose: () => void; onDone: () => void;
}) {
  const [expected, setExpected] = useState<number | null>(null);
  const [amount, setAmount] = useState('');
  const [recipient, setRecipient] = useState(COMMON_RECIPIENTS[0]!);
  const [customRecipient, setCustomRecipient] = useState('');
  const [notes, setNotes] = useState('');
  const [askingSupervisor, setAskingSupervisor] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await counter.getExpectedCash(shiftId);
      if (r.success) setExpected(r.data.expectedCashPesewas);
    })();
  }, [shiftId]);

  const amountPesewas = parseCedisToPesewas(amount);
  const finalRecipient = recipient === 'Other' ? customRecipient.trim() : recipient;
  const valid = amountPesewas !== null && amountPesewas > 0 && finalRecipient.length > 0
    && (expected === null || amountPesewas <= expected);

  async function approve(supervisorWorkerId: string, supervisorPin: string) {
    if (!amountPesewas) return;
    setError(null);
    const r = await counter.recordCashDrop({
      shiftId, amountPesewas, recipient: finalRecipient,
      notes: notes.trim() || null,
      supervisorWorkerId, supervisorPin,
    });
    setAskingSupervisor(false);
    if (!r.success) { setError(r.error); return; }
    onDone();
  }

  return (
    <>
      <div className="fixed inset-0 bg-scrim flex items-center justify-center z-50" onClick={onClose}>
        <div className="bg-bg-surface border border-border w-full max-w-md p-8 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-text-secondary uppercase tracking-wider text-xs">Cash drop</h3>
          {expected !== null && (
            <div className="text-text-tertiary text-sm">
              Current expected cash: <span className="font-mono tnum text-text-primary">{formatMoneyWithCurrency(expected)}</span>
            </div>
          )}
          <label className="text-text-secondary text-xs uppercase tracking-wider">Amount (cedis)</label>
          <input autoFocus value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            className="bg-bg-input border border-border-strong px-4 py-3 text-2xl font-mono tnum text-right" />
          {amountPesewas !== null && expected !== null && amountPesewas > expected && (
            <div className="text-danger text-xs">
              Exceeds expected cash by {formatMoneyWithCurrency(amountPesewas - expected)}.
            </div>
          )}
          <label className="text-text-secondary text-xs uppercase tracking-wider">Recipient</label>
          <select value={recipient} onChange={(e) => setRecipient(e.target.value)}
            className="bg-bg-input border border-border-strong px-3 py-3 text-text-primary">
            {COMMON_RECIPIENTS.map((r) => <option key={r}>{r}</option>)}
          </select>
          {recipient === 'Other' && (
            <input value={customRecipient} onChange={(e) => setCustomRecipient(e.target.value)}
              placeholder="Who?" className="bg-bg-input border border-border-strong px-3 py-2" />
          )}
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)" className="bg-bg-input border border-border-strong px-3 py-2 text-sm" rows={2} />
          {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}
          <div className="flex gap-3">
            <button onClick={onClose} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
            <button onClick={() => setAskingSupervisor(true)} disabled={!valid}
              className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed">
              Get supervisor approval
            </button>
          </div>
        </div>
      </div>
      {askingSupervisor && (
        <SupervisorPinModal
          title={`Approve cash drop of ${amountPesewas != null ? formatMoneyWithCurrency(amountPesewas) : ''} to ${finalRecipient}`}
          onCancel={() => setAskingSupervisor(false)}
          onApprove={approve}
        />
      )}
    </>
  );
}
