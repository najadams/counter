// Products admin tab. List + add/edit/deactivate/reactivate.
// OWNER/FOUNDER gate enforced server-side; the tab still renders for others
// but the action buttons say "admin only".

import { useEffect, useState } from 'react';
import { StockHistoryModal } from '../../components/StockHistoryModal';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../../shared/lib/money';

interface AdminProduct {
  id: string; sku: string; barcode: string | null; name: string;
  category: string; brand: string | null;
  packSizeUnits: number; unitVolumeMl: number | null;
  isReturnable: boolean; bottleDepositPesewas: number;
  costPricePesewas: number; walkInPricePesewas: number;
  wholesalePricePesewas: number; routePricePesewas: number;
  reorderThreshold: number; reorderQuantity: number;
  primarySupplierId: string | null;
  defaultLeadTimeDays: number; shelfLifeDays: number | null;
  countClass: 'A' | 'B' | 'C' | null;
  active: boolean; unitsOnHand: number;
}

const CATEGORIES = [
  'BEER', 'WINE', 'SPIRITS', 'SOFT_DRINK', 'WATER', 'JUICE',
  'ENERGY_DRINK', 'MIXER', 'NON_BEVERAGE', 'OTHER',
] as const;

export function ProductsTab() {
  const myRole = useSession((s) => s.workerRole);
  const isAdmin = myRole === 'OWNER' || myRole === 'FOUNDER';

  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [filter, setFilter] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<AdminProduct | null>(null);
  const [historyFor, setHistoryFor] = useState<AdminProduct | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const r = await counter.adminListProducts();
    if (r.success) setProducts(r.data.products);
  }
  useEffect(() => { void refresh(); }, []);

  function flash(message: string, kind: 'info' | 'error') {
    if (kind === 'info') { setInfo(message); setError(null); setTimeout(() => setInfo(null), 4000); }
    else { setError(message); setInfo(null); }
  }

  async function deactivate(id: string) {
    const r = await counter.deactivateProduct(id);
    if (!r.success) flash(r.error, 'error');
    else { flash('Product deactivated.', 'info'); await refresh(); }
  }
  async function reactivate(id: string) {
    const r = await counter.reactivateProduct(id);
    if (!r.success) flash(r.error, 'error');
    else { flash('Product reactivated.', 'info'); await refresh(); }
  }

  const visible = products.filter((p) =>
    (includeInactive || p.active) &&
    (!filter || p.name.toLowerCase().includes(filter.toLowerCase()) ||
     p.sku.toLowerCase().includes(filter.toLowerCase())),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1">
          <input value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or SKU…"
            className="bg-bg-input border border-border-strong px-4 py-2 flex-1" />
          <label className="flex items-center gap-2 text-text-secondary text-sm">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            show inactive
          </label>
        </div>
        <button
          onClick={() => isAdmin && setShowAdd(true)}
          disabled={!isAdmin}
          title={isAdmin ? '' : 'OWNER or FOUNDER role required to add products'}
          className="bg-accent text-bg-deep px-4 py-2 font-semibold hover:bg-accent-light text-sm disabled:opacity-40 disabled:cursor-not-allowed">
          + Add product
        </button>
      </div>

      {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}
      {error && <div className="bg-bg-surface border border-danger px-5 py-3 text-danger text-sm">{error}</div>}

      <div className="bg-bg-surface border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-secondary text-xs uppercase tracking-wider">
              <th className="px-3 py-3 text-left">Product</th>
              <th className="px-3 py-3 text-left">Category</th>
              <th className="px-3 py-3 text-right">Cost</th>
              <th className="px-3 py-3 text-right">Walk-in</th>
              <th className="px-3 py-3 text-right">Wholesale</th>
              <th className="px-3 py-3 text-right">Route</th>
              <th className="px-3 py-3 text-right">On hand</th>
              <th className="px-3 py-3 text-right">Reorder</th>
              <th className="px-3 py-3 text-left">Status</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => {
              const lowMargin = p.walkInPricePesewas < p.costPricePesewas;
              return (
                <tr key={p.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div>{p.name}</div>
                    <div className="text-text-tertiary text-xs">{p.sku}{p.brand ? ` · ${p.brand}` : ''}</div>
                  </td>
                  <td className="px-3 py-2">{p.category}</td>
                  <td className="px-3 py-2 text-right font-mono tnum">{formatMoney(p.costPricePesewas)}</td>
                  <td className={`px-3 py-2 text-right font-mono tnum ${lowMargin ? 'text-danger' : ''}`}>{formatMoney(p.walkInPricePesewas)}</td>
                  <td className="px-3 py-2 text-right font-mono tnum">{formatMoney(p.wholesalePricePesewas)}</td>
                  <td className="px-3 py-2 text-right font-mono tnum">{formatMoney(p.routePricePesewas)}</td>
                  <td className={`px-3 py-2 text-right font-mono tnum ${p.unitsOnHand <= p.reorderThreshold && p.reorderThreshold > 0 ? 'text-warning' : ''}`}>{p.unitsOnHand}</td>
                  <td className="px-3 py-2 text-right font-mono tnum text-text-tertiary">
                    {p.reorderThreshold > 0 ? `≤ ${p.reorderThreshold}` : '—'}
                  </td>
                  <td className="px-3 py-2">{p.active ? <span className="text-success">active</span> : <span className="text-text-tertiary">inactive</span>}</td>
                  <td className="px-3 py-2 text-right space-x-2">
                    <button onClick={() => setHistoryFor(p)} className="text-text-tertiary hover:text-accent text-xs">history</button>
                    {isAdmin ? (
                      <>
                        <button onClick={() => setEditing(p)} className="text-text-tertiary hover:text-accent text-xs">edit</button>
                        {p.active
                          ? <button onClick={() => deactivate(p.id)} className="text-text-tertiary hover:text-warning text-xs">deactivate</button>
                          : <button onClick={() => reactivate(p.id)} className="text-text-tertiary hover:text-success text-xs">reactivate</button>}
                      </>
                    ) : (
                      <span className="text-text-tertiary text-xs" title="OWNER or FOUNDER role required to edit or deactivate">edit/deactivate: admin only</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr><td colSpan={10} className="px-4 py-6 text-text-tertiary text-center">No products match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <ProductFormModal
          mode="add"
          onCancel={() => setShowAdd(false)}
          onDone={(msg) => { setShowAdd(false); flash(msg, 'info'); void refresh(); }}
          onError={(e) => flash(e, 'error')}
        />
      )}
      {editing && (
        <ProductFormModal
          mode="edit"
          existing={editing}
          onCancel={() => setEditing(null)}
          onDone={(msg) => { setEditing(null); flash(msg, 'info'); void refresh(); }}
          onError={(e) => flash(e, 'error')}
        />
      )}
      {historyFor && (
        <StockHistoryModal
          productId={historyFor.id}
          productName={historyFor.name}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  );
}

function ProductFormModal({ mode, existing, onCancel, onDone, onError }: {
  mode: 'add' | 'edit';
  existing?: AdminProduct;
  onCancel: () => void;
  onDone: (msg: string) => void;
  onError: (e: string) => void;
}) {
  const [sku, setSku] = useState(existing?.sku ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [category, setCategory] = useState(existing?.category ?? 'BEER');
  const [brand, setBrand] = useState(existing?.brand ?? '');
  const [barcode, setBarcode] = useState(existing?.barcode ?? '');
  const [packSize, setPackSize] = useState(String(existing?.packSizeUnits ?? 1));
  const [volumeMl, setVolumeMl] = useState(existing?.unitVolumeMl != null ? String(existing.unitVolumeMl) : '');
  const [isReturnable, setIsReturnable] = useState(existing?.isReturnable ?? false);
  const [deposit, setDeposit] = useState(existing ? formatMoney(existing.bottleDepositPesewas) : '0.00');
  const [cost, setCost] = useState(existing ? formatMoney(existing.costPricePesewas) : '');
  const [walkIn, setWalkIn] = useState(existing ? formatMoney(existing.walkInPricePesewas) : '');
  const [wholesale, setWholesale] = useState(existing ? formatMoney(existing.wholesalePricePesewas) : '');
  const [route, setRoute] = useState(existing ? formatMoney(existing.routePricePesewas) : '');
  const [reorderThreshold, setReorderThreshold] = useState(String(existing?.reorderThreshold ?? 0));
  const [reorderQty, setReorderQty] = useState(String(existing?.reorderQuantity ?? 0));
  const [countClass, setCountClass] = useState<'A' | 'B' | 'C' | ''>(existing?.countClass ?? '');
  const [leadTime, setLeadTime] = useState(String(existing?.defaultLeadTimeDays ?? 7));
  const [shelfLife, setShelfLife] = useState(existing?.shelfLifeDays != null ? String(existing.shelfLifeDays) : '');
  const [submitting, setSubmitting] = useState(false);

  function parseInt(s: string): number | null {
    if (s === '') return null;
    const n = Number(s);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  async function submit() {
    setSubmitting(true);
    const costP = parseCedisToPesewas(cost);
    const walkInP = parseCedisToPesewas(walkIn);
    const wholesaleP = parseCedisToPesewas(wholesale);
    const routeP = parseCedisToPesewas(route);
    const depositP = parseCedisToPesewas(deposit);
    if (costP == null || walkInP == null || wholesaleP == null || routeP == null || depositP == null) {
      onError('Prices must be valid numbers (e.g. 5.50).');
      setSubmitting(false);
      return;
    }
    const packSizeN = parseInt(packSize) ?? 1;
    const reorderThresholdN = parseInt(reorderThreshold) ?? 0;
    const reorderQtyN = parseInt(reorderQty) ?? 0;
    const leadTimeN = parseInt(leadTime) ?? 7;
    const volumeMlN = volumeMl === '' ? null : parseInt(volumeMl);
    const shelfLifeN = shelfLife === '' ? null : parseInt(shelfLife);

    if (mode === 'add') {
      const r = await counter.addProduct({
        sku: sku.trim(), name: name.trim(), category,
        brand: brand.trim() || null,
        barcode: barcode.trim() || null,
        packSizeUnits: packSizeN,
        unitVolumeMl: volumeMlN,
        isReturnable, bottleDepositPesewas: depositP,
        costPricePesewas: costP, walkInPricePesewas: walkInP,
        wholesalePricePesewas: wholesaleP, routePricePesewas: routeP,
        reorderThreshold: reorderThresholdN, reorderQuantity: reorderQtyN,
        countClass: countClass || null,
        defaultLeadTimeDays: leadTimeN,
        shelfLifeDays: shelfLifeN,
      });
      setSubmitting(false);
      if (!r.success) { onError(r.error); return; }
      const warn = r.data.warnings.length > 0 ? ` Warning: ${r.data.warnings.join(', ')}.` : '';
      onDone(`Product added.${warn}`);
    } else if (existing) {
      const r = await counter.updateProduct({
        productId: existing.id,
        fields: {
          name: name.trim(), category, brand: brand.trim() || null,
          barcode: barcode.trim() || null,
          packSizeUnits: packSizeN, unitVolumeMl: volumeMlN,
          isReturnable, bottleDepositPesewas: depositP,
          costPricePesewas: costP, walkInPricePesewas: walkInP,
          wholesalePricePesewas: wholesaleP, routePricePesewas: routeP,
          reorderThreshold: reorderThresholdN, reorderQuantity: reorderQtyN,
        countClass: countClass || null,
          defaultLeadTimeDays: leadTimeN, shelfLifeDays: shelfLifeN,
        },
      });
      setSubmitting(false);
      if (!r.success) { onError(r.error); return; }
      const warn = r.data.warnings.length > 0 ? ` Warning: ${r.data.warnings.join(', ')}.` : '';
      onDone(`Product updated.${warn}`);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 overflow-y-auto py-8" onClick={onCancel}>
      <div className="bg-bg-surface border border-border w-full max-w-2xl p-8 flex flex-col gap-4 my-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">
          {mode === 'add' ? 'Add product' : `Edit — ${existing?.sku}`}
        </h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU">
            <input value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())}
              disabled={mode === 'edit'}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono disabled:opacity-50" />
          </Field>
          <Field label="Barcode (optional)">
            <input value={barcode} onChange={(e) => setBarcode(e.target.value)}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono" />
          </Field>
        </div>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)}
            className="w-full bg-bg-input border border-border-strong px-3 py-2" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value)}
              className="w-full bg-bg-input border border-border-strong px-3 py-2">
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Brand (optional)">
            <input value={brand} onChange={(e) => setBrand(e.target.value)}
              className="w-full bg-bg-input border border-border-strong px-3 py-2" />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Pack size (units)">
            <input value={packSize} onChange={(e) => setPackSize(e.target.value.replace(/\D/g, ''))}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
          </Field>
          <Field label="Volume (ml)">
            <input value={volumeMl} onChange={(e) => setVolumeMl(e.target.value.replace(/\D/g, ''))}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
          </Field>
          <Field label="Shelf life (days)">
            <input value={shelfLife} onChange={(e) => setShelfLife(e.target.value.replace(/\D/g, ''))}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 items-end">
          <Field label="Returnable bottle?">
            <label className="flex items-center gap-2 px-3 py-2 bg-bg-input border border-border-strong">
              <input type="checkbox" checked={isReturnable} onChange={(e) => setIsReturnable(e.target.checked)} />
              <span className="text-sm text-text-primary">Has bottle deposit</span>
            </label>
          </Field>
          <Field label="Deposit (cedis)">
            <input value={deposit} onChange={(e) => setDeposit(e.target.value)} disabled={!isReturnable}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum disabled:opacity-50" />
          </Field>
        </div>
        <h4 className="text-text-secondary uppercase tracking-wider text-xs mt-2">Pricing (cedis)</h4>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Cost">
            <input value={cost} onChange={(e) => setCost(e.target.value)}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
          </Field>
          <Field label="Walk-in">
            <input value={walkIn} onChange={(e) => setWalkIn(e.target.value)}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
          </Field>
          <Field label="Wholesale">
            <input value={wholesale} onChange={(e) => setWholesale(e.target.value)}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
          </Field>
          <Field label="Route">
            <input value={route} onChange={(e) => setRoute(e.target.value)}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
          </Field>
        </div>
        <h4 className="text-text-secondary uppercase tracking-wider text-xs mt-2">Replenishment</h4>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Reorder threshold">
            <input value={reorderThreshold} onChange={(e) => setReorderThreshold(e.target.value.replace(/\D/g, ''))}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
          </Field>
          <Field label="Reorder qty">
            <input value={reorderQty} onChange={(e) => setReorderQty(e.target.value.replace(/\D/g, ''))}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
          </Field>
          <Field label="Lead time (days)">
            <input value={leadTime} onChange={(e) => setLeadTime(e.target.value.replace(/\D/g, ''))}
              className="w-full bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
          </Field>
        </div>
        <h4 className="text-text-secondary uppercase tracking-wider text-xs mt-2">Cycle count class</h4>
        <div className="grid grid-cols-2 gap-3 items-end">
          <Field label="Count class">
            <select value={countClass} onChange={(e) => setCountClass(e.target.value as 'A' | 'B' | 'C' | '')}
              className="w-full bg-bg-input border border-border-strong px-3 py-2">
              <option value="">— unclassified —</option>
              <option value="A">A — count weekly (top sellers)</option>
              <option value="B">B — count every 2-3 weeks</option>
              <option value="C">C — count monthly (long tail)</option>
            </select>
          </Field>
          <div className="text-xs text-text-tertiary self-center">
            ABC class lets you target a stocktake to just the fast movers
            instead of counting the whole shop every time.
          </div>
        </div>
        {mode === 'edit' && existing && (
          <ProductUnitsEditor productId={existing.id} onError={onError} />
        )}
        {mode === 'edit' && existing && (
          <PricingTiersEditor productId={existing.id} onError={onError} />
        )}
        <div className="flex gap-3 mt-4">
          <button onClick={onCancel} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
          <button onClick={() => void submit()}
            disabled={submitting || !sku.trim() || !name.trim()}
            className="bg-accent text-bg-deep px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
            {submitting ? 'Saving…' : (mode === 'add' ? 'Add product' : 'Save changes')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-text-secondary uppercase tracking-wider text-xs">{label}</span>
      {children}
    </div>
  );
}


interface TierRow {
  id: string; channel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | 'ALL';
  minQuantity: number; unitPricePesewas: number; active: boolean; notes: string | null;
  appliesToUnitId: string | null;
}

function PricingTiersEditor({ productId, onError }: { productId: string; onError: (e: string) => void }) {
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [units, setUnits] = useState<Array<{ id: string; unitName: string; conversionFactor: number }>>([]);
  const [draftChannel, setDraftChannel] = useState<TierRow['channel']>('ALL');
  const [draftMinQty, setDraftMinQty] = useState('');
  const [draftPrice, setDraftPrice] = useState('');
  const [draftUnitId, setDraftUnitId] = useState<string>('');  // '' = any unit

  async function refresh() {
    const r = await counter.listPricingTiersForProduct(productId);
    if (r.success) setTiers(r.data.tiers as TierRow[]);
    const u = await counter.listProductUnits(productId, true);
    if (u.success) setUnits(u.data.units.filter((x: { isSaleUnit: boolean }) => x.isSaleUnit).map((x: { id: string; unitName: string; conversionFactor: number }) => ({ id: x.id, unitName: x.unitName, conversionFactor: x.conversionFactor })));
  }
  useEffect(() => { void refresh(); }, [productId]);

  function unitName(unitId: string | null): string {
    if (!unitId) return 'any unit';
    const u = units.find((x) => x.id === unitId);
    return u ? u.unitName : '(deleted unit)';
  }

  async function addOne() {
    const minQty = Number(draftMinQty.replace(/\D/g, ''));
    const price = parseCedisToPesewas(draftPrice);
    if (!minQty || price == null) { onError('Quantity and price are both required.'); return; }
    const r = await counter.addPricingTier({
      productId, channel: draftChannel, minQuantity: minQty, unitPricePesewas: price,
      appliesToUnitId: draftUnitId || null,
    });
    if (!r.success) { onError(r.error); return; }
    setDraftMinQty(''); setDraftPrice('');
    await refresh();
  }
  async function deactivate(t: TierRow) {
    const r = await counter.deactivatePricingTier(t.id);
    if (!r.success) { onError(r.error); return; }
    await refresh();
  }
  async function reactivate(t: TierRow) {
    const r = await counter.reactivatePricingTier(t.id);
    if (!r.success) { onError(r.error); return; }
    await refresh();
  }

  return (
    <div className="border border-border bg-bg-deep p-4 flex flex-col gap-3">
      <h4 className="text-text-secondary uppercase tracking-wider text-xs">Volume tiers</h4>
      <div className="text-text-tertiary text-xs">
        Apply automatically when cart line quantity meets the threshold. Channel ALL applies to walk-in, wholesale, and route.
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-text-secondary text-xs uppercase tracking-wider">
            <th className="text-left">Channel</th>
            <th className="text-left">Applies to</th>
            <th className="text-right">Min qty</th>
            <th className="text-right">Unit price</th>
            <th className="text-left">Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((t) => (
            <tr key={t.id} className="border-t border-border">
              <td>{t.channel}</td>
              <td className="text-text-tertiary text-xs">{unitName(t.appliesToUnitId)}</td>
              <td className="text-right font-mono tnum">{t.minQuantity}</td>
              <td className="text-right font-mono tnum">{formatMoney(t.unitPricePesewas)}</td>
              <td>{t.active ? <span className="text-success">active</span> : <span className="text-text-tertiary">inactive</span>}</td>
              <td className="text-right">
                {t.active
                  ? <button onClick={() => void deactivate(t)} className="text-text-tertiary hover:text-warning text-xs">deactivate</button>
                  : <button onClick={() => void reactivate(t)} className="text-text-tertiary hover:text-success text-xs">reactivate</button>}
              </td>
            </tr>
          ))}
          {tiers.length === 0 && (
            <tr><td colSpan={6} className="text-text-tertiary text-center py-2">No tiers yet.</td></tr>
          )}
        </tbody>
      </table>
      <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-2 items-end">
        <div className="flex flex-col gap-1">
          <span className="text-text-secondary text-xs uppercase tracking-wider">Channel</span>
          <select value={draftChannel} onChange={(e) => setDraftChannel(e.target.value as TierRow['channel'])}
            className="bg-bg-input border border-border-strong px-3 py-2">
            {(['ALL', 'WALK_IN', 'WHOLESALE', 'ROUTE'] as const).map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-text-secondary text-xs uppercase tracking-wider">Applies to</span>
          <select value={draftUnitId} onChange={(e) => setDraftUnitId(e.target.value)}
            className="bg-bg-input border border-border-strong px-3 py-2">
            <option value="">any unit</option>
            {units.map((u) => (
              <option key={u.id} value={u.id}>{u.unitName}{u.conversionFactor > 1 ? ` ×${u.conversionFactor}` : ''}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-text-secondary text-xs uppercase tracking-wider">Min qty</span>
          <input value={draftMinQty} onChange={(e) => setDraftMinQty(e.target.value.replace(/\D/g, ''))}
            className="bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-text-secondary text-xs uppercase tracking-wider">Unit price (cedis)</span>
          <input value={draftPrice} onChange={(e) => setDraftPrice(e.target.value)}
            className="bg-bg-input border border-border-strong px-3 py-2 font-mono tnum" />
        </div>
        <button onClick={() => void addOne()}
          className="bg-accent text-bg-deep px-4 py-2 font-semibold hover:bg-accent-light">
          Add tier
        </button>
      </div>
    </div>
  );
}


interface UnitRow {
  id: string; unitName: string;
  conversionFactor: number; pricePesewas: number;
  isPurchaseUnit: boolean; isSaleUnit: boolean;
  active: boolean; notes: string | null;
}

function ProductUnitsEditor({ productId, onError }: { productId: string; onError: (e: string) => void }) {
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [draftName, setDraftName] = useState('');
  const [draftFactor, setDraftFactor] = useState('');
  const [draftPrice, setDraftPrice] = useState('');
  const [draftIsSale, setDraftIsSale] = useState(true);
  const [draftIsPurchase, setDraftIsPurchase] = useState(true);

  async function refresh() {
    const r = await counter.listProductUnits(productId, false);
    if (r.success) setUnits(r.data.units as UnitRow[]);
  }
  useEffect(() => { void refresh(); }, [productId]);

  async function addOne() {
    const factor = Number(draftFactor.replace(/\D/g, ''));
    const price = parseCedisToPesewas(draftPrice);
    if (!draftName.trim() || !factor || price == null) {
      onError('Name, factor, and price are all required.');
      return;
    }
    if (!draftIsSale && !draftIsPurchase) {
      onError('Mark as sellable, purchasable, or both.');
      return;
    }
    const r = await counter.addProductUnit({
      productId, unitName: draftName.trim().toUpperCase(),
      conversionFactor: factor, pricePesewas: price,
      isSaleUnit: draftIsSale, isPurchaseUnit: draftIsPurchase,
    });
    if (!r.success) { onError(r.error); return; }
    setDraftName(''); setDraftFactor(''); setDraftPrice('');
    await refresh();
  }
  async function deactivate(u: UnitRow) {
    if (u.unitName === 'UNIT' && u.conversionFactor === 1) {
      onError('Cannot deactivate the canonical UNIT row.');
      return;
    }
    const r = await counter.deactivateProductUnit(u.id);
    if (!r.success) { onError(r.error); return; }
    await refresh();
  }
  async function reactivate(u: UnitRow) {
    const r = await counter.reactivateProductUnit(u.id);
    if (!r.success) { onError(r.error); return; }
    await refresh();
  }

  return (
    <div className="border border-border bg-bg-deep p-4 flex flex-col gap-3">
      <h4 className="text-text-secondary uppercase tracking-wider text-xs">Sellable / purchasable units</h4>
      <div className="text-text-tertiary text-xs">
        Define multiple units per product (BOTTLE, CRATE, BAG_50KG, etc). Stock is tracked in the canonical unit;
        each row's factor multiplies in. Per-unit price is what shows in the sale or receipt flow.
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-text-secondary text-xs uppercase tracking-wider">
            <th className="text-left">Name</th>
            <th className="text-right">Factor</th>
            <th className="text-right">Price (each)</th>
            <th className="text-center">Sale</th>
            <th className="text-center">Purchase</th>
            <th className="text-left">Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {units.map((u) => (
            <tr key={u.id} className="border-t border-border">
              <td className="font-mono">{u.unitName}</td>
              <td className="text-right font-mono tnum">× {u.conversionFactor}</td>
              <td className="text-right font-mono tnum">{formatMoney(u.pricePesewas)}</td>
              <td className="text-center">{u.isSaleUnit ? '✓' : '—'}</td>
              <td className="text-center">{u.isPurchaseUnit ? '✓' : '—'}</td>
              <td>{u.active ? <span className="text-success">active</span> : <span className="text-text-tertiary">inactive</span>}</td>
              <td className="text-right">
                {u.active
                  ? <button onClick={() => void deactivate(u)} className="text-text-tertiary hover:text-warning text-xs">deactivate</button>
                  : <button onClick={() => void reactivate(u)} className="text-text-tertiary hover:text-success text-xs">reactivate</button>}
              </td>
            </tr>
          ))}
          {units.length === 0 && (
            <tr><td colSpan={7} className="text-text-tertiary text-center py-2">No units defined yet.</td></tr>
          )}
        </tbody>
      </table>
      <div className="grid grid-cols-[1fr_auto_auto_auto_auto_auto] gap-2 items-end">
        <div className="flex flex-col gap-1">
          <span className="text-text-secondary text-xs uppercase tracking-wider">Unit name</span>
          <input value={draftName} onChange={(e) => setDraftName(e.target.value.toUpperCase())}
            placeholder="CRATE, BAG_50KG, SHOT_50ML…"
            className="bg-bg-input border border-border-strong px-3 py-2 font-mono" />
        </div>
        <div className="flex flex-col gap-1 w-24">
          <span className="text-text-secondary text-xs uppercase tracking-wider">Factor</span>
          <input value={draftFactor} onChange={(e) => setDraftFactor(e.target.value.replace(/\D/g, ''))}
            placeholder="24"
            className="bg-bg-input border border-border-strong px-3 py-2 font-mono tnum text-right" />
        </div>
        <div className="flex flex-col gap-1 w-32">
          <span className="text-text-secondary text-xs uppercase tracking-wider">Price (cedis)</span>
          <input value={draftPrice} onChange={(e) => setDraftPrice(e.target.value)}
            placeholder="180.00"
            className="bg-bg-input border border-border-strong px-3 py-2 font-mono tnum text-right" />
        </div>
        <label className="flex items-center gap-1 text-xs text-text-secondary">
          <input type="checkbox" checked={draftIsSale} onChange={(e) => setDraftIsSale(e.target.checked)} />
          sale
        </label>
        <label className="flex items-center gap-1 text-xs text-text-secondary">
          <input type="checkbox" checked={draftIsPurchase} onChange={(e) => setDraftIsPurchase(e.target.checked)} />
          purchase
        </label>
        <button onClick={() => void addOne()}
          className="bg-accent text-bg-deep px-4 py-2 font-semibold hover:bg-accent-light">
          Add unit
        </button>
      </div>
    </div>
  );
}
