// Workers admin tab. Extracted from the old SettingsScreen.

import { useEffect, useState } from 'react';
import { PinCardsPrintScreen } from '../PinCardsPrintScreen';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog';
import { Field } from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import { NativeSelect } from '../../components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

interface AdminWorker {
  id: string; fullName: string; phone: string; role: string; active: boolean;
  hiredAt: string; terminatedAt: string | null; terminationReason: string | null;
  consumptionAllowanceUnits: number; baseSalaryPesewas: number;
}

const ROLE_OPTIONS = ['COUNTER', 'SUPERVISOR', 'STOCKMASTER', 'DRIVER', 'OWNER', 'FOUNDER'] as const;

export function WorkersTab() {
  const myWorkerId = useSession((s) => s.workerId);
  const myRole = useSession((s) => s.workerRole);
  const isAdmin = myRole === 'OWNER' || myRole === 'FOUNDER';

  const [workers, setWorkers] = useState<AdminWorker[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showPrint, setShowPrint] = useState(false);
  const [resetPinFor, setResetPinFor] = useState<AdminWorker | null>(null);
  const [terminateFor, setTerminateFor] = useState<AdminWorker | null>(null);
  const [showChangeMyPin, setShowChangeMyPin] = useState(false);
  const [regeneratedCode, setRegeneratedCode] = useState<string | null>(null);
  const [regenAck, setRegenAck] = useState(false);
  const isOwner = myRole === 'OWNER' || myRole === 'FOUNDER';

  async function regenerateRecoveryCode() {
    setError(null);
    if (!confirm('This invalidates the existing recovery code and issues a new one. Continue?')) return;
    const r = await counter.recoveryRegenerate();
    if (!r.success) { flash(r.error, 'error'); return; }
    setRegeneratedCode(r.data.newRecoveryCode);
    setRegenAck(false);
  }

  async function refresh() {
    const r = await counter.adminListWorkers();
    if (r.success) setWorkers(r.data.workers);
  }
  useEffect(() => { void refresh(); }, []);

  function flash(message: string, kind: 'info' | 'error') {
    if (kind === 'info') { setInfo(message); setError(null); setTimeout(() => setInfo(null), 4000); }
    else { setError(message); setInfo(null); }
  }

  async function deactivate(id: string) {
    const r = await counter.deactivateWorker(id);
    if (!r.success) flash(r.error, 'error');
    else { flash('Worker deactivated.', 'info'); await refresh(); }
  }
  async function reactivate(id: string) {
    const r = await counter.reactivateWorker(id);
    if (!r.success) flash(r.error, 'error');
    else { flash('Worker reactivated.', 'info'); await refresh(); }
  }

  if (showPrint) {
    return <PinCardsPrintScreen onExit={() => setShowPrint(false)} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-3">
        <Button onClick={() => setShowChangeMyPin(true)}>
          Change my PIN
        </Button>
        {isOwner && (
          <Button onClick={() => void regenerateRecoveryCode()}>
            Regenerate recovery code
          </Button>
        )}
        <Button
          onClick={() => isAdmin && setShowPrint(true)}
          disabled={!isAdmin}
          title={isAdmin ? '' : 'OWNER or FOUNDER role required'}>
          Print PIN cards
        </Button>
        <Button variant="primary"
          onClick={() => isAdmin && setShowAdd(true)}
          disabled={!isAdmin}
          title={isAdmin ? '' : 'OWNER or FOUNDER role required to add workers'}>
          + Add worker
        </Button>
      </div>

      {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}
      {error && <FeedbackBanner>{error}</FeedbackBanner>}

      <div className="panel overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">Salary</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="text-sm">
            {workers.map((w) => (
              <TableRow key={w.id}>
                <TableCell className="px-4 py-3">
                  {w.fullName}
                  {w.id === myWorkerId && <span className="text-accent text-xs ml-2">you</span>}
                </TableCell>
                <TableCell className="px-4 py-3 font-mono tnum">{w.phone}</TableCell>
                <TableCell className="px-4 py-3">{w.role}</TableCell>
                <TableCell className="px-4 py-3 text-right font-mono tnum">{formatMoneyWithCurrency(w.baseSalaryPesewas)}</TableCell>
                <TableCell className="px-4 py-3">
                  {w.terminatedAt
                    ? <span className="text-text-tertiary">terminated {w.terminatedAt}</span>
                    : w.active
                      ? <span className="text-success">active</span>
                      : <span className="text-warning">inactive</span>}
                </TableCell>
                <TableCell className="px-4 py-3 text-right space-x-2">
                  {w.id === myWorkerId ? (
                    <span className="text-text-tertiary text-xs">—</span>
                  ) : isAdmin ? (
                    <>
                      {!w.terminatedAt && w.active && (
                        <Button variant="link" className="text-text-tertiary hover:text-warning no-underline hover:underline text-xs" onClick={() => deactivate(w.id)}>deactivate</Button>
                      )}
                      {!w.terminatedAt && !w.active && (
                        <Button variant="link" className="text-text-tertiary hover:text-success no-underline hover:underline text-xs" onClick={() => reactivate(w.id)}>reactivate</Button>
                      )}
                      <Button variant="link" className="text-text-tertiary hover:text-accent no-underline hover:underline text-xs" onClick={() => setResetPinFor(w)}>reset PIN</Button>
                      {!w.terminatedAt && (
                        <Button variant="link" className="text-text-tertiary hover:text-danger no-underline hover:underline text-xs" onClick={() => setTerminateFor(w)}>terminate</Button>
                      )}
                    </>
                  ) : (
                    <span className="text-text-tertiary text-xs">admin only</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {workers.length === 0 && (
              <TableRow><TableCell colSpan={6} className="px-4 py-6 text-text-tertiary text-center">No workers.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {showAdd && (
        <AddWorkerModal
          onCancel={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); flash('Worker added.', 'info'); void refresh(); }}
          onError={(e) => flash(e, 'error')}
        />
      )}
      {resetPinFor && (
        <ResetPinModal
          worker={resetPinFor}
          onCancel={() => setResetPinFor(null)}
          onDone={() => { setResetPinFor(null); flash('PIN reset.', 'info'); void refresh(); }}
          onError={(e) => flash(e, 'error')}
        />
      )}
      {terminateFor && (
        <TerminateModal
          worker={terminateFor}
          onCancel={() => setTerminateFor(null)}
          onDone={() => { setTerminateFor(null); flash('Worker terminated.', 'info'); void refresh(); }}
          onError={(e) => flash(e, 'error')}
        />
      )}
      {showChangeMyPin && (
        <ChangeMyPinModal
          onCancel={() => setShowChangeMyPin(false)}
          onDone={() => { setShowChangeMyPin(false); flash('Your PIN was updated.', 'info'); }}
          onError={(e) => flash(e, 'error')}
        />
      )}
      {regeneratedCode && (
        // Shown once: nothing but "Done" (after the tick) closes it.
        <Dialog disablePointerDismissal>
          <DialogContent showCloseButton={false} className="w-[min(32rem,calc(100%-2rem))] gap-4">
            <DialogTitle className="text-xl">New recovery code</DialogTitle>
            <p className="text-sm text-text-secondary">
              The previous recovery code has been invalidated. Write the new code
              below somewhere safe — this is the only time it will be shown.
            </p>
            <div className="bg-bg-surface border-2 border-accent rounded-xl p-6 text-center">
              <div className="text-xs text-text-tertiary uppercase tracking-wider mb-2">Recovery code</div>
              <div className="font-mono text-2xl font-bold tracking-widest break-all">{regeneratedCode}</div>
              <div className="text-xs text-text-tertiary mt-3">
                Hyphens and case are ignored when typed.
              </div>
            </div>
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" className="size-4 accent-accent" checked={regenAck} onChange={(e) => setRegenAck(e.target.checked)} />
              I have written this new code down somewhere safe.
            </label>
            <div className="flex justify-end gap-3 pt-2">
              <Button
                variant="primary"
                disabled={!regenAck}
                onClick={() => { setRegeneratedCode(null); setRegenAck(false); flash('Recovery code regenerated.', 'info'); }}>
                Done
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function AddWorkerModal({ onCancel, onAdded, onError }: { onCancel: () => void; onAdded: () => void; onError: (e: string) => void }) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<typeof ROLE_OPTIONS[number]>('COUNTER');
  const [pin, setPin] = useState('');
  const [salary, setSalary] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setSubmitting(true);
    const salaryPesewas = salary ? Number(salary.replace(/\D/g, '')) : 0;
    const r = await counter.addWorker({
      fullName: fullName.trim(), phone: phone.trim(),
      role, pin, baseSalaryPesewas: salaryPesewas,
    });
    setSubmitting(false);
    if (!r.success) { onError(r.error); return; }
    if (r.data.workerId) onAdded();
  }

  return (
    <Dialog onClose={onCancel} busy={submitting}>
      <DialogContent showCloseButton={false} className="w-[min(28rem,calc(100%-2rem))] gap-4 p-8">
        <DialogTitle className="text-xl">Add worker</DialogTitle>
        <Field label="Full name">
          <Input autoFocus value={fullName} onChange={(e) => setFullName(e.target.value)} className="h-11" />
        </Field>
        <Field label="Phone">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. 0555547998" className="h-11 font-mono" />
        </Field>
        <Field label="Role">
          <NativeSelect value={role} onChange={(e) => setRole(e.target.value as typeof ROLE_OPTIONS[number])} className="h-11">
            {ROLE_OPTIONS.map((r) => <option key={r}>{r}</option>)}
          </NativeSelect>
        </Field>
        <Field label="PIN (4-6 digits)">
          <Input type="password" inputMode="numeric" value={pin} maxLength={6}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            className="h-11 font-mono tnum tracking-[0.5em] text-center" />
        </Field>
        <Field label="Monthly salary (pesewas)" hint="e.g. 150000 = GHS 1500">
          <Input value={salary} onChange={(e) => setSalary(e.target.value.replace(/\D/g, ''))}
            inputMode="numeric" className="h-11 font-mono tnum" />
        </Field>
        <div className="flex gap-3 mt-2">
          <Button size="lg" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button size="lg" variant="primary" onClick={() => void submit()} disabled={submitting || pin.length < 4 || !fullName.trim()}>
            {submitting ? 'Adding…' : 'Add worker'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResetPinModal({ worker, onCancel, onDone, onError }: { worker: AdminWorker; onCancel: () => void; onDone: () => void; onError: (e: string) => void }) {
  const [pin, setPin] = useState('');
  async function submit() {
    const r = await counter.resetPin(worker.id, pin);
    if (!r.success) onError(r.error); else onDone();
  }
  return (
    <Dialog onClose={onCancel}>
      <DialogContent showCloseButton={false} className="w-[min(28rem,calc(100%-2rem))] gap-4 p-8">
        <DialogTitle className="text-xl">Reset PIN — {worker.fullName}</DialogTitle>
        <Field label="New PIN (4-6 digits)" hint="All active lockouts on this worker will be cleared.">
          <Input autoFocus type="password" inputMode="numeric" value={pin} maxLength={6}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            className="h-12 font-mono tnum tracking-[0.5em] text-center" />
        </Field>
        <div className="flex gap-3">
          <Button size="lg" onClick={onCancel}>Cancel</Button>
          <Button size="lg" variant="primary" onClick={() => void submit()} disabled={pin.length < 4}>Reset</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TerminateModal({ worker, onCancel, onDone, onError }: { worker: AdminWorker; onCancel: () => void; onDone: () => void; onError: (e: string) => void }) {
  const [reason, setReason] = useState('');
  async function submit() {
    const r = await counter.terminateWorker(worker.id, reason.trim());
    if (!r.success) onError(r.error); else onDone();
  }
  return (
    <Dialog onClose={onCancel}>
      <DialogContent showCloseButton={false} className="w-[min(28rem,calc(100%-2rem))] gap-4 p-8">
        <DialogHeader>
          <DialogTitle className="text-xl">Terminate — {worker.fullName}</DialogTitle>
          <DialogDescription>
            This is permanent. The worker stays in the database with all historical attribution intact, but cannot log in again.
          </DialogDescription>
        </DialogHeader>
        <Field label="Reason">
          <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. resigned, fired for theft" className="h-11" />
        </Field>
        <div className="flex gap-3">
          <Button size="lg" onClick={onCancel}>Cancel</Button>
          <Button size="lg" variant="destructive" onClick={() => void submit()} disabled={reason.trim().length < 3}>Terminate</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ChangeMyPinModal({ onCancel, onDone, onError }: { onCancel: () => void; onDone: () => void; onError: (e: string) => void }) {
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  async function submit() {
    const r = await counter.changePin(oldPin, newPin);
    if (!r.success) onError(r.error); else onDone();
  }
  return (
    <Dialog onClose={onCancel}>
      <DialogContent showCloseButton={false} className="w-[min(28rem,calc(100%-2rem))] gap-4 p-8">
        <DialogTitle className="text-xl">Change my PIN</DialogTitle>
        <Field label="Old PIN">
          <Input autoFocus type="password" inputMode="numeric" value={oldPin} maxLength={6}
            onChange={(e) => setOldPin(e.target.value.replace(/\D/g, ''))}
            className="h-12 font-mono tnum tracking-[0.5em] text-center" />
        </Field>
        <Field label="New PIN (4-6 digits)">
          <Input type="password" inputMode="numeric" value={newPin} maxLength={6}
            onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
            className="h-12 font-mono tnum tracking-[0.5em] text-center" />
        </Field>
        <div className="flex gap-3">
          <Button size="lg" onClick={onCancel}>Cancel</Button>
          <Button size="lg" variant="primary" onClick={() => void submit()} disabled={oldPin.length < 4 || newPin.length < 4}>Update</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
