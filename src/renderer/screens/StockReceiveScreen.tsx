// StockReceiveScreen: ad-hoc supplier delivery flow.
// Pick supplier, build line items, then submit an immutable approval request.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { useSession } from '../store/session';
import type { StockReceiptRequestSummary } from '../../shared/types/ipc';

interface Supplier { id: string; name: string; paymentTermsDays: number; currentBalancePesewas: number }
interface DraftPO { id: string; poNumber: string; supplierId: string; totalOrderedPesewas: number; lineCount: number; createdAt: string }
interface ProductHit { id: string; sku: string; name: string; costPricePesewas: number; unitsOnHand: number }

interface DraftLine {
  productId: string; productName: string; productSku: string;
  unitId: string | null; unitName: string; conversionFactor: number;
  quantity: number; unitCostPesewas: number;
}

export default function StockReceiveScreen({ onExit }: { onExit: () => void }) {
  const workerRole = useSession((state) => state.workerRole);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [draftPOs, setDraftPOs] = useState<DraftPO[]>([]);
  const [supplierId, setSupplierId] = useState<string>('');
  const [purchaseOrderId, setPurchaseOrderId] = useState('');
  const [isOpeningStock, setIsOpeningStock] = useState<boolean>(false);
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState('');
  const [supplierInvoiceDate, setSupplierInvoiceDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [supplierDueDate, setSupplierDueDate] = useState('');
  const [transportCost, setTransportCost] = useState('0.00');
  const [loadingCost, setLoadingCost] = useState('0.00');
  const [productQuery, setProductQuery] = useState('');
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [pendingProduct, setPendingProduct] = useState<ProductHit | null>(null);
  const [pendingProductUnits, setPendingProductUnits] = useState<Array<{ id: string; unitName: string; conversionFactor: number; pricePesewas: number; isPurchaseUnit: boolean; active: boolean }>>([]);
  const [pendingUnitId, setPendingUnitId] = useState<string | null>(null);
  const [pendingQty, setPendingQty] = useState(0);
  const [pendingCost, setPendingCost] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [myRequests, setMyRequests] = useState<StockReceiptRequestSummary[]>([]);
  const canCreateOpeningStock = workerRole === 'OWNER' || workerRole === 'FOUNDER';

  useEffect(() => {
    void (async () => {
      const r = await counter.listSuppliers();
      if (r.success) {
        setSuppliers(r.data.suppliers);
        if (r.data.suppliers[0]) setSupplierId(r.data.suppliers[0].id);
      }
      const po = await counter.reorderListDrafts();
      if (po.success) setDraftPOs(po.data.drafts);
    })();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') {
        e.preventDefault();
        onExit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  async function refreshMyRequests() {
    const result = await counter.stockReceiptRequestList({ scope: 'MY', status: 'ALL', limit: 25 });
    if (result.success) setMyRequests(result.data.requests);
  }

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const result = await counter.stockReceiptRequestList({ scope: 'MY', status: 'ALL', limit: 25 });
      if (!cancelled && result.success) setMyRequests(result.data.requests);
    }
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await counter.searchProducts(productQuery, 'WALK_IN', 12);
      if (cancelled) return;
      if (r.success) setHits(r.data.products);
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [productQuery]);

  const supplierDraftPOs = draftPOs.filter((po) => po.supplierId === supplierId);

  useEffect(() => {
    if (purchaseOrderId && !supplierDraftPOs.some((po) => po.id === purchaseOrderId)) {
      setPurchaseOrderId('');
    }
  }, [purchaseOrderId, supplierDraftPOs]);

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

  async function submitRequest() {
    if (lines.length === 0) { setError('Add at least one line.'); return; }
    if (!isOpeningStock && !supplierId) { setError('Pick a supplier.'); return; }
    const transportCostPesewas = parseCedisToPesewas(transportCost);
    const loadingCostPesewas = parseCedisToPesewas(loadingCost);
    if (!isOpeningStock && (transportCostPesewas === null || loadingCostPesewas === null)) {
      setError('Transport and loading costs must be valid amounts.'); return;
    }
    setSubmitting(true);
    setError(null);
    const r = await counter.stockReceiptRequestCreate({
      supplierId: isOpeningStock ? null : supplierId,
      isOpeningStock,
      purchaseOrderId: isOpeningStock ? null : purchaseOrderId || null,
      supplierInvoiceNumber: isOpeningStock ? null : supplierInvoiceNumber.trim() || null,
      supplierInvoiceDate: isOpeningStock ? null : supplierInvoiceDate,
      supplierDueDate: isOpeningStock ? null : supplierDueDate || null,
      transportCostPesewas: isOpeningStock ? 0 : transportCostPesewas ?? 0,
      loadingCostPesewas: isOpeningStock ? 0 : loadingCostPesewas ?? 0,
      lines: lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCostPesewas: l.unitCostPesewas, unitId: l.unitId })),
      notes: notes.trim() || null,
    });
    setSubmitting(false);
    if (!r.success) {
      setError(r.error);
      return;
    }
    setInfo(`Stock request #${r.data.id.slice(-8)} submitted for approval. No stock, supplier balance, PO, cost, or ledger value changes until it is approved.`);
    setLines([]); setNotes(''); setSupplierInvoiceNumber(''); setPurchaseOrderId(''); setTransportCost('0.00'); setLoadingCost('0.00');
    await refreshMyRequests();
  }

  async function withdraw(requestId: string) {
    const result = await counter.stockReceiptRequestWithdraw(requestId);
    if (!result.success) { setError(result.error); return; }
    setInfo(`Stock request #${requestId.slice(-8)} withdrawn. No inventory was changed.`);
    await refreshMyRequests();
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="receive stock" onBack={onExit} />
      <main className="flex-1 max-w-4xl w-full mx-auto px-4 sm:px-12 py-8 flex flex-col gap-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">Stock receipt</h2>
          <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
        </div>
        {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}

        {myRequests.length > 0 && <section className="panel p-4">
          <div className="eyebrow">My recent receipt requests</div>
          <p className="text-xs text-text-secondary mt-1 mb-3">Pending requests have not changed inventory or the books. Approved requests are posted; declined and withdrawn requests have no operational effect.</p>
          {myRequests.map((request) => <div key={request.id} className="flex flex-wrap items-center gap-3 py-2 border-t border-border-subtle text-sm">
            <span className={`status-badge ${request.status === 'PENDING' ? 'status-pending' : request.status === 'APPROVED' ? 'status-approved' : request.status === 'DECLINED' ? 'status-danger' : 'status-neutral'}`}>{request.status[0] + request.status.slice(1).toLowerCase()}</span>
            <span className="font-mono">#{request.id.slice(-8)}</span>
            <span>{request.supplierName ?? 'Opening stock'}</span>
            <span className="font-mono tnum">{formatMoneyWithCurrency(request.totalPayablePesewas)}</span>
            <span className="text-xs text-text-tertiary flex-1">{request.reviewedAt && request.reviewerName
              ? `${request.reviewerName} · ${new Date(request.reviewedAt).toLocaleString()}${request.reviewNote ? ` · ${request.reviewNote}` : ''}`
              : new Date(request.requestedAt).toLocaleString()}</span>
            {request.status === 'PENDING' && <button className="btn btn-quiet text-xs" onClick={() => void withdraw(request.id)}>Withdraw</button>}
          </div>)}
        </section>}

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-text-secondary text-sm">
            <input type="checkbox" checked={isOpeningStock} disabled={!canCreateOpeningStock} onChange={(e) => setIsOpeningStock(e.target.checked)} />
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
            {supplierDraftPOs.length > 0 && (
              <label>
                <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Match to PO</span>
                <select
                  value={purchaseOrderId}
                  onChange={(e) => setPurchaseOrderId(e.target.value)}
                  className="w-full bg-bg-input border border-border-strong px-3 py-2 text-text-primary"
                >
                  <option value="">Receipt only</option>
                  {supplierDraftPOs.map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.poNumber} · {po.lineCount} line(s) · {formatMoney(po.totalOrderedPesewas)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label>
                <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Supplier invoice #</span>
                <input
                  value={supplierInvoiceNumber}
                  onChange={(e) => setSupplierInvoiceNumber(e.target.value)}
                  placeholder="e.g. INV-1042"
                  className="w-full bg-bg-input border border-border-strong px-3 py-2"
                />
              </label>
              <label>
                <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Invoice date</span>
                <input
                  type="date"
                  value={supplierInvoiceDate}
                  onChange={(e) => setSupplierInvoiceDate(e.target.value)}
                  className="w-full bg-bg-input border border-border-strong px-3 py-2"
                />
              </label>
              <label>
                <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Due date</span>
                <input
                  type="date"
                  value={supplierDueDate}
                  onChange={(e) => setSupplierDueDate(e.target.value)}
                  className="w-full bg-bg-input border border-border-strong px-3 py-2"
                />
              </label>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label>
                <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Transport cost</span>
                <input
                  value={transportCost}
                  onChange={(e) => setTransportCost(e.target.value)}
                  className="w-full bg-bg-input border border-border-strong px-3 py-2"
                />
              </label>
              <label>
                <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Loading cost</span>
                <input
                  value={loadingCost}
                  onChange={(e) => setLoadingCost(e.target.value)}
                  className="w-full bg-bg-input border border-border-strong px-3 py-2"
                />
              </label>
            </div>
          </>
        )}

        {isOpeningStock && (
          <div className="bg-bg-surface border border-warning/40 text-warning text-sm px-4 py-3">
            <strong>Opening stock mode:</strong> use this to seed initial inventory on a fresh install.
            No supplier is recorded; movements get reason <code>OPENING_STOCK</code>. Requires
            an OWNER or FOUNDER to submit and approve.
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
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
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
                className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light">
                Add line
              </button>
            </div>
          )}
        </div>

        <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Notes (optional)" className="bg-bg-input border border-border-strong px-3 py-2 text-sm" rows={2} />

        {error && <FeedbackBanner>{error}</FeedbackBanner>}

        <div className="flex gap-3">
          <button onClick={onExit} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
          <button
            onClick={() => void submitRequest()}
            disabled={submitting || lines.length === 0 || (!isOpeningStock && !supplierId)}
            className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
            {submitting ? 'Submitting…' : 'Submit for approval'}
          </button>
        </div>
      </main>
    </div>
  );
}
