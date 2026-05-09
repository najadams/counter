// StocktakeScreen: list recent + start new + count flow + complete with supervisor.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { SupervisorPinModal } from '../components/SupervisorPinModal';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';

interface ActiveStocktake {
  id: string; status: string; startedAt: string;
  productsCounted: number; productsWithVariance: number;
  totalLossValuePesewas: number; totalFoundValuePesewas: number;
  totalExpectedStockValuePesewas: number; shrinkageRate: number | null;
  notes: string | null;
}
interface Line {
  id: string; productId: string; productName: string; productSku: string;
  expectedQty: number; countedQty: number | null; variance: number | null;
  unitCostPesewas: number; varianceValuePesewas: number | null;
}

export default function StocktakeScreen({ onExit }: { onExit: () => void }) {
  const [active, setActive] = useState<ActiveStocktake | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [recent, setRecent] = useState<ActiveStocktake[]>([]);
  const [draftCounts, setDraftCounts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');
  const [askingSupervisor, setAskingSupervisor] = useState(false);
  const [completionNotes, setCompletionNotes] = useState('');
  const [unitChoices, setUnitChoices] = useState<Record<string, string>>({}); // productId -> unitId
  const [unitOptions, setUnitOptions] = useState<Record<string, Array<{ id: string; unitName: string; conversionFactor: number }>>>({}); // productId -> available units
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchUnitsFor(productId: string) {
    if (unitOptions[productId]) return;
    const r = await counter.listProductUnits(productId, true);
    if (r.success) {
      setUnitOptions((prev) => ({ ...prev, [productId]: r.data.units.map((u: { id: string; unitName: string; conversionFactor: number }) => ({ id: u.id, unitName: u.unitName, conversionFactor: u.conversionFactor })) }));
    }
  }

  async function refresh() {
    const a = await counter.getActiveStocktake();
    if (a.success) {
      setActive(a.data.active as ActiveStocktake | null);
      if (a.data.active) {
        const r = await counter.getStocktakeWithLines((a.data.active as ActiveStocktake).id);
        if (r.success) setLines(r.data.lines as Line[]);
      } else {
        setLines([]);
      }
      // Fetch unit options for each line so the per-row dropdown can render.
      if (a.success && a.data.active) {
        const r = await counter.getStocktakeWithLines((a.data.active as ActiveStocktake).id);
        if (r.success) {
          for (const l of r.data.lines as Line[]) {
            void fetchUnitsFor(l.productId);
          }
        }
      }
    }
    const list = await counter.listRecentStocktakes();
    if (list.success) setRecent(list.data.events.filter((e: ActiveStocktake) => e.status !== 'DRAFT') as ActiveStocktake[]);
  }
  useEffect(() => {
    void refresh();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') {
        e.preventDefault();
        if (askingSupervisor) setAskingSupervisor(false); else onExit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askingSupervisor, onExit]);

  const [startClass, setStartClass] = useState<'' | 'A' | 'B' | 'C'>('');

  async function start() {
    setError(null);
    const r = await counter.startStocktake(startClass || null);
    if (!r.success) { setError(r.error); return; }
    setInfo(
      startClass
        ? `Started cycle count for class ${startClass} (${r.data.productCount} products).`
        : `Started full stocktake (${r.data.productCount} products to count).`,
    );
    await refresh();
  }

  async function saveCount(productId: string) {
    if (!active) return;
    const v = draftCounts[productId];
    const n = v == null || v === '' ? null : Number(v);
    if (n == null || !Number.isInteger(n) || n < 0) {
      setError('Counted quantity must be a non-negative integer.');
      return;
    }
    setError(null);
    const unitId = unitChoices[productId] || null;
    const r = await counter.recordStocktakeLine({ eventId: active.id, productId, countedQty: n, unitId });
    if (!r.success) { setError(r.error); return; }
    setLines((prev) => prev.map((l) =>
      l.productId === productId
        ? { ...l, countedQty: r.data.canonicalCount, variance: r.data.variance, varianceValuePesewas: r.data.varianceValuePesewas }
        : l,
    ));
    setDraftCounts((prev) => { const c = { ...prev }; delete c[productId]; return c; });
  }

  async function cancel() {
    if (!active) return;
    if (!confirm('Cancel this stocktake? All counts will be discarded.')) return;
    const r = await counter.cancelStocktake(active.id);
    if (!r.success) { setError(r.error); return; }
    setInfo('Stocktake cancelled.');
    await refresh();
  }

  async function approve(supervisorWorkerId: string, supervisorPin: string) {
    if (!active) return;
    setError(null);
    const r = await counter.completeStocktake({
      eventId: active.id, supervisorWorkerId, supervisorPin,
      notes: completionNotes.trim() || null,
    });
    setAskingSupervisor(false);
    if (!r.success) { setError(r.error); return; }
    const rate = r.data.shrinkageRate;
    setInfo(`Stocktake complete. ${r.data.movementsEmitted} variance movement(s) emitted. Loss: ${formatMoneyWithCurrency(r.data.totalLossValuePesewas)}, found: ${formatMoneyWithCurrency(r.data.totalFoundValuePesewas)}, shrinkage rate: ${rate == null ? '—' : (rate * 100).toFixed(2) + '%'}.`);
    setCompletionNotes('');
    await refresh();
  }

  const filteredLines = lines.filter((l) =>
    !filter || l.productName.toLowerCase().includes(filter.toLowerCase()) ||
    l.productSku.toLowerCase().includes(filter.toLowerCase()),
  );

  const counted = lines.filter((l) => l.countedQty !== null).length;
  const total = lines.length;
  const uncounted = total - counted;

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="stocktake" />
      <main className="flex-1 max-w-6xl w-full mx-auto px-12 py-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">Physical stocktake</h2>
          <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
        </div>

        {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}
        {error && <div className="bg-bg-surface border border-danger px-5 py-3 text-danger text-sm">{error}</div>}

        {!active && (
          <div className="bg-bg-surface border border-border p-6 flex items-center justify-between">
            <div>
              <div className="text-text-primary">No active stocktake.</div>
              <div className="text-text-tertiary text-sm mt-1">Start one to capture physical counts and compute shrinkage rate.</div>
            </div>
            <div className="flex items-center gap-3">
              <select value={startClass} onChange={(e) => setStartClass(e.target.value as 'A' | 'B' | 'C' | '')}
                className="bg-bg-input border border-border-strong px-3 py-2 text-sm">
                <option value="">All products (full count)</option>
                <option value="A">Class A only (top sellers)</option>
                <option value="B">Class B only</option>
                <option value="C">Class C only (long tail)</option>
              </select>
              <button onClick={() => void start()}
                className="bg-accent text-bg-deep px-5 py-3 font-semibold hover:bg-accent-light">
                Start stocktake
              </button>
            </div>
          </div>
        )}

        {active && (
          <>
            <div className="bg-bg-surface border border-border p-4 grid grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-text-secondary uppercase tracking-wider text-xs">Counted</div>
                <div className="font-mono tnum text-2xl">{counted} / {total}</div>
              </div>
              <div>
                <div className="text-text-secondary uppercase tracking-wider text-xs">With variance</div>
                <div className="font-mono tnum text-2xl">{lines.filter((l) => l.variance !== null && l.variance !== 0).length}</div>
              </div>
              <div>
                <div className="text-text-secondary uppercase tracking-wider text-xs">Running loss</div>
                <div className="font-mono tnum text-2xl text-danger">
                  {formatMoneyWithCurrency(lines.reduce((s, l) => s + (l.varianceValuePesewas != null && l.varianceValuePesewas < 0 ? -l.varianceValuePesewas : 0), 0))}
                </div>
              </div>
              <div>
                <div className="text-text-secondary uppercase tracking-wider text-xs">Running found</div>
                <div className="font-mono tnum text-2xl text-success">
                  {formatMoneyWithCurrency(lines.reduce((s, l) => s + (l.varianceValuePesewas != null && l.varianceValuePesewas > 0 ? l.varianceValuePesewas : 0), 0))}
                </div>
              </div>
            </div>

            <input value={filter} onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter products…"
              className="bg-bg-input border border-border-strong px-4 py-2" />

            <div className="bg-bg-surface border border-border overflow-y-auto" style={{ maxHeight: '50vh' }}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-text-secondary text-xs uppercase tracking-wider sticky top-0 bg-bg-surface">
                    <th className="px-4 py-3 text-left">Product</th>
                    <th className="px-4 py-3 text-right">Expected</th>
                    <th className="px-4 py-3 text-right">Counted</th>
                    <th className="px-4 py-3 text-right">Variance</th>
                    <th className="px-4 py-3 text-right">Δ value</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLines.map((l) => {
                    const draft = draftCounts[l.productId];
                    const tone = l.variance == null ? 'text-text-tertiary'
                      : l.variance < 0 ? 'text-danger' : l.variance > 0 ? 'text-warning' : 'text-success';
                    const opts = unitOptions[l.productId] ?? [];
                    const chosen = unitChoices[l.productId] || '';
                    const factor = opts.find((u) => u.id === chosen)?.conversionFactor ?? 1;
                    return (
                      <tr key={l.id} className="border-t border-border">
                        <td className="px-4 py-2">
                          {l.productName}
                          <span className="text-text-tertiary text-xs ml-2">{l.productSku}</span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono tnum">{l.expectedQty}</td>
                        <td className="px-4 py-2 text-right">
                          <div className="flex items-center gap-1 justify-end">
                            <input
                              value={draft ?? (l.countedQty == null ? '' : String(factor === 1 ? l.countedQty : Math.floor(l.countedQty / factor)))}
                              onChange={(e) => setDraftCounts((p) => ({ ...p, [l.productId]: e.target.value }))}
                              onKeyDown={(e) => { if (e.key === 'Enter') void saveCount(l.productId); }}
                              onBlur={() => { if (draft != null) void saveCount(l.productId); }}
                              className="w-20 bg-bg-input border border-border-strong px-2 py-1 font-mono tnum text-right" />
                            {opts.length > 1 && (
                              <select value={chosen}
                                onChange={(e) => setUnitChoices((p) => ({ ...p, [l.productId]: e.target.value }))}
                                className="bg-bg-input border border-border-strong px-1 py-1 text-xs">
                                {opts.map((o) => (
                                  <option key={o.id} value={o.id}>{o.unitName}{o.conversionFactor > 1 ? ` ×${o.conversionFactor}` : ''}</option>
                                ))}
                              </select>
                            )}
                          </div>
                        </td>
                        <td className={`px-4 py-2 text-right font-mono tnum ${tone}`}>
                          {l.variance == null ? '—' : (l.variance > 0 ? '+' : '') + l.variance}
                        </td>
                        <td className={`px-4 py-2 text-right font-mono tnum ${tone}`}>
                          {l.varianceValuePesewas == null ? '—' : (l.varianceValuePesewas >= 0 ? '+' : '') + formatMoney(l.varianceValuePesewas)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <textarea value={completionNotes} onChange={(e) => setCompletionNotes(e.target.value)}
              placeholder="Notes for the completion (optional)"
              className="bg-bg-input border border-border-strong px-3 py-2 text-sm" rows={2} />

            <div className="flex gap-3 items-center justify-between">
              <button onClick={() => void cancel()} className="px-5 py-3 border border-border hover:bg-bg-elevated text-text-tertiary">
                Cancel stocktake
              </button>
              {uncounted > 0 && (
                <span className="text-warning text-sm">
                  {uncounted} product(s) un-counted — they will be skipped (no variance recorded).
                </span>
              )}
              <button onClick={() => setAskingSupervisor(true)}
                className="bg-accent text-bg-deep px-5 py-3 font-semibold hover:bg-accent-light">
                Complete with supervisor
              </button>
            </div>
            {askingSupervisor && (
              <SupervisorPinModal
                title="Approve stocktake completion"
                onCancel={() => setAskingSupervisor(false)}
                onApprove={approve}
              />
            )}
          </>
        )}

        <h2 className="text-text-secondary uppercase tracking-wider text-xs mt-6">Recent stocktakes</h2>
        <div className="bg-bg-surface border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-xs uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Completed</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">Counted</th>
                <th className="px-4 py-3 text-right">Loss</th>
                <th className="px-4 py-3 text-right">Found</th>
                <th className="px-4 py-3 text-right">Shrinkage</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-4 py-2 font-mono tnum">{(e as any).completedAt ? new Date((e as any).completedAt).toLocaleString() : '—'}</td>
                  <td className="px-4 py-2">{e.status}</td>
                  <td className="px-4 py-2 text-right font-mono tnum">{e.productsCounted}</td>
                  <td className="px-4 py-2 text-right font-mono tnum text-danger">{formatMoney(e.totalLossValuePesewas)}</td>
                  <td className="px-4 py-2 text-right font-mono tnum text-success">{formatMoney(e.totalFoundValuePesewas)}</td>
                  <td className="px-4 py-2 text-right font-mono tnum">
                    {e.shrinkageRate == null ? '—' : (e.shrinkageRate * 100).toFixed(2) + '%'}
                  </td>
                </tr>
              ))}
              {recent.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-4 text-text-tertiary text-center">None yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
