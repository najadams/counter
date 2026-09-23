// AuditLogTab — append-only audit log viewer for OWNER/FOUNDER.
// Filters: worker, action, entity_type, date range, free-text search.
// Click a row to expand and see before/after JSON snapshots.

import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Button } from '../../components/ui/button';
import { NativeSelect } from '../../components/ui/native-select';
import { Input } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

interface Entry {
  id: string; workerId: string; workerName: string; workerRole: string;
  action: string; entityType: string; entityId: string;
  entityName: string | null;
  beforeValue: unknown | null; afterValue: unknown | null;
  deviceId: string; notes: string | null; createdAt: string;
}
interface Worker { id: string; fullName: string; role: string; active: boolean }

export function AuditLogTab() {
  const myRole = useSession((s) => s.workerRole);
  const isViewer = myRole === 'OWNER' || myRole === 'FOUNDER';

  const [entries, setEntries] = useState<Entry[]>([]);
  const [idNames, setIdNames] = useState<Record<string, string>>({});
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
    setIdNames(r.data.idNames ?? {});
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
          <NativeSelect value={filterWorker} onChange={(e) => setFilterWorker(e.target.value)}>
            <option value="">— anyone —</option>
            <option value="sys-system">SYSTEM</option>
            {workers.map((w) => <option key={w.id} value={w.id}>{w.fullName} ({w.role})</option>)}
          </NativeSelect>
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Action</span>
          <NativeSelect value={filterAction} onChange={(e) => setFilterAction(e.target.value)}>
            <option value="">— any action —</option>
            {actions.map((a) => <option key={a} value={a}>{a}</option>)}
          </NativeSelect>
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Entity</span>
          <NativeSelect value={filterEntityType} onChange={(e) => setFilterEntityType(e.target.value)}>
            <option value="">— any —</option>
            {entityTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </NativeSelect>
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">From</span>
          <Input type="date" value={filterFromDate} onChange={(e) => setFilterFromDate(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">To</span>
          <Input type="date" value={filterToDate} onChange={(e) => setFilterToDate(e.target.value)} />
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Search</span>
          <Input value={filterSearch} onChange={(e) => setFilterSearch(e.target.value)}
            placeholder="text in notes/JSON…" />
        </label>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => { setPage(0); void refresh(); }}>
            Apply filters
          </Button>
          <Button onClick={() => {
            setFilterWorker(''); setFilterAction(''); setFilterEntityType('');
            setFilterFromDate(''); setFilterToDate(''); setFilterSearch('');
            setPage(0);
            setTimeout(() => void refresh(), 0);
          }}>
            Reset
          </Button>
        </div>
        <div className="flex items-center gap-3 text-sm text-text-tertiary">
          <span>{totalCount.toLocaleString()} entries</span>
          {totalPages > 1 && (
            <>
              <Button size="sm" disabled={page === 0}
                onClick={() => { setPage(p => Math.max(0, p - 1)); setTimeout(() => void refresh(), 0); }}>prev</Button>
              <span>page {page + 1} / {totalPages}</span>
              <Button size="sm" disabled={page + 1 >= totalPages}
                onClick={() => { setPage(p => p + 1); setTimeout(() => void refresh(), 0); }}>next</Button>
            </>
          )}
        </div>
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}

      <div className="bg-bg-elevated rounded border border-border-subtle overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-3">When</TableHead>
              <TableHead className="px-3">Worker</TableHead>
              <TableHead className="px-3">Action</TableHead>
              <TableHead className="px-3">Entity</TableHead>
              <TableHead className="px-3">Notes</TableHead>
              <TableHead className="px-3"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow><TableCell colSpan={6} className="px-4 py-6 text-center text-text-tertiary">Loading…</TableCell></TableRow>
            )}
            {!loading && entries.length === 0 && (
              <TableRow><TableCell colSpan={6} className="px-4 py-6 text-center text-text-tertiary">No entries match these filters.</TableCell></TableRow>
            )}
            {entries.map((e) => (
              <RowExpandable key={e.id} entry={e} idNames={idNames}
                expanded={expanded === e.id}
                onToggle={() => setExpanded(expanded === e.id ? null : e.id)} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// Recursively walk a JSON value and replace any string that's a known ID
// with "ID (Name)". Keeps the original ID visible — names are the readable
// part, IDs stay for traceability.
function annotateIds(value: unknown, idNames: Record<string, string>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const name = idNames[value];
    return name ? `${value}  (${name})` : value;
  }
  if (Array.isArray(value)) return value.map((v) => annotateIds(v, idNames));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = annotateIds(v, idNames);
    return out;
  }
  return value;
}

function RowExpandable({ entry, expanded, onToggle, idNames }: {
  entry: Entry; expanded: boolean; onToggle: () => void;
  idNames: Record<string, string>;
}) {
  const ts = new Date(entry.createdAt);
  const dateStr = ts.toLocaleString();
  // Friendly label for the entity column: prefer the resolved name; fall back
  // to the raw ID for entity types we don't know how to look up.
  const entityLabel = entry.entityName ?? entry.entityId;
  return (
    <>
      <TableRow className="cursor-pointer"
          onClick={onToggle}>
        <TableCell className="px-3 py-2 font-mono text-xs text-text-secondary">{dateStr}</TableCell>
        <TableCell className="px-3 py-2">
          <div>{entry.workerName}</div>
          <div className="text-xs text-text-tertiary">{entry.workerRole}</div>
        </TableCell>
        <TableCell className="px-3 py-2 font-medium">{entry.action}</TableCell>
        <TableCell className="px-3 py-2">
          <div className="text-text-secondary">{entry.entityType}</div>
          <div className="text-xs text-text-tertiary font-mono">{entityLabel}</div>
        </TableCell>
        <TableCell className="px-3 py-2 text-text-secondary">{entry.notes ?? '—'}</TableCell>
        <TableCell className="px-3 py-2 text-right text-text-tertiary text-xs">{expanded ? <ChevronUpIcon aria-label="Collapse" className="ml-auto size-4" /> : <ChevronDownIcon aria-label="Expand" className="ml-auto size-4" />}</TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-bg-deep/40">
          <TableCell colSpan={6} className="px-4 py-3">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs text-text-tertiary uppercase tracking-wider mb-1">Before</div>
                {entry.beforeValue
                  ? <pre className="text-xs bg-bg-deep rounded p-2 overflow-x-auto">{JSON.stringify(annotateIds(entry.beforeValue, idNames), null, 2)}</pre>
                  : <div className="text-text-tertiary text-sm italic">(none — create action)</div>}
              </div>
              <div>
                <div className="text-xs text-text-tertiary uppercase tracking-wider mb-1">After</div>
                {entry.afterValue
                  ? <pre className="text-xs bg-bg-deep rounded p-2 overflow-x-auto">{JSON.stringify(annotateIds(entry.afterValue, idNames), null, 2)}</pre>
                  : <div className="text-text-tertiary text-sm italic">(none — delete action)</div>}
              </div>
            </div>
            <div className="mt-2 text-xs text-text-tertiary">
              entry id: <span className="font-mono">{entry.id}</span> · device: <span className="font-mono">{entry.deviceId}</span>
              {entry.entityName && <> · entity: <span className="font-mono">{entry.entityId}</span></>}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
