// AuditLogTab — append-only audit log viewer for OWNER/FOUNDER.
// Filters: worker, action, entity_type, date range, free-text search.
// Click a row to expand and see before/after JSON snapshots.

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';

interface Entry {
  id: string; workerId: string; workerName: string; workerRole: string;
  action: string; entityType: string; entityId: string;
  beforeValue: unknown | null; afterValue: unknown | null;
  deviceId: string; notes: string | null; createdAt: string;
}
interface Worker { id: string; fullName: string; role: string; active: boolean }

export function AuditLogTab() {
  const myRole = useSession((s) => s.workerRole);
  const isViewer = myRole === 'OWNER' || myRole === 'FOUNDER';

  const [entries, setEntries] = useState<Entry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [actions, setActions] = useState<string[]>([]);
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  // Filters
  const [filterWorker, setFilterWorker] = useState<string>('');
  const [filterAction, setFilterAction] = useState<string>('');
  const [filterEntityType, setFilterEntityType] = useState<string>('');
  const [filterFromDate, setFilterFromDate] = useState<string>('');
  const [filterToDate, setFilterToDate] = useState<string>('');
  const [filterSearch, setFilterSearch] = useState<string>('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 100;

  async function refresh() {
    if (!isViewer) return;
    setLoading(true);
    setError(null);
    const r = await counter.listAuditEntries({
      workerId: filterWorker || null,
      action: filterAction || null,
      entityType: filterEntityType || null,
      fromDate: filterFromDate || null,
      toDate: filterToDate || null,
      search: filterSearch.trim() || null,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setEntries(r.data.entries);
    setTotalCount(r.data.totalCount);
  }

  useEffect(() => {
    if (!isViewer) return;
    void (async () => {
      const [a, e, w] = await Promise.all([
        counter.listAuditActions(),
        counter.listAuditEntityTypes(),
        counter.adminListWorkers(),
      ]);
      if (a.success) setActions(a.data.actions);
      if (e.success) setEntityTypes(e.data.entityTypes);
      if (w.success) setWorkers(w.data.workers);
    })();
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isViewer) {
    return (
      <div className="bg-bg-elevated border border-border-subtle p-6 rounded text-text-tertiary">
        Audit log is restricted to OWNER and FOUNDER roles.
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-6 gap-3">
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Worker</span>
          <select value={filterWorker} onChange={(e) => setFilterWorker(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm">
            <option value="">— anyone —</option>
            <option value="sys-system">SYSTEM</option>
            {workers.map((w) => <option key={w.id} value={w.id}>{w.fullName} ({w.role})</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Action</span>
          <select value={filterAction} onChange={(e) => setFilterAction(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm">
            <option value="">— any action —</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Entity</span>
          <select value={filterEntityType} onChange={(e) => setFilterEntityType(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm">
            <option value="">— any —</option>
            {entityTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">From</span>
          <input type="date" value={filterFromDate} onChange={(e) => setFilterFromDate(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm" />
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">To</span>
          <input type="date" value={filterToDate} onChange={(e) => setFilterToDate(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm" />
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Search</span>
          <input value={filterSearch} onChange={(e) => setFilterSearch(e.target.value)}
            placeholder="text in notes/JSON…"
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm" />
        </label>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <button onClick={() => { setPage(0); void refresh(); }}
            className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light text-sm">
            Apply filters
          </button>
          <button onClick={() => {
            setFilterWorker(''); setFilterAction(''); setFilterEntityType('');
            setFilterFromDate(''); setFilterToDate(''); setFilterSearch('');
            setPage(0);
            setTimeout(() => void refresh(), 0);
          }}
            className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">
            Reset
          </button>
        </div>
        <div className="flex items-center gap-3 text-sm text-text-tertiary">
          <span>{totalCount.toLocaleString()} entries</span>
          {totalPages > 1 && (
            <>
              <button disabled={page === 0}
                onClick={() => { setPage(p => Math.max(0, p - 1)); setTimeout(() => void refresh(), 0); }}
                className="px-3 py-1 border border-border disabled:opacity-30">prev</button>
              <span>page {page + 1} / {totalPages}</span>
              <button disabled={page + 1 >= totalPages}
                onClick={() => { setPage(p => p + 1); setTimeout(() => void refresh(), 0); }}
                className="px-3 py-1 border border-border disabled:opacity-30">next</button>
            </>
          )}
        </div>
      </div>

      {error && <div className="bg-danger/10 border border-danger/40 text-danger text-sm px-3 py-2 rounded">{error}</div>}

      <div className="bg-bg-elevated rounded border border-border-subtle overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-bg-deep text-text-tertiary uppercase text-xs">
            <tr>
              <th className="text-left px-3 py-2">When</th>
              <th className="text-left px-3 py-2">Worker</th>
              <th className="text-left px-3 py-2">Action</th>
              <th className="text-left px-3 py-2">Entity</th>
              <th className="text-left px-3 py-2">Notes</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-text-tertiary">Loading…</td></tr>
            )}
            {!loading && entries.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-text-tertiary">No entries match these filters.</td></tr>
            )}
            {entries.map((e) => (
              <RowExpandable key={e.id} entry={e}
                expanded={expanded === e.id}
                onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RowExpandable({ entry, expanded, onToggle }: {
  entry: Entry; expanded: boolean; onToggle: () => void;
}) {
  const ts = new Date(entry.createdAt);
  const dateStr = ts.toLocaleString();
  return (
    <>
      <tr className="border-t border-border-subtle hover:bg-bg-deep/40 cursor-pointer"
          onClick={onToggle}>
        <td className="px-3 py-2 font-mono text-xs text-text-secondary">{dateStr}</td>
        <td className="px-3 py-2">
          <div>{entry.workerName}</div>
          <div className="text-xs text-text-tertiary">{entry.workerRole}</div>
        </td>
        <td className="px-3 py-2 font-medium">{entry.action}</td>
        <td className="px-3 py-2">
          <div className="text-text-secondary">{entry.entityType}</div>
          <div className="text-xs text-text-tertiary font-mono">{entry.entityId}</div>
        </td>
        <td className="px-3 py-2 text-text-secondary">{entry.notes ?? '—'}</td>
        <td className="px-3 py-2 text-right text-text-tertiary text-xs">{expanded ? '▲' : '▼'}</td>
      </tr>
      {expanded && (
        <tr className="border-t border-border-subtle bg-bg-deep/40">
          <td colSpan={6} className="px-4 py-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-text-tertiary uppercase tracking-wider mb-1">Before</div>
                {entry.beforeValue
                  ? <pre className="text-xs bg-bg-deep rounded p-2 overflow-x-auto">{JSON.stringify(entry.beforeValue, null, 2)}</pre>
                  : <div className="text-text-tertiary text-sm italic">(none — create action)</div>}
              </div>
              <div>
                <div className="text-xs text-text-tertiary uppercase tracking-wider mb-1">After</div>
                {entry.afterValue
                  ? <pre className="text-xs bg-bg-deep rounded p-2 overflow-x-auto">{JSON.stringify(entry.afterValue, null, 2)}</pre>
                  : <div className="text-text-tertiary text-sm italic">(none — delete action)</div>}
              </div>
            </div>
            <div className="mt-2 text-xs text-text-tertiary">
              entry id: <span className="font-mono">{entry.id}</span> · device: <span className="font-mono">{entry.deviceId}</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
