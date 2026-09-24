import { useCallback, useEffect, useMemo, useState } from 'react';
import { AppHeader } from '../components/AppHeader';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoneyWithCurrency } from '../../shared/lib/money';
import type {
  IntelligenceBrief, IntelligenceCategory, IntelligenceGetItemResponse, IntelligenceItem, IntelligenceListRequest,
  IntelligenceSeverity, IntelligenceStatus,
} from '../../shared/types/ipc';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { severityTone } from '../lib/tones';
import { NativeSelect } from '../components/ui/native-select';

type View = NonNullable<IntelligenceListRequest['view']>;
type Destination = 'variance' | 'voidApprovals' | 'stockApprovals' | 'stocktake' | 'customers' | 'settings' | 'reports';

export default function IntelligenceScreen({ onExit, onNavigate }: {
  onExit: () => void;
  onNavigate: (destination: Destination) => void;
}) {
  const workerId = useSession((state) => state.workerId);
  const workerRole = useSession((state) => state.workerRole);
  const [view, setView] = useState<View>('ATTENTION');
  const [category, setCategory] = useState<IntelligenceCategory | ''>('');
  const [severity, setSeverity] = useState<IntelligenceSeverity | ''>('');
  const [status, setStatus] = useState<IntelligenceStatus | ''>('');
  const [assignee, setAssignee] = useState('');
  const [knownAssignees, setKnownAssignees] = useState<Record<string, string>>({});
  const [shopId, setShopId] = useState('');
  const [knownShops, setKnownShops] = useState<Record<string, string>>({});
  const [companyBrief, setCompanyBrief] = useState<IntelligenceBrief | null>(null);
  const [items, setItems] = useState<IntelligenceItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const result = await counter.intelligenceList({ view,
      category: category || undefined, severity: severity || undefined,
      status: status || undefined, assignee: assignee || undefined,
      shopId: shopId || undefined, limit: 300 });
    setLoading(false);
    if (!result.success) { setError(result.error); return; }
    setItems(result.data.items); setTotal(result.data.total);
    setKnownShops((current) => {
      const next = { ...current };
      for (const item of result.data.items) if (item.sourceShopId) {
        next[item.sourceShopId] = String(item.rationale['sourceShopName'] ?? item.sourceShopId);
      }
      return next;
    });
    setKnownAssignees((current) => {
      const next = { ...current };
      for (const item of result.data.items) if (item.assignedTo) {
        next[item.assignedTo] = item.assignedToName ?? item.assignedTo;
      }
      return next;
    });
  }, [view, category, severity, status, assignee, shopId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (workerRole !== 'OWNER' && workerRole !== 'FOUNDER') return;
    void counter.intelligenceGetCompanyBrief().then((result) => {
      if (result.success) {
        setCompanyBrief(result.data);
        setKnownShops((current) => ({ ...current,
          ...Object.fromEntries((result.data.companyShops ?? []).map((shop) => [shop.shopId, shop.shopName])),
        }));
      }
    });
  }, [workerRole]);
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' || event.key === 'F9') { event.preventDefault(); onExit(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  async function refreshModels() {
    setLoading(true); setError(null);
    const result = await counter.intelligenceRefresh({ trigger: 'MANUAL' });
    if (!result.success) { setLoading(false); setError(result.error); return; }
    await load();
  }

  async function transition(item: IntelligenceItem, action: 'ACKNOWLEDGE' | 'ASSIGN' | 'SNOOZE' | 'DISMISS' | 'RESOLVE', snoozeDays?: 1 | 3 | 7) {
    let note: string | null = null;
    if (action === 'DISMISS') note = window.prompt('Why is this advice not useful or applicable?')?.trim() || null;
    if (action === 'RESOLVE') note = window.prompt('What was done and what was the outcome?')?.trim() || null;
    if ((action === 'DISMISS' || action === 'RESOLVE') && (!note || note.length < 3)) return;
    const result = await counter.intelligenceTransition({ itemId: item.id, action,
      assignedTo: action === 'ASSIGN' ? workerId : undefined, snoozeDays, note });
    if (!result.success) { setError(result.error); return; }
    await load();
  }

  const exposure = useMemo(() => items.reduce((sum, item) => sum + (item.cediImpactPesewas ?? 0), 0), [items]);

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="intelligence" onBack={onExit} />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-8 py-6 flex flex-col gap-4">
        <section className="panel p-4 flex flex-wrap items-end gap-3">
          <div className="flex gap-1">
            <Tab active={view === 'ATTENTION'} onClick={() => setView('ATTENTION')}>Needs attention</Tab>
            <Tab active={view === 'WATCHING'} onClick={() => setView('WATCHING')}>Watching</Tab>
            <Tab active={view === 'HISTORY'} onClick={() => setView('HISTORY')}>History</Tab>
          </div>
          <label className="text-xs text-text-secondary">Category
            <NativeSelect className="mt-1" value={category} onChange={(event) => setCategory(event.target.value as IntelligenceCategory | '')}>
              <option value="">All categories</option>
              {['CONTROL','INVENTORY','CREDIT','PRICING','CASH','CUSTOMER','CONCENTRATION'].map((value) => <option key={value}>{value}</option>)}
            </NativeSelect>
          </label>
          <label className="text-xs text-text-secondary">Severity
            <NativeSelect className="mt-1" value={severity} onChange={(event) => setSeverity(event.target.value as IntelligenceSeverity | '')}>
              <option value="">All severities</option>
              {['CRITICAL','HIGH','MEDIUM','LOW'].map((value) => <option key={value}>{value}</option>)}
            </NativeSelect>
          </label>
          <label className="text-xs text-text-secondary">Status
            <NativeSelect className="mt-1" value={status} onChange={(event) => setStatus(event.target.value as IntelligenceStatus | '')}>
              <option value="">All statuses</option>
              {['OPEN','ACKNOWLEDGED','ASSIGNED','SNOOZED','RESOLVED','DISMISSED','EXPIRED'].map((value) => <option key={value}>{value}</option>)}
            </NativeSelect>
          </label>
          <label className="text-xs text-text-secondary">Assignee
            <NativeSelect className="mt-1" value={assignee} onChange={(event) => setAssignee(event.target.value)}>
              <option value="">Anyone</option>
              <option value="ME">Assigned to me</option>
              <option value="UNASSIGNED">Unassigned</option>
              {Object.entries(knownAssignees).filter(([id]) => id !== workerId)
                .map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </NativeSelect>
          </label>
          {Object.keys(knownShops).length > 0 && <label className="text-xs text-text-secondary">Shop
            <NativeSelect className="mt-1" value={shopId} onChange={(event) => setShopId(event.target.value)}>
              <option value="">All shops</option>
              {Object.entries(knownShops).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </NativeSelect>
          </label>}
          <Button variant="secondary" className="ml-auto" onClick={() => void refreshModels()} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh intelligence'}
          </Button>
        </section>

        {error && <FeedbackBanner>{error}</FeedbackBanner>}
        {companyBrief?.companyShops && (
          <section className={`panel p-3 text-sm ${companyBrief.stale || companyBrief.companyShops.some((shop) => shop.stale) ? 'border-warning' : ''}`}>
            <span className="font-medium">Company data:</span>{' '}
            {companyBrief.companyShops.filter((shop) => !shop.stale).length} fresh of {companyBrief.companyShops.length} shops.
            {companyBrief.companyShops.some((shop) => shop.stale)
              ? ` Missing/stale: ${companyBrief.companyShops.filter((shop) => shop.stale).map((shop) => shop.shopName).join(', ')}.`
              : ' All reporting shops are fresh.'}
            {' '}Last successful HQ refresh {companyBrief.companyLastRefreshAt
              ? new Date(companyBrief.companyLastRefreshAt).toLocaleString() : 'has not completed'}.
          </section>
        )}
        <section className="grid grid-cols-3 gap-3">
          <Stat label="Items" value={String(total)} />
          <Stat label="Measurable exposure" value={formatMoneyWithCurrency(exposure)} />
          <Stat label="Critical/high" value={String(items.filter((item) => item.severity === 'CRITICAL' || item.severity === 'HIGH').length)} />
        </section>

        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <IntelligenceCard key={item.id} item={item}
              onTransition={(action, days) => void transition(item, action, days)}
              onNavigate={() => onNavigate(destinationFor(item))} />
          ))}
          {!loading && items.length === 0 && (
            <section className="panel p-8 text-center text-text-tertiary">No intelligence items match this view.</section>
          )}
        </div>
      </main>
    </div>
  );
}

function IntelligenceCard({ item, onTransition, onNavigate }: {
  item: IntelligenceItem;
  onTransition: (action: 'ACKNOWLEDGE' | 'ASSIGN' | 'SNOOZE' | 'DISMISS' | 'RESOLVE', days?: 1 | 3 | 7) => void;
  onNavigate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<IntelligenceGetItemResponse['events']>([]);
  const active = !['RESOLVED','DISMISSED','EXPIRED'].includes(item.status);
  const tone = item.severity === 'CRITICAL' ? 'border-danger' : item.severity === 'HIGH' ? 'border-warning' : 'border-border';
  return (
    <article className={`panel border ${tone}`}>
      <button className="w-full p-4 text-left" onClick={() => {
        const next = !expanded; setExpanded(next);
        if (next && events.length === 0) void counter.intelligenceGetItem(item.id).then((result) => {
          if (result.success) setEvents(result.data.events);
        });
      }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex gap-2 items-center text-xs">
              <Badge tone={severityTone(item.severity)}>{item.severity}</Badge>
              <span className="text-text-tertiary">{item.category} · {item.status}</span>
              {item.controlOverride && <span className="text-danger">control priority</span>}
              {item.overdue && <span className="text-danger">overdue</span>}
            </div>
            <h2 className="text-lg font-semibold mt-2">{item.title}</h2>
            <p className="text-sm text-text-secondary mt-1">{item.recommendation}</p>
          </div>
          <div className="text-right">
            <div className="font-mono tnum">{item.cediImpactPesewas == null ? 'Impact not quantified' : formatMoneyWithCurrency(item.cediImpactPesewas)}</div>
            <div className="text-xs text-text-tertiary mt-1">{(item.confidenceBps / 100).toFixed(0)}% confidence</div>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-border-subtle pt-4 flex flex-col gap-4">
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {item.evidence.map((evidence, index) => (
              <div key={`${evidence.label}-${index}`} className="bg-bg-deep border border-border-subtle p-3">
                <div className="text-xs text-text-tertiary uppercase tracking-wider">{evidence.label}</div>
                <div className="font-mono tnum mt-1">{evidence.value}</div>
                {evidence.detail && <div className="text-xs text-text-secondary mt-1">{evidence.detail}</div>}
              </div>
            ))}
          </div>
          <div className="text-xs text-text-tertiary">
            Model {item.modelKey} v{item.modelVersion} · evidence through {new Date(item.sourceDataThrough).toLocaleString()}
            {item.dueAt ? ` · due ${new Date(item.dueAt).toLocaleString()}` : ''}
            {item.assignedToName ? ` · assigned to ${item.assignedToName}` : ''}
          </div>
          <div className="bg-bg-deep border border-border-subtle p-3">
            <div className="text-xs text-text-tertiary uppercase tracking-wider">Why this item ranks here</div>
            <p className="text-sm mt-1">
              {item.controlOverride ? 'Control/shrinkage override · ' : ''}{item.severity.toLowerCase()} severity
              {item.overdue ? ' · overdue' : ''}
              {item.cediImpactPesewas != null ? ` · ${formatMoneyWithCurrency(item.cediImpactPesewas)} measurable exposure` : ' · exposure not quantified'}
              {item.dueAt ? ` · deadline ${new Date(item.dueAt).toLocaleDateString()}` : ''}
              {` · ${(item.confidenceBps / 100).toFixed(0)}% confidence`}.
            </p>
            {Object.keys(item.rationale).length > 0 && (
              <dl className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-2 mt-3 text-xs">
                {Object.entries(item.rationale).filter(([key]) => key !== 'family').map(([key, value]) => (
                  <div key={key}><dt className="text-text-tertiary">{humanLabel(key)}</dt><dd className="font-mono tnum wrap-break-word">{displayRationale(value)}</dd></div>
                ))}
              </dl>
            )}
          </div>
          {(item.resolutionNote || item.dismissalReason) && (
            <div className="bg-bg-deep border border-border-subtle p-3 text-sm">
              <span className="text-text-tertiary">Recorded outcome: </span>
              {item.resolutionNote ?? item.dismissalReason}
            </div>
          )}
          {events.length > 0 && (
            <div className="bg-bg-deep border border-border-subtle p-3">
              <div className="text-xs text-text-tertiary uppercase tracking-wider">Lifecycle</div>
              <ol className="mt-2 flex flex-col gap-1 text-xs">
                {events.map((event) => <li key={event.id}>
                  <span className="font-medium">{event.eventType.replace(/_/g, ' ')}</span>
                  {' · '}{event.actorName} · {new Date(event.occurredAt).toLocaleString()}
                  {event.note ? ` — ${event.note}` : ''}
                </li>)}
              </ol>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={onNavigate}>Open related workflow</Button>
            {active && item.status === 'OPEN' && <Button variant="secondary" onClick={() => onTransition('ACKNOWLEDGE')}>Acknowledge</Button>}
            {active && <Button variant="secondary" onClick={() => onTransition('ASSIGN')}>Assign to me</Button>}
            {active && ([1,3,7] as const).map((days) => <Button variant="secondary" key={days} onClick={() => onTransition('SNOOZE', days)}>Snooze {days}d</Button>)}
            {active && <Button variant="success" onClick={() => onTransition('RESOLVE')}>Resolve</Button>}
            {active && <Button variant="danger" onClick={() => onTransition('DISMISS')}>Dismiss</Button>}
          </div>
          <p className="text-[11px] text-text-tertiary">Advice only. Opening a workflow does not pre-fill or execute a business action.</p>
        </div>
      )}
    </article>
  );
}

function destinationFor(item: IntelligenceItem): Destination {
  if (item.scope === 'COMPANY') return 'reports';
  if (item.sourceEntityType === 'variance_cases') return 'variance';
  if (item.sourceEntityType === 'sale_void_requests') return 'voidApprovals';
  if (item.sourceEntityType === 'stock_receipt_requests') return 'stockApprovals';
  if (item.sourceEntityType === 'customers') return 'customers';
  if (item.category === 'INVENTORY') return 'stocktake';
  if (item.category === 'PRICING' || item.modelKey === 'underpriced-lines') return 'settings';
  return 'reports';
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Button onClick={onClick} variant={active ? 'primary' : 'secondary'} aria-pressed={active}>{children}</Button>;
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div className="panel p-3"><div className="text-xs text-text-tertiary uppercase tracking-wider">{label}</div><div className="font-mono tnum text-lg mt-1">{value}</div></div>;
}

function humanLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function displayRationale(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value == null) return 'Not available';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
