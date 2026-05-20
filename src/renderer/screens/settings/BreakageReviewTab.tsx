// BreakageReviewTab — review past breakage with photos.
// SUPERVISOR/OWNER/FOUNDER only.

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';

interface Row {
  id: string; productId: string; productName: string; productSku: string;
  quantity: number; cause: string; causeDescription: string | null;
  workerId: string; workerName: string; workerRole: string;
  photoRelativePath: string; totalLossPesewas: number;
  deductedFromWages: boolean; supervisorApprovalId: string | null;
  createdAt: string;
}

export function BreakageReviewTab() {
  const myRole = useSession((s) => s.workerRole);
  const isReviewer = myRole === 'SUPERVISOR' || myRole === 'OWNER' || myRole === 'FOUNDER';

  const [rows, setRows] = useState<Row[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [totalLoss, setTotalLoss] = useState(0);
  const [causes, setCauses] = useState<string[]>([]);
  const [workers, setWorkers] = useState<Array<{ id: string; fullName: string; role: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openPhoto, setOpenPhoto] = useState<{ src: string; row: Row } | null>(null);

  const [filterWorker, setFilterWorker] = useState('');
  const [filterCause, setFilterCause] = useState('');
  const [filterFromDate, setFilterFromDate] = useState('');
  const [filterToDate, setFilterToDate] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 30;

  async function refresh() {
    if (!isReviewer) return;
    setLoading(true);
    setError(null);
    const r = await counter.reviewBreakage({
      workerId: filterWorker || null,
      cause: filterCause || null,
      fromDate: filterFromDate || null,
      toDate: filterToDate || null,
      limit: PAGE_SIZE, offset: page * PAGE_SIZE,
    });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setRows(r.data.rows);
    setTotalCount(r.data.totalCount);
    setTotalLoss(r.data.totalLossPesewas);
  }

  useEffect(() => {
    if (!isReviewer) return;
    void (async () => {
      const [c, w] = await Promise.all([
        counter.reviewBreakageCauses(),
        counter.adminListWorkers(),
      ]);
      if (c.success) setCauses(c.data.causes);
      if (w.success) setWorkers(w.data.workers);
    })();
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isReviewer) {
    return (
      <div className="bg-bg-elevated border border-border-subtle p-6 rounded text-text-tertiary">
        Breakage review is restricted to SUPERVISOR, OWNER, and FOUNDER roles.
      </div>
    );
  }

  async function openPhotoFor(row: Row) {
    const r = await counter.getBreakagePhoto(row.photoRelativePath);
    if (!r.success || !r.data.found || !r.data.dataUri) {
      setError(r.success ? 'Photo not found on disk.' : r.error);
      return;
    }
    setOpenPhoto({ src: r.data.dataUri, row });
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-5 gap-3">
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Worker</span>
          <select value={filterWorker} onChange={(e) => setFilterWorker(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm">
            <option value="">— anyone —</option>
            {workers.map((w) => <option key={w.id} value={w.id}>{w.fullName} ({w.role})</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Cause</span>
          <select value={filterCause} onChange={(e) => setFilterCause(e.target.value)}
            className="w-full px-3 py-2 rounded bg-bg-deep border border-border-subtle text-sm">
            <option value="">— any —</option>
            {causes.map((c) => <option key={c} value={c}>{c}</option>)}
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
        <div className="flex items-end gap-2">
          <button onClick={() => { setPage(0); void refresh(); }}
            className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light text-sm">
            Apply
          </button>
          <button onClick={() => {
            setFilterWorker(''); setFilterCause(''); setFilterFromDate(''); setFilterToDate('');
            setPage(0); setTimeout(() => void refresh(), 0);
          }}
            className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">
            Reset
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between text-sm">
        <div className="text-text-secondary">
          {totalCount.toLocaleString()} events · total loss <span className="text-warning font-semibold">{formatMoneyWithCurrency(totalLoss)}</span>
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2 text-text-tertiary">
            <button disabled={page === 0}
              onClick={() => { setPage(p => Math.max(0, p - 1)); setTimeout(() => void refresh(), 0); }}
              className="px-3 py-1 border border-border disabled:opacity-30">prev</button>
            <span>{page + 1} / {totalPages}</span>
            <button disabled={page + 1 >= totalPages}
              onClick={() => { setPage(p => p + 1); setTimeout(() => void refresh(), 0); }}
              className="px-3 py-1 border border-border disabled:opacity-30">next</button>
          </div>
        )}
      </div>

      {error && <div className="bg-danger/10 border border-danger/40 text-danger text-sm px-3 py-2 rounded">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        {loading && <div className="col-span-full text-center text-text-tertiary py-6">Loading…</div>}
        {!loading && rows.length === 0 && (
          <div className="col-span-full text-center text-text-tertiary py-6">No breakage events match.</div>
        )}
        {rows.map((r) => (
          <BreakageCard key={r.id} row={r} onOpenPhoto={() => void openPhotoFor(r)} />
        ))}
      </div>

      {openPhoto && (
        <div onClick={() => setOpenPhoto(null)}
          className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-6 cursor-pointer">
          <div className="max-w-4xl max-h-full flex flex-col gap-2">
            <img src={openPhoto.src} alt="breakage"
              className="max-w-full max-h-[85vh] rounded shadow-2xl object-contain" />
            <div className="text-text-secondary text-sm text-center">
              {openPhoto.row.productName} · qty {openPhoto.row.quantity} ·
              loss {formatMoneyWithCurrency(openPhoto.row.totalLossPesewas)} ·
              by {openPhoto.row.workerName} · {new Date(openPhoto.row.createdAt).toLocaleString()}
            </div>
            <div className="text-text-tertiary text-xs text-center">click anywhere to close</div>
          </div>
        </div>
      )}
    </div>
  );
}

function BreakageCard({ row, onOpenPhoto }: { row: Row; onOpenPhoto: () => void }) {
  const [thumbSrc, setThumbSrc] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const r = await counter.getBreakagePhoto(row.photoRelativePath);
      if (r.success && r.data.found && r.data.dataUri) setThumbSrc(r.data.dataUri);
    })();
  }, [row.photoRelativePath]);

  return (
    <div className="bg-bg-elevated border border-border-subtle rounded overflow-hidden">
      <button onClick={onOpenPhoto} className="block w-full bg-bg-deep aspect-video relative group">
        {thumbSrc
          ? <img src={thumbSrc} alt="breakage thumb" className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center text-text-tertiary text-xs">loading photo…</div>}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center text-white opacity-0 group-hover:opacity-100 text-xs">
          click to enlarge
        </div>
      </button>
      <div className="p-3 space-y-1 text-sm">
        <div className="font-medium">{row.productName}</div>
        <div className="text-text-tertiary text-xs">{row.productSku} · qty {row.quantity}</div>
        <div className="flex justify-between items-center pt-1">
          <span className="text-warning font-semibold">{formatMoneyWithCurrency(row.totalLossPesewas)}</span>
          <span className="text-text-tertiary text-xs">{row.cause}</span>
        </div>
        <div className="text-xs text-text-tertiary pt-1 border-t border-border-subtle/50">
          {row.workerName} · {new Date(row.createdAt).toLocaleDateString()}
          {row.deductedFromWages && <span className="ml-2 text-warning">deducted</span>}
        </div>
      </div>
    </div>
  );
}
