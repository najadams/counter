import { useCallback, useEffect, useState } from 'react';
import { AppHeader } from '../components/AppHeader';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import type {
  VarianceCaseGetResponse, VarianceCaseRow, VarianceCaseSettings,
  VarianceCaseStatus, VarianceCauseCode,
} from '../../shared/types/ipc';

const CAUSES: Array<[VarianceCauseCode, string]> = [
  ['WRONG_CHANGE', 'Wrong change'], ['MISSED_SALE', 'Missed sale'],
  ['WRONG_PAYMENT_RAIL', 'Wrong payment rail'], ['UNRECORDED_EXPENSE', 'Unrecorded expense'],
  ['UNRECORDED_CASH_DROP', 'Unrecorded cash drop'], ['COUNTING_ERROR', 'Counting error'],
  ['BREAKAGE', 'Breakage'], ['EXPIRY', 'Expiry'], ['THEFT', 'Theft'],
  ['BANK_MOMO_TIMING', 'Bank/MoMo timing'], ['CUSTOMER_ALLOCATION', 'Customer allocation'],
  ['SYSTEM_DATA_ERROR', 'System/data error'], ['OTHER', 'Other'],
];

export default function VarianceCasesScreen({ onExit }: { onExit: () => void }) {
  const workerId = useSession((state) => state.workerId);
  const role = useSession((state) => state.workerRole);
  const [tab, setTab] = useState<'OPEN' | 'HISTORY'>('OPEN');
  const [rows, setRows] = useState<VarianceCaseRow[]>([]);
  const [summary, setSummary] = useState({ openCount: 0, overdueCount: 0, unresolvedPesewas: 0 });
  const [selected, setSelected] = useState<VarianceCaseGetResponse | null>(null);
  const [settings, setSettings] = useState<VarianceCaseSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cause, setCause] = useState<VarianceCauseCode | ''>('');
  const [rootNotes, setRootNotes] = useState('');
  const [resolution, setResolution] = useState('');
  const [note, setNote] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [evidenceUrl, setEvidenceUrl] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';

  const refresh = useCallback(async () => {
    const result = await counter.varianceCaseList({ status: tab, limit: 200 });
    if (!result.success) { setError(result.error); return; }
    setRows(result.data.cases); setSummary(result.data.summary); setError(null);
  }, [tab]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    const onFocus = () => void refresh();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'F9' || event.key === 'Escape') {
        event.preventDefault();
        if (selected) setSelected(null); else onExit();
      }
    };
    window.addEventListener('focus', onFocus); window.addEventListener('keydown', onKey);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', onFocus); window.removeEventListener('keydown', onKey); };
  }, [refresh, selected, onExit]);

  async function open(row: VarianceCaseRow) {
    const result = await counter.varianceCaseGet(row.id);
    if (!result.success) { setError(result.error); return; }
    setSelected(result.data); setCause(result.data.case.causeCode ?? '');
    setRootNotes(result.data.case.rootCauseNotes ?? ''); setResolution('');
    setNote(''); setEvidenceReference(''); setEvidenceUrl(''); setMessage(null);
  }

  async function update(status?: VarianceCaseStatus, assignSelf = false) {
    if (!selected || busy) return;
    if ((status === 'RESOLVED' || status === 'WRITTEN_OFF') && (!cause || resolution.trim().length < 3)) {
      setError('Choose a cause and explain the resolution before closing the case.'); return;
    }
    let pin: string | null = null;
    if (status === 'WRITTEN_OFF') {
      pin = window.prompt('Enter your fresh owner PIN to accept this residual variance:') ?? null;
      if (!pin) return;
    }
    setBusy(true); setError(null);
    const result = await counter.varianceCaseUpdate({
      caseId: selected.case.id, status, assignedTo: assignSelf ? workerId : undefined,
      causeCode: cause || undefined, rootCauseNotes: rootNotes.trim() || null,
      resolutionNote: resolution.trim() || undefined, pin,
    });
    setBusy(false);
    if (!result.success) { setError(result.error); return; }
    setMessage(status === 'WRITTEN_OFF' ? 'Residual variance accepted and closed.' : status === 'RESOLVED' ? 'Case resolved.' : 'Case updated.');
    await refresh(); await open(result.data);
  }

  async function addEvidence() {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    const result = await counter.varianceCaseAddEvidence({ caseId: selected.case.id, note, evidenceReference, evidenceUrl });
    setBusy(false);
    if (!result.success) { setError(result.error); return; }
    setNote(''); setEvidenceReference(''); setEvidenceUrl('');
    setMessage('Investigation note added to the permanent timeline.');
    const refreshed = await counter.varianceCaseGet(selected.case.id);
    if (refreshed.success) setSelected(refreshed.data);
  }

  async function loadSettings() {
    setShowSettings((value) => !value);
    if (settings) return;
    const result = await counter.varianceCaseSettingsGet();
    if (result.success) setSettings(result.data); else setError(result.error);
  }

  async function saveSettings() {
    if (!settings) return;
    const pin = window.prompt('Enter your fresh owner PIN to change investigation thresholds:');
    if (!pin) return;
    const result = await counter.varianceCaseSettingsUpdate({ ...settings, pin });
    if (!result.success) { setError(result.error); return; }
    setSettings(result.data); setMessage('Variance thresholds updated. New thresholds apply to future reconciliations.');
  }

  return <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
    <AppHeader subtitle="variance review" onBack={onExit} />
    <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-8 py-6 flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><div className="eyebrow">Reconciliation control</div><h1 className="text-2xl font-semibold mt-1">Variance cases</h1><p className="text-sm text-text-secondary mt-1">Every material difference gets an owner, evidence, root cause, and auditable resolution.</p></div>
        <div className="segmented-control"><button className={tab === 'OPEN' ? 'active' : ''} onClick={() => { setTab('OPEN'); setSelected(null); }}>Open</button><button className={tab === 'HISTORY' ? 'active' : ''} onClick={() => { setTab('HISTORY'); setSelected(null); }}>History</button></div>
      </header>
      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      {message && <div className="notice border-success/50 text-success">{message}</div>}
      <section className="grid sm:grid-cols-3 gap-3">
        <Metric label="Open cases" value={String(summary.openCount)} tone={summary.openCount ? 'warn' : 'ok'} />
        <Metric label="Overdue" value={String(summary.overdueCount)} tone={summary.overdueCount ? 'bad' : 'ok'} />
        <Metric label="Unresolved value" value={formatMoneyWithCurrency(summary.unresolvedPesewas)} tone={summary.unresolvedPesewas ? 'warn' : 'ok'} />
      </section>
      <section className="panel overflow-hidden"><div className="overflow-x-auto"><table className="data-table w-full"><thead><tr><th>Due</th><th>Case</th><th>Subject</th><th>Difference</th><th>Owner</th><th>Status</th><th></th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
        <td className={row.overdue ? 'text-danger font-semibold' : ''}>{new Date(row.dueAt).toLocaleDateString()}</td>
        <td><div className="font-medium">{row.title}</div><div className="text-xs text-text-tertiary">{label(row.caseType)} · {row.sourceType.replace(/_/g, ' ')}</div></td>
        <td>{row.subjectName ?? 'Shop'}</td>
        <td className={row.amountPesewas < 0 ? 'text-danger font-mono tnum' : 'text-warning font-mono tnum'}>{row.amountPesewas > 0 ? '+' : ''}{formatMoneyWithCurrency(row.amountPesewas)}</td>
        <td>{row.assignedToName ?? <span className="text-text-tertiary">Unassigned</span>}</td><td><CaseStatus status={row.status} /></td>
        <td className="text-right"><button className="btn btn-quiet text-xs" onClick={() => void open(row)}>Open</button></td>
      </tr>)}</tbody></table></div>{rows.length === 0 && <div className="empty-state">{tab === 'OPEN' ? 'No material variances need investigation.' : 'No closed cases yet.'}</div>}</section>

      {selected && <section className="panel p-5 sm:p-6 flex flex-col gap-5 border-warning/50">
        <div className="flex justify-between gap-3"><div><div className="eyebrow">{label(selected.case.caseType)} · {selected.case.sourceType.replace(/_/g, ' ')}</div><h2 className="text-xl font-semibold mt-1">{selected.case.title}</h2><p className="text-sm text-text-secondary">Detected {new Date(selected.case.detectedAt).toLocaleString()} · due {new Date(selected.case.dueAt).toLocaleString()}</p></div><CaseStatus status={selected.case.status} /></div>
        <div className="grid sm:grid-cols-4 gap-3"><Info label="Expected" value={selected.case.expectedPesewas === null ? 'Not applicable' : formatMoneyWithCurrency(selected.case.expectedPesewas)} /><Info label="Observed" value={selected.case.observedPesewas === null ? 'Not recorded' : formatMoneyWithCurrency(selected.case.observedPesewas)} /><Info label="Difference" value={`${selected.case.amountPesewas > 0 ? '+' : ''}${formatMoneyWithCurrency(selected.case.amountPesewas)}`} /><Info label="Threshold" value={formatMoneyWithCurrency(selected.case.thresholdPesewas)} /></div>
        <div className="notice">Case decisions document the investigation; they never silently change cash, stock, or customer balances. Make corrections through the original transaction or reconciliation workflow.</div>
        {selected.case.adjustmentJournalEntryId && <div className="notice">The account reconciliation already posted adjustment <span className="font-mono">{selected.case.adjustmentJournalEntryId}</span>. Closing this case documents the cause; it does not post the difference twice.</div>}
        {!['RESOLVED', 'WRITTEN_OFF'].includes(selected.case.status) && <>
          <div className="grid md:grid-cols-2 gap-4"><label className="text-sm">Root cause<select className="input w-full mt-1" value={cause} onChange={(event) => setCause(event.target.value as VarianceCauseCode | '')}><option value="">Select after investigation</option>{CAUSES.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label><label className="text-sm">Root-cause detail<textarea className="input w-full mt-1" rows={3} value={rootNotes} onChange={(event) => setRootNotes(event.target.value)} maxLength={500} /></label></div>
          <div className="subpanel"><h3>Add investigation evidence</h3><div className="grid md:grid-cols-3 gap-3 mt-3"><input className="input" placeholder="Note or finding" value={note} onChange={(event) => setNote(event.target.value)} /><input className="input" placeholder="Receipt / statement reference" value={evidenceReference} onChange={(event) => setEvidenceReference(event.target.value)} /><input className="input" placeholder="Evidence URL or file reference" value={evidenceUrl} onChange={(event) => setEvidenceUrl(event.target.value)} /></div><button className="btn btn-quiet mt-3" disabled={busy || (!note.trim() && !evidenceReference.trim() && !evidenceUrl.trim())} onClick={() => void addEvidence()}>Add to timeline</button></div>
          <label className="text-sm">Resolution or reopen reason<textarea className="input w-full mt-1" rows={3} value={resolution} onChange={(event) => setResolution(event.target.value)} placeholder="What was corrected, or why is the residual accepted?" maxLength={500} /></label>
          <div className="flex flex-wrap gap-3"><button className="btn btn-quiet" onClick={() => setSelected(null)}>Close panel</button>{!selected.case.assignedTo && <button className="btn btn-quiet" onClick={() => void update(undefined, true)}>Assign to me</button>}<button className="btn btn-quiet" onClick={() => void update('INVESTIGATING')}>Start investigation</button><button className="btn btn-quiet" onClick={() => void update('AWAITING_EVIDENCE')}>Await evidence</button><button className="btn border-success text-success" onClick={() => void update('RESOLVED')}>Resolve corrected case</button>{isOwner && <button className="btn border-danger text-danger" onClick={() => void update('WRITTEN_OFF')}>Close as accepted residual</button>}</div>
        </>}
        {['RESOLVED', 'WRITTEN_OFF'].includes(selected.case.status) && <div className="notice"><strong>{selected.case.status === 'WRITTEN_OFF' ? 'Residual accepted' : 'Resolved'}</strong>{selected.case.resolvedByName ? ` by ${selected.case.resolvedByName}` : ''}. Cause: {selected.case.causeCode ? label(selected.case.causeCode) : 'not recorded'}. {selected.case.resolutionNote}</div>}
        <div className="subpanel"><h3>Immutable investigation timeline</h3>{selected.events.map((event) => <div key={event.id} className="py-2 border-t border-border-subtle text-sm"><div className="flex justify-between gap-3"><strong>{label(event.eventType)}</strong><span className="text-xs text-text-tertiary">{new Date(event.occurredAt).toLocaleString()} · {event.actorName}</span></div>{event.note && <p className="text-text-secondary mt-1">{event.note}</p>}{event.evidenceReference && <p className="text-xs mt-1">Reference: {event.evidenceReference}</p>}{event.evidenceUrl && <p className="text-xs mt-1 break-all">Evidence: {event.evidenceUrl}</p>}</div>)}</div>
      </section>}

      {isOwner && <section className="panel p-5"><button className="w-full flex justify-between text-left" onClick={() => void loadSettings()}><span><span className="font-semibold">Investigation thresholds</span><span className="block text-xs text-text-secondary mt-1">Applied when future till closes and stocktakes are reconciled.</span></span><span>{showSettings ? '−' : '+'}</span></button>{showSettings && settings && <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 mt-5"><MoneySetting label="Till minimum (GHS)" value={settings.tillAmountThresholdPesewas} onChange={(value) => setSettings({ ...settings, tillAmountThresholdPesewas: value })} /><NumberSetting label="Till %" value={settings.tillThresholdBps / 100} onChange={(value) => setSettings({ ...settings, tillThresholdBps: Math.round(value * 100) })} /><MoneySetting label="Stock minimum (GHS)" value={settings.stockAmountThresholdPesewas} onChange={(value) => setSettings({ ...settings, stockAmountThresholdPesewas: value })} /><NumberSetting label="Stock %" value={settings.stockThresholdBps / 100} onChange={(value) => setSettings({ ...settings, stockThresholdBps: Math.round(value * 100) })} /><NumberSetting label="Due in days" value={settings.dueDays} onChange={(value) => setSettings({ ...settings, dueDays: Math.round(value) })} /><button className="btn btn-primary sm:col-span-2 lg:col-span-5 justify-self-start" onClick={() => void saveSettings()}>Save thresholds</button></div>}</section>}
    </main>
  </div>;
}

function label(value: string): string { return value.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()); }
function CaseStatus({ status }: { status: VarianceCaseStatus }) { const tone = status === 'WRITTEN_OFF' ? 'status-danger' : status === 'RESOLVED' ? 'status-approved' : status === 'AWAITING_EVIDENCE' ? 'status-pending' : 'status-neutral'; return <span className={`status-badge ${tone}`}>{status === 'WRITTEN_OFF' ? 'Accepted residual' : label(status)}</span>; }
function Metric({ label: text, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' }) { return <div className={`panel p-4 ${tone === 'bad' ? 'border-danger/50' : tone === 'warn' ? 'border-warning/50' : ''}`}><div className="text-xs text-text-secondary">{text}</div><div className={`text-2xl font-mono tnum mt-1 ${tone === 'bad' ? 'text-danger' : tone === 'warn' ? 'text-warning' : 'text-success'}`}>{value}</div></div>; }
function Info({ label: text, value }: { label: string; value: string }) { return <div className="subpanel"><div className="text-xs text-text-tertiary">{text}</div><div className="font-mono tnum mt-1">{value}</div></div>; }
function MoneySetting({ label: text, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <label className="text-sm">{text}<input className="input w-full mt-1" inputMode="decimal" value={(value / 100).toFixed(2)} onChange={(event) => { const parsed = parseCedisToPesewas(event.target.value); if (parsed !== null) onChange(parsed); }} /></label>; }
function NumberSetting({ label: text, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <label className="text-sm">{text}<input className="input w-full mt-1" type="number" min="0" value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>; }
