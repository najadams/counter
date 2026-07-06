// Settings -> Sync. Provisions this install for multi-shop sync by writing the
// shop id, central URL, token, and role into device_config. OWNER/FOUNDER only.
// Changes take effect on the next launch (the sync worker starts at boot).

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import type { SyncStatus, AddShopResult } from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';

export function SyncTab(): JSX.Element {
  const role_ = useSession((s) => s.workerRole);
  const isOwner = role_ === 'OWNER' || role_ === 'FOUNDER';

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

      <fieldset disabled={!isOwner} className="space-y-4">
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
      </fieldset>

      {err && <FeedbackBanner>{err}</FeedbackBanner>}
      {msg && <div className="border border-success bg-success/10 text-success text-sm px-3 py-2 rounded">{msg}</div>}
      {!isOwner && <div className="text-text-tertiary text-xs">Only OWNER or FOUNDER can change sync settings.</div>}

      <button onClick={() => void save()} disabled={!isOwner || saving}
        className="bg-accent text-ink px-5 py-2 font-semibold hover:bg-accent-light disabled:opacity-50">
        {saving ? 'Saving…' : 'Save sync settings'}
      </button>

      {status?.configured && isOwner && <AddBranchSection />}
    </div>
  );
}

/** Settings -> Sync -> "Add a new branch": self-service onboarding for a
 *  SIBLING shop under THIS install's own company. Requires this install to
 *  already be provisioned (gated by the parent's `status?.configured` check).
 *  The new branch's token is shown exactly once, mirroring the OWNER-PIN
 *  recovery-code flow in SetupScreen.tsx — the OWNER must acknowledge they've
 *  copied it before the panel can be dismissed. */
function AddBranchSection(): JSX.Element {
  const [newShopId, setNewShopId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<AddShopResult | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  async function addBranch(): Promise<void> {
    const shopId = newShopId.trim();
    if (!shopId) { setErr('Shop code is required.'); return; }
    setBusy(true); setErr(null);
    const r = await counter.syncAddShop({ shopId });
    setBusy(false);
    if (!r.success) { setErr(r.error); return; }
    setCreated(r.data);
    setAcknowledged(false);
  }

  function dismiss(): void {
    setCreated(null);
    setNewShopId('');
    setAcknowledged(false);
  }

  if (created) {
    return (
      <div className="border-2 border-accent rounded p-6 space-y-4">
        <div>
          <h3 className="font-semibold">Branch &quot;{created.shopId}&quot; created</h3>
          <p className="text-text-tertiary text-sm mt-1">
            Copy these details into that branch&apos;s own Settings → Sync, then
            restart Counter there. The token is shown only once.
          </p>
        </div>

        <div className="bg-bg-deep border border-border rounded p-4 space-y-2 text-sm">
          <Row label="Shop code / id" value={created.shopId} />
          <Row label="Central URL" value={created.centralUrl} />
          <Row label="Role" value="Shop (sells; pulls catalog)" />
          <div>
            <div className="text-text-secondary text-xs uppercase tracking-wider mb-1">Sync token</div>
            <div className="font-mono text-sm break-all bg-bg-input border border-border-strong p-2 rounded">
              {created.token}
            </div>
          </div>
        </div>

        <div className="bg-warning/10 border border-warning/40 rounded p-3 text-warning text-sm">
          This token will not be shown again. If it's lost, add the branch again
          to mint a fresh one.
        </div>

        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
          I have copied these details to the new branch&apos;s install.
        </label>

        <button onClick={dismiss} disabled={!acknowledged}
          className="w-full py-2 rounded bg-accent text-ink font-semibold disabled:opacity-50">
          Done
        </button>
      </div>
    );
  }

  return (
    <div className="border border-border rounded p-4 space-y-3">
      <div>
        <h3 className="font-semibold">Add a new branch</h3>
        <p className="text-text-tertiary text-sm mt-1">
          Onboard another location under this same company — no SQL, no operator
          involved. It joins as a Shop (sells; pulls the catalog from here).
        </p>
      </div>
      <Field label="New branch's shop code / id" value={newShopId} onChange={setNewShopId} placeholder="e.g. osu-2" />
      {err && <FeedbackBanner>{err}</FeedbackBanner>}
      <button onClick={() => void addBranch()} disabled={busy}
        className="bg-accent text-ink px-5 py-2 font-semibold hover:bg-accent-light disabled:opacity-50">
        {busy ? 'Adding…' : 'Add branch'}
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
