// ReprintQueueTab — list of sales whose receipt failed to print.
// Retry calls into the printer adapter; on success the row is resolved.
// Discard is supervisor-allowed when the receipt is no longer needed.

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';

interface Reprint {
  id: string; saleId: string; reason: string;
  saleTotalPesewas: number; saleCreatedAt: string;
  saleWorkerName: string; ageHours: number; createdAt: string;
}

export function ReprintQueueTab() {
  const myRole = useSession((s) => s.workerRole);
  const isQueueRole = myRole === 'SUPERVISOR' || myRole === 'OWNER' || myRole === 'FOUNDER';

  const [reprints, setReprints] = useState<Reprint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<Reprint | null>(null);

  async function refresh() {
    if (!isQueueRole) return;
    setLoading(true); setError(null);
    const r = await counter.listPendingReprints();
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setReprints(r.data.reprints);
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line */ }, []);

  function flash(msg: string, kind: 'info' | 'error') {
    if (kind === 'info') { setInfo(msg); setError(null); setTimeout(() => setInfo(null), 4000); }
    else { setError(msg); setInfo(null); }
  }

  async function retry(r: Reprint) {
    setError(null);
    const res = await counter.retryReprint({ reprintId: r.id });
    if (!res.success) return flash(res.error, 'error');
    if (res.data.printed) {
      flash(`Reprinted sale ${r.saleId.slice(-6)}.`, 'info');
      await refresh();
    } else {
      flash(`Print failed: ${res.data.error ?? 'unknown'}`, 'error');
    }
  }

  if (!isQueueRole) {
    return (
      <div className="bg-bg-elevated border border-border-subtle p-6 rounded text-text-tertiary">
        Reprint queue is restricted to SUPERVISOR, OWNER, and FOUNDER roles.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="text-text-secondary text-sm">
          {reprints.length} pending {reprints.length === 1 ? 'receipt' : 'receipts'}
        </div>
        <button onClick={() => void refresh()}
          className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">
          Refresh
        </button>
      </div>

      {error && <div className="bg-red-950/30 border border-red-900/50 text-red-300 text-sm px-3 py-2 rounded">{error}</div>}
      {info && <div className="bg-emerald-950/30 border border-emerald-900/50 text-emerald-300 text-sm px-3 py-2 rounded">{info}</div>}

      <div className="bg-bg-elevated rounded border border-border-subtle overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-deep text-text-tertiary uppercase text-xs">
            <tr>
              <th className="text-left px-3 py-2">Sale</th>
              <th className="text-left px-3 py-2">Cashier</th>
              <th className="text-right px-3 py-2">Total</th>
              <th className="text-left px-3 py-2">Reason</th>
              <th className="text-left px-3 py-2">Age</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-text-tertiary">Loading…</td></tr>
            )}
            {!loading && reprints.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-text-tertiary">
                Queue is empty. All receipts printed cleanly.
              </td></tr>
            )}
            {reprints.map((r) => (
              <tr key={r.id} className="border-t border-border-subtle hover:bg-bg-deep/40">
                <td className="px-3 py-2 font-mono text-xs">
                  {r.saleId.slice(-8)}
                  <div className="text-text-tertiary">{new Date(r.saleCreatedAt).toLocaleString()}</div>
                </td>
                <td className="px-3 py-2">{r.saleWorkerName}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoneyWithCurrency(r.saleTotalPesewas)}</td>
                <td className="px-3 py-2 text-text-secondary">{r.reason}</td>
                <td className="px-3 py-2 text-text-tertiary">{formatAge(r.ageHours)}</td>
                <td className="px-3 py-2 text-right">
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => void retry(r)}
                      className="text-xs px-3 py-1 bg-accent text-bg-deep font-semibold hover:bg-accent-light">
                      Print now
                    </button>
                    <button onClick={() => setDiscarding(r)}
                      className="text-xs px-3 py-1 border border-border hover:bg-bg-elevated text-red-400">
                      Discard
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {discarding && (
        <DiscardModal
          reprint={discarding}
          onCancel={() => setDiscarding(null)}
          onDone={async (msg) => { setDiscarding(null); flash(msg, 'info'); await refresh(); }}
        />
      )}
    </div>
  );
}

function DiscardModal({ reprint, onCancel, onDone }: {
  reprint: Reprint; onCancel: () => void; onDone: (msg: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!reason.trim()) return setErr('Reason required.');
    setBusy(true);
    const r = await counter.discardReprint({ reprintId: reprint.id, reason: reason.trim() });
    setBusy(false);
    if (!r.success) return setErr(r.error);
    onDone('Receipt discarded.');
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-elevated rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
        <h2 className="text-lg font-semibold">Discard pending receipt</h2>
        <p className="text-sm text-text-secondary">
          Sale <span className="font-mono">{reprint.saleId.slice(-8)}</span> · {formatMoneyWithCurrency(reprint.saleTotalPesewas)} · {reprint.saleWorkerName}
        </p>
        <p className="text-sm text-text-tertiary">
          Discarding removes this from the queue without printing. The sale itself is unaffected. Use this when the customer has already left and the receipt is no longer needed.
        </p>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Reason</span>
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="customer left, paper out for hours, etc."
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle" />
        </label>
        {err && <div className="text-sm text-red-400 bg-red-950/30 border border-red-900/50 rounded px-3 py-2">{err}</div>}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onCancel} disabled={busy}
            className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">Cancel</button>
          <button type="button" onClick={() => void submit()} disabled={busy}
            className="px-4 py-2 bg-red-600 text-white font-semibold hover:bg-red-500 text-sm disabled:opacity-50">
            {busy ? 'Discarding…' : 'Discard'}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 24) return `${Math.round(hours)} h`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}
