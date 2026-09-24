// Reusable supervisor PIN approval modal.
// Used by void-sale and stock-receive flows.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';

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

  // The accessible name stays "Supervisor approval" whatever the action is;
  // the title says what is being approved.
  return (
    <Dialog onClose={onCancel}>
      <DialogContent aria-label="Supervisor approval" showCloseButton={false} className="w-[min(28rem,calc(100%-2rem))] gap-5 p-8">
        <h3 className="eyebrow">{title}</h3>
        {candidates.length === 0 && (
          <div className="text-text-tertiary text-sm">
            No active supervisor accounts. Cannot approve this action.
          </div>
        )}
        {candidates.length > 0 && (
          <>
            <label className="flex flex-col gap-1.5 text-sm text-text-secondary">
              Supervisor
              <NativeSelect value={supervisorId} onChange={(e) => setSupervisorId(e.target.value)} className="h-12 text-base">
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>{c.fullName} · {c.role}</option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1.5 text-sm text-text-secondary">
              Supervisor PIN
              <Input
                type="password"
                inputMode="numeric"
                autoFocus
                value={pin}
                maxLength={6}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                className="h-14 text-2xl font-mono tnum tracking-[0.5em] text-center"
              />
            </label>
          </>
        )}
        <div className="flex gap-3 mt-2">
          <Button size="lg" onClick={onCancel}>Cancel</Button>
          <Button size="lg" variant="primary" onClick={submit} disabled={candidates.length === 0 || pin.length < 4}>Approve</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
