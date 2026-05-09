// Workers admin tab. Extracted from the old SettingsScreen.

import { useEffect, useState } from 'react';
import { PinCardsPrintScreen } from '../PinCardsPrintScreen';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';

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
        <button onClick={() => setShowChangeMyPin(true)}
          className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
          Change my PIN
        </button>
        {isOwner && (
          <button onClick={() => void regenerateRecoveryCode()}
            className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
            Regenerate recovery code
          </button>
        )}
        <button
          onClick={() => isAdmin && setShowPrint(true)}
          disabled={!isAdmin}
          title={isAdmin ? '' : 'OWNER or FOUNDER role required'}
          className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm disabled:opacity-40 disabled:cursor-not-allowed">
          Print PIN cards
        </button>
        <button
          onClick={() => isAdmin && setShowAdd(true)}
          disabled={!isAdmin}
          title={isAdmin ? '' : 'OWNER or FOUNDER role required to add workers'}
          className="bg-accent text-bg-deep px-4 py-2 font-semibold hover:bg-accent-light text-sm disabled:opacity-40 disabled:cursor-not-allowed">
          + Add worker
        </button>
      </div>

      {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}
      {error && <div className="bg-bg-surface border border-danger px-5 py-3 text-danger text-sm">{error}</div>}

      <div className="bg-bg-surface border border-border overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="text-text-secondary text-xs uppercase tracking-wider">
              <th className="px-4 py-3 text-left">Name</th>
              <th className="px-4 py-3 text-left">Phone</th>
              <th className="px-4 py-3 text-left">Role</th>
              <th className="px-4 py-3 text-right">Salary</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="text-sm">
            {workers.map((w) => (
              <tr key={w.id} className="border-t border-border">
                <td className="px-4 py-3">
                  {w.fullName}
                  {w.id === myWorkerId && <span className="text-accent text-xs ml-2">you</span>}
                </td>
                <td className="px-4 py-3 font-mono tnum">{w.phone}</td>
                <td className="px-4 py-3">{w.role}</td>
                <td className="px-4 py-3 text-right font-mono tnum">{formatMoneyWithCurrency(w.baseSalaryPesewas)}</td>
                <td className="px-4 py-3">
                  {w.terminatedAt
                    ? <span className="text-text-tertiary">terminated {w.terminatedAt}</span>
                    : w.active
                      ? <span className="text-success">active</span>
                      : <span className="text-warning">inactive</span>}
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  {w.id === myWorkerId ? (
                    <span className="text-text-tertiary text-xs">—</span>
                  ) : isAdmin ? (
                    <>
                      {!w.terminatedAt && w.active && (
                        <button onClick={() => deactivate(w.id)} className="text-text-tertiary hover:text-warning text-xs">deactivate</button>
                      )}
                      {!w.terminatedAt && !w.active && (
                        <button onClick={() => reactivate(w.id)} className="text-text-tertiary hover:text-success text-xs">reactivate</button>
                      )}
                      <button onClick={() => setResetPinFor(w)} className="text-text-tertiary hover:text-accent text-xs">reset PIN</button>
                      {!w.terminatedAt && (
                        <button onClick={() => setTerminateFor(w)} className="text-text-tertiary hover:text-danger text-xs">terminate</button>
                      )}
                    </>
                  ) : (
                    <span className="text-text-tertiary text-xs">admin only</span>
                  )}
                </td>
              </tr>
            ))}
            {workers.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-text-tertiary text-center">No workers.</td></tr>
            )}
          </tbody>
        </table>
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
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
          <div className="bg-bg-surface rounded-lg shadow-xl w-full max-w-lg p-6 space-y-4 border border-border">
            <h2 className="text-xl font-semibold">New recovery code</h2>
            <p className="text-sm text-text-secondary">
              The previous recovery code has been invalidated. Write the new code
              below somewhere safe — this is the only time it will be shown.
            </p>
            <div className="bg-bg-deep border-2 border-accent rounded p-6 text-center">
              <div className="text-xs text-text-tertiary uppercase tracking-wider mb-2">Recovery code</div>
              <div className="font-mono text-2xl font-bold tracking-widest break-all">{regeneratedCode}</div>
              <div className="text-xs text-text-tertiary mt-3">
                Hyphens and case are ignored when typed.
              </div>
            </div>
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={regenAck} onChange={(e) => setRegenAck(e.target.checked)} />
              I have written this new code down somewhere safe.
            </label>
            <div className="flex justify-end gap-3 pt-2">
              <button
                disabled={!regenAck}
                onClick={() => { setRegeneratedCode(null); setRegenAck(false); flash('Recovery code regenerated.', 'info'); }}
                className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50">
                Done
              </button>
            </div>
          </div>
        </div>
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-bg-surface border border-border w-full max-w-md p-8 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">Add worker</h3>
        <input autoFocus value={fullName} onChange={(e) => setFullName(e.target.value)}
          placeholder="Full name" className="bg-bg-input border border-border-strong px-4 py-3" />
        <input value={phone} onChange={(e) => setPhone(e.target.value)}
          placeholder="Phone (e.g. 0555547998)" className="bg-bg-input border border-border-strong px-4 py-3 font-mono" />
        <select value={role} onChange={(e) => setRole(e.target.value as typeof ROLE_OPTIONS[number])}
          className="bg-bg-input border border-border-strong px-4 py-3">
          {ROLE_OPTIONS.map((r) => <option key={r}>{r}</option>)}
        </select>
        <input type="password" inputMode="numeric" value={pin} maxLength={6}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="PIN (4-6 digits)"
          className="bg-bg-input border border-border-strong px-4 py-3 font-mono tnum tracking-[0.5em] text-center" />
        <input value={salary} onChange={(e) => setSalary(e.target.value.replace(/\D/g, ''))}
          placeholder="Monthly salary in pesewas (e.g. 150000 = GHS 1500)"
          className="bg-bg-input border border-border-strong px-4 py-3 font-mono tnum" />
        <div className="flex gap-3 mt-2">
          <button onClick={onCancel} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
          <button onClick={() => void submit()} disabled={submitting || pin.length < 4 || !fullName.trim()}
            className="bg-accent text-bg-deep px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
            {submitting ? 'Adding…' : 'Add worker'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetPinModal({ worker, onCancel, onDone, onError }: { worker: AdminWorker; onCancel: () => void; onDone: () => void; onError: (e: string) => void }) {
  const [pin, setPin] = useState('');
  async function submit() {
    const r = await counter.resetPin(worker.id, pin);
    if (!r.success) onError(r.error); else onDone();
  }
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-bg-surface border border-border w-full max-w-md p-8 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">Reset PIN — {worker.fullName}</h3>
        <input autoFocus type="password" inputMode="numeric" value={pin} maxLength={6}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          placeholder="New PIN (4-6 digits)"
          className="bg-bg-input border border-border-strong px-4 py-3 font-mono tnum tracking-[0.5em] text-center" />
        <div className="text-text-tertiary text-xs">All active lockouts on this worker will be cleared.</div>
        <div className="flex gap-3">
          <button onClick={onCancel} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
          <button onClick={() => void submit()} disabled={pin.length < 4}
            className="bg-accent text-bg-deep px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}

function TerminateModal({ worker, onCancel, onDone, onError }: { worker: AdminWorker; onCancel: () => void; onDone: () => void; onError: (e: string) => void }) {
  const [reason, setReason] = useState('');
  async function submit() {
    const r = await counter.terminateWorker(worker.id, reason.trim());
    if (!r.success) onError(r.error); else onDone();
  }
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-bg-surface border border-border w-full max-w-md p-8 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">Terminate — {worker.fullName}</h3>
        <div className="text-text-tertiary text-sm">
          This is permanent. The worker stays in the database with all historical attribution intact, but cannot log in again.
        </div>
        <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (e.g. resigned, fired for theft)"
          className="bg-bg-input border border-border-strong px-4 py-3" />
        <div className="flex gap-3">
          <button onClick={onCancel} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
          <button onClick={() => void submit()} disabled={reason.trim().length < 3}
            className="bg-danger text-bg-deep px-5 py-3 font-semibold disabled:opacity-40">
            Terminate
          </button>
        </div>
      </div>
    </div>
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onCancel}>
      <div className="bg-bg-surface border border-border w-full max-w-md p-8 flex flex-col gap-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">Change my PIN</h3>
        <input type="password" inputMode="numeric" value={oldPin} maxLength={6}
          onChange={(e) => setOldPin(e.target.value.replace(/\D/g, ''))}
          placeholder="Old PIN"
          className="bg-bg-input border border-border-strong px-4 py-3 font-mono tnum tracking-[0.5em] text-center" />
        <input type="password" inputMode="numeric" value={newPin} maxLength={6}
          onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
          placeholder="New PIN (4-6 digits)"
          className="bg-bg-input border border-border-strong px-4 py-3 font-mono tnum tracking-[0.5em] text-center" />
        <div className="flex gap-3">
          <button onClick={onCancel} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
          <button onClick={() => void submit()} disabled={oldPin.length < 4 || newPin.length < 4}
            className="bg-accent text-bg-deep px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
            Update
          </button>
        </div>
      </div>
    </div>
  );
}
