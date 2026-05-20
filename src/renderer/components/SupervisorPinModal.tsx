// Reusable supervisor PIN approval modal.
// Used by void-sale and stock-receive flows.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';

interface SupervisorOption { id: string; fullName: string; role: string }

export function SupervisorPinModal({
  title,
  onCancel,
  onApprove,
}: {
  title: string;
  onCancel: () => void;
  onApprove: (supervisorWorkerId: string, supervisorPin: string) => void;
}) {
  const [candidates, setCandidates] = useState<SupervisorOption[]>([]);
  const [supervisorId, setSupervisorId] = useState<string>('');
  const [pin, setPin] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await counter.listLoginCandidates();
      if (cancelled || !r.success) return;
      const sups = r.data.workers.filter((w) =>
        w.role === 'SUPERVISOR' || w.role === 'OWNER' || w.role === 'FOUNDER',
      );
      setCandidates(sups);
      if (sups[0]) setSupervisorId(sups[0].id);
    })();
    return () => { cancelled = true; };
  }, []);

  function submit() {
    if (!supervisorId || pin.length < 4) return;
    onApprove(supervisorId, pin);
  }

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-bg-surface border border-border w-full max-w-md p-8 flex flex-col gap-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h3>
        {candidates.length === 0 && (
          <div className="text-text-tertiary text-sm">
            No active supervisor accounts. Cannot approve this action.
          </div>
        )}
        {candidates.length > 0 && (
          <>
            <label className="text-text-secondary text-xs uppercase tracking-wider">Supervisor</label>
            <select
              value={supervisorId}
              onChange={(e) => setSupervisorId(e.target.value)}
              className="bg-bg-input border border-border-strong px-4 py-3 text-text-primary"
            >
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>{c.fullName} · {c.role}</option>
              ))}
            </select>
            <label className="text-text-secondary text-xs uppercase tracking-wider">Supervisor PIN</label>
            <input
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              maxLength={6}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              className="bg-bg-input border border-border-strong px-4 py-3 text-2xl font-mono tnum tracking-[0.5em] text-center"
            />
          </>
        )}
        <div className="flex gap-3 mt-2">
          <button onClick={onCancel} className="px-5 py-3 border border-border text-text-primary hover:bg-bg-elevated">Cancel</button>
          <button
            onClick={submit}
            disabled={candidates.length === 0 || pin.length < 4}
            className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed"
          >Approve</button>
        </div>
      </div>
    </div>
  );
}
