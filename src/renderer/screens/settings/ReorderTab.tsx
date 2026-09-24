// ReorderTab — low-stock list per supplier + "Create draft PO" flow.
// SUPERVISOR can view; OWNER/FOUNDER can create the PO.

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Button } from '../../components/ui/button';
import { NativeSelect } from '../../components/ui/native-select';
import { Input } from '../../components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

interface Suggestion {
  productId: string; sku: string; productName: string;
  primarySupplierId: string | null; primarySupplierName: string | null;
  currentOnHand: number; reorderThreshold: number;
  suggestedQty: number; lastCostPesewas: number; suggestedLineValuePesewas: number;
}
interface SupplierLite { id: string; name: string; active: boolean }
interface Draft {
  id: string; poNumber: string; supplierId: string; supplierName: string;
  status: string; totalOrderedPesewas: number; lineCount: number; createdAt: string;
}

type SupplierFilter = 'all' | 'unassigned' | string;

export function ReorderTab() {
  const myRole = useSession((s) => s.workerRole);
  const isOwner = myRole === 'OWNER' || myRole === 'FOUNDER';
  const isViewer = isOwner || myRole === 'SUPERVISOR';

  const [suppliers, setSuppliers] = useState<SupplierLite[]>([]);
  const [filter, setFilter] = useState<SupplierFilter>('all');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  // Per-row override: cashier may want to bump suggested up or down.
  const [orderQty, setOrderQty] = useState<Record<string, number>>({});

  async function refresh() {
    if (!isViewer) return;
    setLoading(true); setError(null);
    const supplierFilter = filter === 'all' ? undefined : filter === 'unassigned' ? null : filter;
    const r = await counter.reorderSuggest(supplierFilter);
    if (!r.success) { setLoading(false); setError(r.error); return; }
    setSuggestions(r.data.suggestions);
    // Default the order qty to suggestedQty for each row.
    const qty: Record<string, number> = {};
    for (const s of r.data.suggestions) qty[s.productId] = s.suggestedQty;
    setOrderQty(qty);
    const d = await counter.reorderListDrafts();
    if (d.success) setDrafts(d.data.drafts);
    setLoading(false);
  }

  useEffect(() => {
    if (!isViewer) return;
    void (async () => {
      const r = await counter.listSuppliersForAdmin();
      if (r.success) setSuppliers(r.data.suppliers.filter((s: SupplierLite) => s.active));
    })();
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isViewer) {
    return (
      <div className="bg-bg-elevated border border-border-subtle p-6 rounded text-text-tertiary">
        Reorder suggestions are restricted to SUPERVISOR, OWNER, and FOUNDER roles.
      </div>
    );
  }

  // Group suggestions by supplier so a "Create PO for this supplier" button
  // makes sense — one PO per supplier per click.
  const groups = new Map<string, { supplierId: string | null; supplierName: string; rows: Suggestion[] }>();
  for (const s of suggestions) {
    const key = s.primarySupplierId ?? '__unassigned__';
    if (!groups.has(key)) {
      groups.set(key, {
        supplierId: s.primarySupplierId,
        supplierName: s.primarySupplierName ?? '(no primary supplier set)',
        rows: [],
      });
    }
    groups.get(key)!.rows.push(s);
  }

  async function createPOForSupplier(supplierId: string | null, rows: Suggestion[]) {
    if (!isOwner) { setError('Only OWNER or FOUNDER can create draft POs.'); return; }
    if (!supplierId) {
      setError('Set a primary supplier for these products first (Settings → Products → Edit).');
      return;
    }
    const lines = rows
      .map((r) => ({ productId: r.productId, quantity: orderQty[r.productId] ?? r.suggestedQty, unitCostPesewas: r.lastCostPesewas }))
      .filter((l) => l.quantity > 0);
    if (lines.length === 0) {
      setError('No lines selected. Set at least one quantity > 0.');
      return;
    }
    const r = await counter.reorderCreateDraftPO({ supplierId, lines });
    if (!r.success) { setError(r.error); return; }
    setInfo(`Draft PO ${r.data.poNumber} created — ${formatMoneyWithCurrency(r.data.totalOrderedPesewas)}.`);
    setError(null);
    await refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <label className="block">
          <span className="block text-xs text-text-tertiary mb-1 uppercase tracking-wider">Supplier filter</span>
          <NativeSelect value={filter} onChange={(e) => setFilter(e.target.value as SupplierFilter)}>
            <option value="all">— all suppliers —</option>
            <option value="unassigned">— no primary supplier —</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </NativeSelect>
        </label>
        <Button variant="primary" className="self-end" onClick={() => void refresh()}>
          {loading ? 'Loading…' : 'Refresh suggestions'}
        </Button>
        <div className="self-end text-text-tertiary text-xs ml-auto">
          {suggestions.length} item(s) at or below reorder threshold
        </div>
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      {info && <div className="bg-success/10 border border-success/40 text-success text-sm px-3 py-2 rounded">{info}</div>}

      {[...groups.values()].length === 0 && !loading && (
        <div className="bg-bg-elevated border border-border-subtle p-6 rounded text-text-tertiary text-sm">
          Nothing low. Either every product is well above its reorder threshold,
          or no products have a reorder threshold configured (Settings → Products → Edit).
        </div>
      )}

      {[...groups.values()].map((g) => (
        <div key={g.supplierId ?? '__unassigned__'} className="bg-bg-elevated rounded border border-border-subtle">
          <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
            <div>
              <div className="font-semibold">{g.supplierName}</div>
              <div className="text-xs text-text-tertiary">{g.rows.length} product(s) low</div>
            </div>
            {isOwner && g.supplierId && (
              <Button variant="primary" onClick={() => void createPOForSupplier(g.supplierId, g.rows)}>
                Create draft PO
              </Button>
            )}
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-3">SKU</TableHead>
                  <TableHead className="px-3">Product</TableHead>
                  <TableHead className="text-right px-3">On hand</TableHead>
                  <TableHead className="text-right px-3">Threshold</TableHead>
                  <TableHead className="text-right px-3">Suggested</TableHead>
                  <TableHead className="text-right px-3">Order qty</TableHead>
                  <TableHead className="text-right px-3">Last cost</TableHead>
                  <TableHead className="text-right px-3">Line value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.rows.map((r) => {
                  const qty = orderQty[r.productId] ?? r.suggestedQty;
                  const value = qty * r.lastCostPesewas;
                  const onHandClass =
                    r.currentOnHand <= 0 ? 'text-danger' :
                    r.currentOnHand < r.reorderThreshold / 2 ? 'text-warning' : '';
                  return (
                    <TableRow key={r.productId}>
                      <TableCell className="px-3 py-2 font-mono text-xs">{r.sku}</TableCell>
                      <TableCell className="px-3 py-2">{r.productName}</TableCell>
                      <TableCell className={`px-3 py-2 text-right tabular-nums ${onHandClass}`}>
                        {r.currentOnHand}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-right tabular-nums text-text-tertiary">
                        {r.reorderThreshold}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-right tabular-nums text-text-secondary">
                        {r.suggestedQty}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-right">
                        <Input className="w-20 text-right tabular-nums h-8 px-2" type="number" min={0} value={qty}
                          onChange={(e) => setOrderQty((prev) => ({ ...prev, [r.productId]: parseInt(e.target.value || '0', 10) }))} />
                      </TableCell>
                      <TableCell className="px-3 py-2 text-right tabular-nums text-text-tertiary">
                        {formatMoneyWithCurrency(r.lastCostPesewas)}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-right tabular-nums">
                        {formatMoneyWithCurrency(value)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}

      {drafts.length > 0 && (
        <div className="bg-bg-elevated rounded border border-border-subtle">
          <div className="px-4 py-3 border-b border-border-subtle">
            <div className="font-semibold">Draft purchase orders ({drafts.length})</div>
            <div className="text-xs text-text-tertiary">Created but not yet placed. Use the PO flow to advance them.</div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-3">PO #</TableHead>
                <TableHead className="px-3">Supplier</TableHead>
                <TableHead className="text-right px-3">Lines</TableHead>
                <TableHead className="text-right px-3">Total</TableHead>
                <TableHead className="px-3">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drafts.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="px-3 py-2 font-mono text-xs">{d.poNumber}</TableCell>
                  <TableCell className="px-3 py-2">{d.supplierName}</TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">{d.lineCount}</TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">{formatMoneyWithCurrency(d.totalOrderedPesewas)}</TableCell>
                  <TableCell className="px-3 py-2 text-text-tertiary text-xs">{new Date(d.createdAt).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
