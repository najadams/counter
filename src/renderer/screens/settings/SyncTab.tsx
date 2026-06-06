// Settings -> Sync. Provisions this install for multi-shop sync by writing the
// shop id, central URL, token, and role into device_config. OWNER/FOUNDER only.
// Changes take effect on the next launch (the sync worker starts at boot).

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import type { SyncStatus } from '../../../shared/types/ipc';

export function SyncTab(): JSX.Element {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [shopId, setShopId] = useState('');
  const [centralUrl, setCentralUrl] = useState('');
  const [token, setToken] = useState('');
  const [role, setRole] = useState<'HQ' | 'SHOP'>('SHOP');
  const [hasToken, setHasToken] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function refresh(): Promise<void> {
    const [s, c] = await Promise.all([counter.syncGetStatus(), counter.syncGetConfig()]);
    if (s.success) setStatus(s.data);
    if (c.success) {
      setShopId(c.data.shopId ?? '');
      setCentralUrl(c.data.centralUrl ?? '');
      setRole(c.data.role);
      setHasToken(c.data.hasToken);
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function save(): Promise<void> {
    setSaving(true); setErr(null); setMsg(null);
    const r = await counter.syncSetConfig({ shopId, centralUrl, token: token || undefined, role });
    setSaving(false);
    if (!r.success) { setErr(r.error); return; }
    setToken('');
    setMsg('Saved. Restart Counter for the change to take effect.');
    await refresh();
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-text-primary font-semibold">Multi-shop sync</h2>
        <p className="text-text-secondary text-sm mt-1">
          Connect this install to the central store so sales flow up and the catalog flows down.
          Leave blank for a standalone single shop. OWNER only.
        </p>
      </div>

      {status && (
        <div className="border border-border rounded p-4 text-sm space-y-1">
          <Row label="Status" value={status.configured ? `Provisioned (${status.role})` : 'Not configured'} />
          <Row label="Pending to sync" value={String(status.pendingCount)} />
          <Row label="Last push" value={status.lastPushAt ?? '—'} />
          <Row label="Last pull" value={status.lastPullAt ?? '—'} />
        </div>
      )}

      <div className="space-y-4">
        <Field label="Shop code / id" value={shopId} onChange={setShopId} placeholder="e.g. osu" />
        <Field label="Central URL" value={centralUrl} onChange={setCentralUrl} placeholder="https://central.example.com" />
        <Field
          label={hasToken ? 'Sync token (leave blank to keep current)' : 'Sync token'}
          value={token} onChange={setToken} placeholder={hasToken ? '•••••••• stored' : 'paste the per-shop token'} type="password"
        />
        <div>
          <label className="block text-xs uppercase tracking-wider text-text-secondary mb-1">Role</label>
          <div className="flex gap-2">
            <RoleBtn active={role === 'SHOP'} onClick={() => setRole('SHOP')}>Shop (sells; pulls catalog)</RoleBtn>
            <RoleBtn active={role === 'HQ'} onClick={() => setRole('HQ')}>HQ (owns the catalog)</RoleBtn>
          </div>
        </div>
      </div>

      {err && <div className="border border-danger bg-danger/10 text-danger text-sm px-3 py-2 rounded">{err}</div>}
      {msg && <div className="border border-success bg-success/10 text-success text-sm px-3 py-2 rounded">{msg}</div>}

      <button onClick={() => void save()} disabled={saving}
        className="bg-accent text-ink px-5 py-2 font-semibold hover:bg-accent-light disabled:opacity-50">
        {saving ? 'Saving…' : 'Save sync settings'}
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-text-secondary">{label}</span>
      <span className="font-mono text-xs text-text-primary truncate max-w-[60%]">{value}</span>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = 'text' }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-text-secondary mb-1">{label}</label>
      <input type={type} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-bg-input border border-border px-3 py-2 text-sm focus:outline-none focus:border-accent" />
    </div>
  );
}

function RoleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={`flex-1 px-3 py-2 text-sm border ${active ? 'border-accent text-accent bg-accent/10' : 'border-border text-text-secondary hover:bg-bg-elevated'}`}>
      {children}
    </button>
  );
}
