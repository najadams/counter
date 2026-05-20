// BackupsTab — owner-facing backup health + controls.
//
// Top half: heartbeat status, big 'Run backup now' button.
// Bottom half: configuration form (target dir, location class), 'Test target'
// button. OWNER-only edits — read-only for cashiers.
//
// All backup actions are audited (see registerBackupHandlers in
// src/main/ipc/handlers.ts). The home-screen banner reads the same
// heartbeat this tab does.

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { describeHeartbeat, formatAge } from '../../../shared/lib/backupHeartbeat';
import type {
  BackupHeartbeat,
  BackupConfigResponse,
  BackupLocationClass,
  BackupListHistoryResponse,
  BackupHistoryEntry,
} from '../../../shared/types/ipc';

type BannerKind = 'success' | 'warning' | 'danger';

interface InlineMessage {
  kind: BannerKind;
  text: string;
}

export function BackupsTab() {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';

  const [heartbeat, setHeartbeat] = useState<BackupHeartbeat | null>(null);
  const [config, setConfig] = useState<BackupConfigResponse | null>(null);
  const [history, setHistory] = useState<BackupListHistoryResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  // Form state. Initialised from config on first load.
  const [targetDirDraft, setTargetDirDraft] = useState('');
  const [locationClassDraft, setLocationClassDraft] = useState<BackupLocationClass>('local');
  const [formDirty, setFormDirty] = useState(false);

  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<InlineMessage | null>(null);
  const [testing, setTesting] = useState(false);
  const [testMessage, setTestMessage] = useState<InlineMessage | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<InlineMessage | null>(null);

  useEffect(() => { void reload(); }, []);

  async function reload() {
    setLoadError(null);
    const [hb, cfg, hist] = await Promise.all([
      counter.backupGetHeartbeat(),
      counter.backupGetConfig(),
      counter.backupListHistory(),
    ]);
    if (!hb.success) { setLoadError(hb.error); return; }
    if (!cfg.success) { setLoadError(cfg.error); return; }
    setHeartbeat(hb.data);
    setConfig(cfg.data);
    if (hist.success) setHistory(hist.data);
    if (!formDirty) {
      setTargetDirDraft(cfg.data.targetDir);
      setLocationClassDraft(cfg.data.locationClass);
    }
  }

  async function reveal() {
    setRevealError(null);
    const r = await counter.backupRevealTarget();
    if (!r.success) { setRevealError(r.error); return; }
    if (!r.data.ok) { setRevealError(r.data.error ?? 'Could not open the folder.'); return; }
  }

  async function runNow() {
    setRunning(true);
    setRunMessage(null);
    const r = await counter.backupRunNow();
    setRunning(false);
    if (!r.success) {
      setRunMessage({ kind: 'danger', text: 'Could not run backup: ' + r.error });
      return;
    }
    if (!r.data.ok) {
      setRunMessage({ kind: 'danger', text: 'Backup failed: ' + (r.data.error ?? 'unknown error') });
      return;
    }
    const where = r.data.dbDest ?? '(unknown path)';
    setRunMessage({
      kind: 'success',
      text:
        'Backup written to ' + where +
        (r.data.usedVacuum ? ' (using VACUUM INTO).' : ' (file copy fallback — better-sqlite3 unavailable).'),
    });
    void reload();
  }

  async function testTarget() {
    setTesting(true);
    setTestMessage(null);
    const r = await counter.backupTestTarget(targetDirDraft || undefined);
    setTesting(false);
    if (!r.success) {
      setTestMessage({ kind: 'danger', text: 'Test failed: ' + r.error });
      return;
    }
    if (!r.data.ok) {
      setTestMessage({
        kind: 'danger',
        text: 'Cannot write to ' + r.data.targetDir + ': ' + (r.data.error ?? 'unknown error'),
      });
      return;
    }
    setTestMessage({
      kind: 'success',
      text:
        (r.data.preexisted ? 'Target exists and is writable' : 'Target created and is writable')
        + ': ' + r.data.targetDir,
    });
  }

  async function save() {
    setSaving(true);
    setSaveMessage(null);
    const r = await counter.backupSetConfig(targetDirDraft, locationClassDraft);
    setSaving(false);
    if (!r.success) {
      setSaveMessage({ kind: 'danger', text: 'Save failed: ' + r.error });
      return;
    }
    setConfig(r.data);
    setFormDirty(false);
    setSaveMessage({ kind: 'success', text: 'Backup settings saved.' });
  }

  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <section className="space-y-3">
        <h2 className="text-text-secondary uppercase tracking-wider text-xs">Backup health</h2>
        {loadError && <Inline kind="danger" text={'Could not read backup status: ' + loadError} />}
        {heartbeat && <HeartbeatCard heartbeat={heartbeat} />}

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={() => void runNow()}
            disabled={running}
            className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-50"
          >
            {running ? 'Running…' : 'Run backup now'}
          </button>
          <div className="text-xs text-text-tertiary">
            Writes to <span className="font-mono">{config?.targetDir ?? '...'}</span>.
          </div>
        </div>
        {runMessage && <Inline {...runMessage} />}
      </section>

      <section className="space-y-3 border-t border-border-subtle pt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">Recent backups</h2>
          <button onClick={() => void reveal()}
            className="text-xs underline text-text-secondary hover:text-text-primary">
            Open in {macLike() ? 'Finder' : 'file browser'}
          </button>
        </div>
        {revealError && <Inline kind="danger" text={revealError} />}
        {history && <HistoryList history={history} />}
      </section>

      <section className="space-y-3 border-t border-border-subtle pt-6">
        <h2 className="text-text-secondary uppercase tracking-wider text-xs">Backup destination</h2>

        <label className="block text-sm space-y-1">
          <span className="text-text-secondary">Target directory</span>
          <input
            type="text"
            value={targetDirDraft}
            onChange={(e) => { setTargetDirDraft(e.target.value); setFormDirty(true); }}
            disabled={!isOwner}
            placeholder="/Volumes/Backup or ~/CounterBackups"
            className="w-full font-mono bg-bg-surface border border-border px-3 py-2 text-text-primary disabled:opacity-60"
          />
          <span className="text-xs text-text-tertiary">
            Absolute path on this machine. USB sticks on macOS mount under <span className="font-mono">/Volumes/</span>;
            on Windows they appear as drive letters like <span className="font-mono">D:\Backup</span>.
          </span>
        </label>

        <fieldset className="text-sm space-y-1" disabled={!isOwner}>
          <legend className="text-text-secondary">Location type</legend>
          <div className="flex flex-wrap gap-4 pt-1">
            <RadioOption
              label="USB stick"
              hint="Taken home daily. Safe from fire and theft of the till PC."
              checked={locationClassDraft === 'usb'}
              onChange={() => { setLocationClassDraft('usb'); setFormDirty(true); }}
            />
            <RadioOption
              label="Cloud-synced folder"
              hint="iCloud, Dropbox, etc. Already off-site via the sync provider."
              checked={locationClassDraft === 'cloud'}
              onChange={() => { setLocationClassDraft('cloud'); setFormDirty(true); }}
            />
            <RadioOption
              label="Local only"
              hint="On this machine. NOT a real backup — only useful with a separate off-site copy."
              checked={locationClassDraft === 'local'}
              onChange={() => { setLocationClassDraft('local'); setFormDirty(true); }}
            />
          </div>
        </fieldset>

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={() => void testTarget()}
            disabled={testing || !targetDirDraft.trim()}
            className="border border-border px-4 py-2 hover:bg-bg-elevated disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test target'}
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || !isOwner || !formDirty}
            className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {!isOwner && (
            <span className="text-xs text-text-tertiary">
              Only OWNER or FOUNDER can change these settings.
            </span>
          )}
        </div>

        {testMessage && <Inline {...testMessage} />}
        {saveMessage && <Inline {...saveMessage} />}
      </section>

      <section className="text-xs text-text-tertiary border-t border-border-subtle pt-4 space-y-2">
        <p>
          Backups run automatically when you close the day's last shift (after 6&nbsp;PM)
          and on the nightly scheduled job if set up. Manual runs from this page
          bypass those gates. Every backup is recorded in the audit log.
        </p>
      </section>
    </div>
  );
}

function HeartbeatCard({ heartbeat }: { heartbeat: BackupHeartbeat }) {
  const banner = describeHeartbeat(heartbeat);
  const tone =
    banner === null ? 'border-success bg-success/10 text-success'
    : banner.severity === 'danger' ? 'border-danger bg-danger/10 text-danger'
    : 'border-warning bg-warning/10 text-warning';

  const headline =
    banner === null && heartbeat.lastBackupAt
      ? 'Healthy — last backup ' + formatAge(Date.now() - new Date(heartbeat.lastBackupAt).getTime()) + ' ago'
      : banner?.headline ?? 'No backup information yet';
  const detail = banner?.detail;

  return (
    <div className={'border ' + tone + ' px-4 py-3 text-sm space-y-2'}>
      <div className="font-semibold">{headline}</div>
      {detail && <div className="text-xs text-text-secondary">{detail}</div>}
      <dl className="text-xs grid grid-cols-[8rem_1fr] gap-y-1 pt-2 border-t border-border-subtle/40">
        <dt className="text-text-tertiary">Last backup</dt>
        <dd className="font-mono break-all">{heartbeat.lastBackupAt ?? 'never'}</dd>
        <dt className="text-text-tertiary">Target</dt>
        <dd className="font-mono break-all">{heartbeat.target ?? '(none yet)'}</dd>
        <dt className="text-text-tertiary">Method</dt>
        <dd className="font-mono">
          {heartbeat.usedVacuum === null ? 'unknown' : heartbeat.usedVacuum ? 'VACUUM INTO' : 'file copy'}
        </dd>
      </dl>
    </div>
  );
}

function RadioOption({
  label, hint, checked, onChange,
}: { label: string; hint: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="radio" checked={checked} onChange={onChange} className="mt-1" />
      <span>
        <span className="text-text-primary">{label}</span>
        <span className="block text-xs text-text-tertiary">{hint}</span>
      </span>
    </label>
  );
}

function Inline({ kind, text }: InlineMessage) {
  const cls =
    kind === 'success' ? 'border-success bg-success/10 text-success'
    : kind === 'warning' ? 'border-warning bg-warning/10 text-warning'
    : 'border-danger bg-danger/10 text-danger';
  return <div className={'border ' + cls + ' px-3 py-2 text-xs break-all'}>{text}</div>;
}


function HistoryList({ history }: { history: BackupListHistoryResponse }) {
  if (history.entries.length === 0) {
    const message =
      history.reason === 'no-such-dir'
        ? "The target folder doesn't exist yet. Run a backup to create it."
        : history.reason === 'unreadable'
          ? "Could not read the target folder: " + (history.errorDetail ?? 'unknown error')
          : "No backups in " + history.targetDir + " yet.";
    return (
      <div className="text-xs text-text-tertiary border border-border-subtle px-3 py-4">
        {message}
      </div>
    );
  }
  return (
    <div className="bg-bg-surface border border-border divide-y divide-border">
      {history.entries.slice(0, 14).map((entry) => (
        <HistoryRow key={entry.filename} entry={entry} />
      ))}
      <div className="px-4 py-2 text-xs text-text-tertiary">
        {history.entries.length} file{history.entries.length === 1 ? '' : 's'} in <span className="font-mono break-all">{history.targetDir}</span>
      </div>
    </div>
  );
}

function HistoryRow({ entry }: { entry: BackupHistoryEntry }) {
  return (
    <div className="px-4 py-2 flex items-center justify-between text-sm">
      <div className="font-mono text-text-primary">{entry.filename}</div>
      <div className="flex items-center gap-4 text-xs text-text-tertiary">
        <span className="tnum">{formatBytesShort(entry.sizeBytes)}</span>
        <span>{formatAgeShort(entry.ageMs)}</span>
      </div>
    </div>
  );
}

function formatBytesShort(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function formatAgeShort(ms: number): string {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  if (ms < HOUR) {
    const m = Math.max(1, Math.floor(ms / 60_000));
    return m + ' min ago';
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    return h + (h === 1 ? ' hour ago' : ' hours ago');
  }
  const d = Math.floor(ms / DAY);
  return d + (d === 1 ? ' day ago' : ' days ago');
}

function macLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

export default BackupsTab;
