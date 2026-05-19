// StockReceiveScreen: ad-hoc supplier delivery flow.
// Pick supplier, build line items, supervisor PIN at the end.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { SupervisorPinModal } from '../components/SupervisorPinModal';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';

interface Supplier { id: string; name: string; paymentTermsDays: number; currentBalancePesewas: number }
interface ProductHit { id: string; sku: string; name: string; costPricePesewas: number; unitsOnHand: number }

interface DraftLine {
  productId: string; productName: string; productSku: string;
  unitId: string | null; unitName: string; conversionFactor: number;
  quantity: number; unitCostPesewas: number;
}

export default function StockReceiveScreen({ onExit }: { onExit: () => void }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState<string>('');
  const [isOpeningStock, setIsOpeningStock] = useState<boolean>(false);
  const [productQuery, setProductQuery] = useState('');
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [pendingProduct, setPendingProduct] = useState<ProductHit | null>(null);
  const [pendingProductUnits, setPendingProductUnits] = useState<Array<{ id: string; unitName: string; conversionFactor: number; pricePesewas: number; isPurchaseUnit: boolean; active: boolean }>>([]);
  const [pendingUnitId, setPendingUnitId] = useState<string | null>(null);
  const [pendingQty, setPendingQty] = useState(0);
  const [pendingCost, setPendingCost] = useState('');
  const [notes, setNotes] = useState('');
  const [askingSupervisor, setAskingSupervisor] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await counter.listSuppliers();
      if (r.success) {
        setSuppliers(r.data.suppliers);
        if (r.data.suppliers[0]) setSupplierId(r.data.suppliers[0].id);
      }
    })();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') {
        e.preventDefault();
        if (askingSupervisor) setAskingSupervisor(false); else onExit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askingSupervisor, onExit]);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await counter.searchProducts(productQuery, 'WALK_IN', 12);
      if (cancelled) return;
      if (r.success) setHits(r.data.products);
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [productQuery]);

  // Fetch purchase units for the selected product whenever it changes.
  useEffect(() => {
    let cancelled = false;
    if (!pendingProduct) { setPendingProductUnits([]); setPendingUnitId(null); return; }
    void (async () => {
      const r = await counter.listProductUnits(pendingProduct.id, true);
      if (cancelled) return;
      if (r.success) {
        const purch = r.data.units.filter((u: { isPurchaseUnit: boolean }) => u.isPurchaseUnit);
        setPendingProductUnits(purch as typeof pendingProductUnits);
        // Default to the largest purchase unit (highest factor) — feels like wholesale.
        const sorted = [...purch].sort((a: any, b: any) => b.conversionFactor - a.conversionFactor);
        setPendingUnitId(sorted[0]?.id ?? null);
      }
    })();
    return () => { cancelled = true; };
  }, [pendingProduct]);

  // Re-derive the cost field whenever the chosen unit changes. The cost
  // stored on the product is per CANONICAL unit (smallest piece) — when the
  // user is receiving in a larger unit (e.g. PACK × 2), the displayed cost
  // must be scaled up so they enter what they actually paid per pack, not
  // per single piece. Without this the user types "49" thinking it's per
  // pack and the system silently records half the true cost.
  useEffect(() => {
    if (!pendingProduct) return;
    const unit = pendingProductUnits.find((u) => u.id === pendingUnitId);
    const factor = unit?.conversionFactor ?? 1;
    setPendingCost(formatMoney(pendingProduct.costPricePesewas * factor));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingUnitId, pendingProduct?.id, pendingProductUnits.length]);

  function addPendingToList() {
    if (!pendingProduct) return;
    const cost = parseCedisToPesewas(pendingCost);
    if (pendingQty < 1 || cost === null) {
      setError('Quantity and cost both required.'); return;
    }
    const unit = pendingProductUnits.find((u) => u.id === pendingUnitId) ?? null;
    setLines((prev) => [...prev, {
      productId: pendingProduct.id, productName: pendingProduct.name, productSku: pendingProduct.sku,
      unitId: unit?.id ?? null,
      unitName: unit?.unitName ?? 'UNIT',
      conversionFactor: unit?.conversionFactor ?? 1,
      quantity: pendingQty, unitCostPesewas: cost,
    }]);
    setPendingProduct(null); setPendingQty(0); setPendingCost(''); setProductQuery('');
    setError(null);
  }
  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  const totalValue = lines.reduce((s, l) => s + l.quantity * l.unitCostPesewas, 0);

  async function approve(supervisorWorkerId: string, supervisorPin: string) {
    if (lines.length === 0) { setError('Add at least one line.'); return; }
    if (!isOpeningStock && !supplierId) { setError('Pick a supplier.'); return; }
    setSubmitting(true);
    setError(null);
    const r = await counter.receiveStock({
      supplierId: isOpeningStock ? null : supplierId,
      isOpeningStock,
      supervisorWorkerId, supervisorPin,
      lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCostPesewas: l.unitCostPesewas, unitId: l.unitId })),
      notes: notes.trim() || null,
    });
    setSubmitting(false);
    setAskingSupervisor(false);
    if (!r.success) { setError(r.error); return; }
    setInfo(`Received ${r.data.movementCount} line(s) worth ${formatMoneyWithCurrency(r.data.totalValuePesewas)}. ${r.data.productsCostUpdated} cost(s) updated.`);
    setLines([]); setNotes('');
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="receive stock" />
      <main className="flex-1 max-w-4xl w-full mx-auto px-12 py-8 flex flex-col gap-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">Stock receipt</h2>
          <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
        </div>
        {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-text-secondary text-sm">
            <input type="checkbox" checked={isOpeningStock} onChange={(e) => setIsOpeningStock(e.target.checked)} />
            Opening stock entry (no supplier — OWNER/FOUNDER only)
          </label>
        </div>

        {!isOpeningStock && (
          <>
            <label className="text-text-secondary text-xs uppercase tracking-wider">Supplier</label>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}
              className="bg-bg-input border border-border-strong px-4 py-3 text-text-primary">
              {suppliers.length === 0 && <option value="">— no suppliers configured —</option>}
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} {s.currentBalancePesewas > 0 ? `· owe ${formatMoney(s.currentBalancePesewas)}` : ''}
                </option>
              ))}
            </select>
          </>
        )}

        {isOpeningStock && (
          <div className="bg-bg-surface border border-warning/40 text-warning text-sm px-4 py-3">
            <strong>Opening stock mode:</strong> use this to seed initial inventory on a fresh install.
            No supplier is recorded; movements get reason <code>OPENING_STOCK</code>. Requires
            an OWNER or FOUNDER PIN to confirm.
          </div>
        )}

        <h3 className="text-text-secondary uppercase tracking-wider text-xs mt-2">Lines</h3>
        <div className="bg-bg-surface border border-border">
          <table className="w-full">
            <thead>
              <tr className="text-text-secondary text-xs uppercase tracking-wider">
                <th className="px-4 py-2 text-left">Product</th>
                <th className="px-4 py-2 text-right">Qty</th>
                <th className="px-4 py-2 text-right">Cost / unit</th>
                <th className="px-4 py-2 text-right">Line total</th>
                <th></th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {lines.map((l, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-4 py-2">{l.productName} <span className="text-text-tertiary text-xs">{l.productSku} · {l.unitName}{l.conversionFactor > 1 ? ` (×${l.conversionFactor})` : ''}</span></td>
                  <td className="px-4 py-2 text-right font-mono tnum">{l.quantity}</td>
                  <td className="px-4 py-2 text-right font-mono tnum">{formatMoney(l.unitCostPesewas)}</td>
                  <td className="px-4 py-2 text-right font-mono tnum">{formatMoney(l.quantity * l.unitCostPesewas)}</td>
                  <td className="px-2 py-2 text-right">
                    <button onClick={() => removeLine(i)} className="text-text-tertiary hover:text-danger text-xs">remove</button>
                  </td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-3 text-text-tertiary text-center">No lines yet.</td></tr>
              )}
              <tr className="border-t border-border bg-bg-deep">
                <td className="px-4 py-2 text-text-secondary uppercase tracking-wider text-xs" colSpan={3}>Total</td>
                <td className="px-4 py-2 text-right font-mono tnum text-text-primary">{formatMoney(totalValue)}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="bg-bg-surface border border-border p-5 flex flex-col gap-3">
          <h4 className="text-text-secondary uppercase tracking-wider text-xs">Add line</h4>
          <input value={productQuery} onChange={(e) => setProductQuery(e.target.value)}
            placeholder="Search product…" className="bg-bg-input border border-border-strong px-4 py-2" />
          <ul className="max-h-32 overflow-y-auto">
            {hits.slice(0, 5).map((p) => (
              <li key={p.id}>
                <button onClick={() => { setPendingProduct(p); setPendingQty(0); }}
                  className={`w-full text-left px-3 py-2 flex justify-between border-b border-border ${pendingProduct?.id === p.id ? 'bg-bg-elevated' : 'hover:bg-bg-elevated'}`}>
                  <span>{p.name} <span className="text-text-tertiary text-xs">{p.sku}</span></span>
                  <span className="text-text-tertiary text-sm" title="Per smallest unit (canonical). Cost field below will scale to the chosen receive unit.">
                    last cost {formatMoney(p.costPricePesewas)}<span className="opacity-50"> / single</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {pendingProduct && (
            <div className="grid grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
              <div>
                <label className="text-text-secondary text-xs uppercase tracking-wider">Unit</label>
                <select value={pendingUnitId ?? ''} onChange={(e) => setPendingUnitId(e.target.value || null)}
                  className="w-full bg-bg-input border border-border-strong px-3 py-2">
                  {pendingProductUnits.length === 0 && <option value="">(no purchase units)</option>}
                  {pendingProductUnits.map((u) => (
                    <option key={u.id} value={u.id}>{u.unitName} (× {u.conversionFactor})</option>
                  ))}
                </select>
              </div>
              <div className="w-20">
                <label className="text-text-secondary text-xs uppercase tracking-wider">Qty</label>
                <input type="number" min={1} value={pendingQty || ''} onChange={(e) => setPendingQty(Number(e.target.value))}
                  className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
              </div>
              <div className="w-36">
                <label className="text-text-secondary text-xs uppercase tracking-wider">
                  Cost / {pendingProductUnits.find((u) => u.id === pendingUnitId)?.unitName ?? 'unit'} (₵)
                </label>
                <input value={pendingCost} onChange={(e) => setPendingCost(e.target.value)}
                  className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
              </div>
              <button onClick={addPendingToList}
                className="bg-accent text-bg-deep px-4 py-2 font-semibold hover:bg-accent-light">
                Add line
              </button>
            </div>
          )}
        </div>

        <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)" className="bg-bg-input border border-border-strong px-3 py-2 text-sm" rows={2} />

        {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}

        <div className="flex gap-3">
          <button onClick={onExit} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
          <button
            onClick={() => setAskingSupervisor(true)}
            disabled={submitting || lines.length === 0 || (!isOpeningStock && !supplierId)}
            className="bg-accent text-bg-deep px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
            Confirm with supervisor
          </button>
        </div>
        {askingSupervisor && (
          <SupervisorPinModal
            title="Approve stock receipt"
            onCancel={() => setAskingSupervisor(false)}
            onApprove={approve}
          />
        )}
      </main>
    </div>
  );
}
