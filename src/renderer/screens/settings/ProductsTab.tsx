// Products admin tab. List + add/edit/deactivate/reactivate.
// OWNER/FOUNDER gate enforced server-side; the tab still renders for others
// but the action buttons say "admin only".

import { CheckIcon, PlusIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { StockHistoryModal } from '../../components/StockHistoryModal';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoney, parseCedisToPesewas } from '../../../shared/lib/money';
import { formatStockCompact } from '../../../shared/lib/units';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog';
import { Field } from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import { NativeSelect } from '../../components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';

interface AdminProduct {
  id: string; sku: string; barcode: string | null; name: string;
  category: string; brand: string | null;
  packSizeUnits: number; unitVolumeMl: number | null;
  isReturnable: boolean; bottleDepositPesewas: number;
  costPricePesewas: number; walkInPricePesewas: number;
  wholesalePricePesewas: number; routePricePesewas: number;
  minimumPricePesewas: number;
  competitorPricePesewas: number | null;
  competitorName: string | null;
  competitorCheckedAt: string | null;
  reorderThreshold: number; reorderQuantity: number;
  primarySupplierId: string | null;
  defaultLeadTimeDays: number; shelfLifeDays: number | null;
  countClass: 'A' | 'B' | 'C' | null;
  primaryPurchaseUnitId: string | null;
  primarySaleUnitId: string | null;
  active: boolean; unitsOnHand: number;
  units: Array<{ id: string; unitName: string; conversionFactor: number }>;
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
          <Input className="flex-1 px-4" value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by name or SKU…" />
          <label className="flex items-center gap-2 text-text-secondary text-sm">
            <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
            show inactive
          </label>
        </div>
        <Button variant="primary"
          onClick={() => isAdmin && setShowAdd(true)}
          disabled={!isAdmin}
          title={isAdmin ? '' : 'OWNER or FOUNDER role required to add products'}>
          + Add product
        </Button>
      </div>

      {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}
      {error && <FeedbackBanner>{error}</FeedbackBanner>}

      <div className="panel overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="px-3">Product</TableHead>
              <TableHead className="px-3">Category</TableHead>
              <TableHead className="px-3 text-right">Cost</TableHead>
              <TableHead className="px-3 text-right">Walk-in</TableHead>
              <TableHead className="px-3 text-right">Wholesale</TableHead>
              <TableHead className="px-3 text-right">Route</TableHead>
              <TableHead className="px-3 text-right">On hand</TableHead>
              <TableHead className="px-3 text-right">Reorder</TableHead>
              <TableHead className="px-3">Status</TableHead>
              <TableHead className="px-3"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((p) => {
              const lowMargin = p.walkInPricePesewas < p.costPricePesewas;
              return (
                <TableRow key={p.id}>
                  <TableCell className="px-3 py-2">
                    <div>{p.name}</div>
                    <div className="text-text-tertiary text-xs">{p.sku}{p.brand ? ` · ${p.brand}` : ''}</div>
                  </TableCell>
                  <TableCell className="px-3 py-2">{p.category}</TableCell>
                  <TableCell className="px-3 py-2 text-right font-mono tnum">{formatMoney(p.costPricePesewas)}</TableCell>
                  <TableCell className={`px-3 py-2 text-right font-mono tnum ${lowMargin ? 'text-danger' : ''}`}>{formatMoney(p.walkInPricePesewas)}</TableCell>
                  <TableCell className="px-3 py-2 text-right font-mono tnum">{formatMoney(p.wholesalePricePesewas)}</TableCell>
                  <TableCell className="px-3 py-2 text-right font-mono tnum">{formatMoney(p.routePricePesewas)}</TableCell>
                  <TableCell className={`px-3 py-2 text-right font-mono tnum ${p.unitsOnHand <= p.reorderThreshold && p.reorderThreshold > 0 ? 'text-warning' : ''}`}
                      title={`${p.unitsOnHand} canonical units`}>
                    {p.units.length > 1
                      ? formatStockCompact(p.unitsOnHand, p.units)
                      : p.unitsOnHand}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right font-mono tnum text-text-tertiary">
                    {p.reorderThreshold > 0 ? `≤ ${p.reorderThreshold}` : '—'}
                  </TableCell>
                  <TableCell className="px-3 py-2">{p.active ? <span className="text-success">active</span> : <span className="text-text-tertiary">inactive</span>}</TableCell>
                  <TableCell className="px-3 py-2 text-right space-x-2">
                    <Button variant="link" className="text-text-tertiary hover:text-accent no-underline hover:underline text-xs" onClick={() => setHistoryFor(p)}>history</Button>
                    {isAdmin ? (
                      <>
                        <Button variant="link" className="text-text-tertiary hover:text-accent no-underline hover:underline text-xs" onClick={() => setEditing(p)}>edit</Button>
                        {p.active
                          ? <Button variant="link" className="text-text-tertiary hover:text-warning no-underline hover:underline text-xs" onClick={() => deactivate(p.id)}>deactivate</Button>
                          : <Button variant="link" className="text-text-tertiary hover:text-success no-underline hover:underline text-xs" onClick={() => reactivate(p.id)}>reactivate</Button>}
                      </>
                    ) : (
                      <span className="text-text-tertiary text-xs" title="OWNER or FOUNDER role required to edit or deactivate">edit/deactivate: admin only</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {visible.length === 0 && (
              <TableRow><TableCell colSpan={10} className="px-4 py-6 text-text-tertiary text-center">No products match.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {showAdd && (
        <ProductFormModal
          mode="add"
          onCancel={() => setShowAdd(false)}
          onDone={(msg) => { setShowAdd(false); flash(msg, 'info'); void refresh(); }}
        />
      )}
      {editing && (
        <ProductFormModal
          mode="edit"
          existing={editing}
          onCancel={() => setEditing(null)}
          onDone={(msg) => { setEditing(null); flash(msg, 'info'); void refresh(); }}
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

function ProductFormModal({ mode, existing, onCancel, onDone }: {
  mode: 'add' | 'edit';
  existing?: AdminProduct;
  onCancel: () => void;
  onDone: (msg: string) => void;
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
  const [priceReason, setPriceReason] = useState('');
  const [reorderThreshold, setReorderThreshold] = useState(String(existing?.reorderThreshold ?? 0));
  const [reorderQty, setReorderQty] = useState(String(existing?.reorderQuantity ?? 0));
  const [countClass, setCountClass] = useState<'A' | 'B' | 'C' | ''>(existing?.countClass ?? '');
  const [leadTime, setLeadTime] = useState(String(existing?.defaultLeadTimeDays ?? 7));
  const [shelfLife, setShelfLife] = useState(existing?.shelfLifeDays != null ? String(existing.shelfLifeDays) : '');
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Draft units for ADD mode — created in the same transaction as the
  // product so we don't end up with a product that has no sellable units.
  // In EDIT mode, the existing ProductUnitsEditor handles units against
  // the live row, so this draft array stays empty there.
  interface DraftUnit {
    unitName: string;
    conversionFactor: number;
    pricePesewas: number;
    isSaleUnit: boolean;
    isPurchaseUnit: boolean;
  }
  const [draftUnits, setDraftUnits] = useState<DraftUnit[]>([]);
  const [du_name, setDuName] = useState('');
  const [du_factor, setDuFactor] = useState('');
  const [du_price, setDuPrice] = useState('');
  const [du_sale, setDuSale] = useState(true);
  const [du_purchase, setDuPurchase] = useState(true);
  // Which draft unit (by name) should be the default at the till. '' = let the
  // app fall back to the smallest sellable unit.
  const [defaultSaleUnitName, setDefaultSaleUnitName] = useState('');

  function showModalError(message: string) {
    setModalError(message);
  }

  function addDraftUnit() {
    const name = du_name.trim().toUpperCase();
    const factor = Number(du_factor.replace(/\D/g, ''));
    const price = parseCedisToPesewas(du_price);
    if (!name) { showModalError('Unit name is required.'); return; }
    if (!factor || factor <= 0) { showModalError('Conversion factor must be a positive integer.'); return; }
    if (price == null) { showModalError('Price must be a valid amount (e.g. 12.50).'); return; }
    if (!du_sale && !du_purchase) { showModalError('Mark the unit as sellable, purchasable, or both.'); return; }
    if (draftUnits.some((u) => u.unitName === name)) {
      showModalError(`Already added a unit called ${name}.`); return;
    }
    setDraftUnits([...draftUnits, {
      unitName: name, conversionFactor: factor, pricePesewas: price,
      isSaleUnit: du_sale, isPurchaseUnit: du_purchase,
    }]);
    setModalError(null);
    setDuName(''); setDuFactor(''); setDuPrice('');
  }
  function removeDraftUnit(idx: number) {
    const removed = draftUnits[idx];
    setDraftUnits(draftUnits.filter((_, i) => i !== idx));
    if (removed && removed.unitName === defaultSaleUnitName) setDefaultSaleUnitName('');
  }

  function parseInt(s: string): number | null {
    if (s === '') return null;
    const n = Number(s);
    return Number.isInteger(n) && n >= 0 ? n : null;
  }

  async function submit() {
    setSubmitting(true);
    setModalError(null);
    const costP = parseCedisToPesewas(cost);
    const walkInP = parseCedisToPesewas(walkIn);
    const wholesaleP = parseCedisToPesewas(wholesale);
    const routeP = parseCedisToPesewas(route);
    const depositP = parseCedisToPesewas(deposit);
    if (
      costP == null || walkInP == null || wholesaleP == null || routeP == null ||
      depositP == null
    ) {
      showModalError('Prices must be valid numbers (e.g. 5.50).');
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
        units: draftUnits.length > 0 ? draftUnits : undefined,
      });
      if (!r.success) { setSubmitting(false); showModalError(r.error); return; }
      // Apply the chosen "Default at the till" unit. unitIds line up with the
      // draftUnits order they were created in, so map the picked name to its id.
      if (defaultSaleUnitName) {
        const idx = draftUnits.findIndex((u) => u.unitName === defaultSaleUnitName);
        if (idx >= 0 && r.data.unitIds[idx]) {
          const pr = await counter.updateProduct({
            productId: r.data.productId,
            fields: { primarySaleUnitId: r.data.unitIds[idx] },
          });
          if (!pr.success) { setSubmitting(false); showModalError(pr.error); return; }
        }
      }
      setSubmitting(false);
      const warn = r.data.warnings.length > 0 ? ` Warning: ${r.data.warnings.join(', ')}.` : '';
      const unitNote = r.data.unitIds.length > 0 ? ` (${r.data.unitIds.length} unit${r.data.unitIds.length === 1 ? '' : 's'} added)` : '';
      onDone(`Product added${unitNote}.${warn}`);
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
          priceChangeReason: priceReason.trim() || null,
          reorderThreshold: reorderThresholdN, reorderQuantity: reorderQtyN,
        countClass: countClass || null,
          defaultLeadTimeDays: leadTimeN, shelfLifeDays: shelfLifeN,
        },
      });
      setSubmitting(false);
      if (!r.success) { showModalError(r.error); return; }
      const warn = r.data.warnings.length > 0 ? ` Warning: ${r.data.warnings.join(', ')}.` : '';
      onDone(`Product updated.${warn}`);
    }
  }

  return (
    <Dialog onClose={onCancel} busy={submitting}>
      <DialogContent showCloseButton={false} className="w-[min(56rem,calc(100%-2rem))] max-h-[92vh] gap-0 p-0">
        {/* Sticky header */}
        <header className="px-8 py-5 border-b border-border-subtle flex items-center justify-between gap-4 shrink-0">
          <div>
            <DialogTitle className="text-xl">
              {mode === 'add' ? 'Add product' : 'Edit product'}
            </DialogTitle>
            {mode === 'edit' && existing && (
              <div className="text-text-secondary text-sm font-mono mt-0.5">{existing.sku}</div>
            )}
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close" disabled={submitting} onClick={onCancel}><XIcon aria-hidden="true" /></Button>
        </header>

        {modalError && (
          <FeedbackBanner className="mx-8 mt-4 shrink-0">
            {modalError}
          </FeedbackBanner>
        )}

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-8 py-6 flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU">
            <Input value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())}
              disabled={mode === 'edit'} className="font-mono" />
          </Field>
          <Field label="Barcode (optional)">
            <Input value={barcode} onChange={(e) => setBarcode(e.target.value)} className="font-mono" />
          </Field>
        </div>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <NativeSelect value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </NativeSelect>
          </Field>
          <Field label="Brand (optional)">
            <Input value={brand} onChange={(e) => setBrand(e.target.value)} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Pack size (units)">
            <Input value={packSize} onChange={(e) => setPackSize(e.target.value.replace(/\D/g, ''))} className="font-mono tnum" />
          </Field>
          <Field label="Volume (ml)">
            <Input value={volumeMl} onChange={(e) => setVolumeMl(e.target.value.replace(/\D/g, ''))} className="font-mono tnum" />
          </Field>
          <Field label="Shelf life (days)">
            <Input value={shelfLife} onChange={(e) => setShelfLife(e.target.value.replace(/\D/g, ''))} className="font-mono tnum" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 items-end">
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="text-text-secondary">Returnable bottle?</span>
            <label className="flex h-10 items-center gap-2 rounded border border-border-strong bg-bg-input px-3">
              <input type="checkbox" className="size-4 accent-accent" checked={isReturnable} onChange={(e) => setIsReturnable(e.target.checked)} />
              <span className="text-sm text-text-primary">Has bottle deposit</span>
            </label>
          </div>
          <Field label="Deposit (cedis)">
            <Input value={deposit} onChange={(e) => setDeposit(e.target.value)} disabled={!isReturnable} className="font-mono tnum" />
          </Field>
        </div>
        <h4 className="eyebrow mt-2">Pricing (cedis)</h4>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Cost">
            <Input value={cost} onChange={(e) => setCost(e.target.value)} className="font-mono tnum" />
          </Field>
          <Field label="Walk-in">
            <Input value={walkIn} onChange={(e) => setWalkIn(e.target.value)} className="font-mono tnum" />
          </Field>
          <Field label="Wholesale">
            <Input value={wholesale} onChange={(e) => setWholesale(e.target.value)} className="font-mono tnum" />
          </Field>
          <Field label="Route">
            <Input value={route} onChange={(e) => setRoute(e.target.value)} className="font-mono tnum" />
          </Field>
        </div>
        {mode === 'edit' && (
          <Field label="Change reason">
            <Input value={priceReason} onChange={(e) => setPriceReason(e.target.value)} />
          </Field>
        )}
        <h4 className="eyebrow mt-2">Replenishment</h4>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Reorder threshold">
            <Input value={reorderThreshold} onChange={(e) => setReorderThreshold(e.target.value.replace(/\D/g, ''))} className="font-mono tnum" />
          </Field>
          <Field label="Reorder qty">
            <Input value={reorderQty} onChange={(e) => setReorderQty(e.target.value.replace(/\D/g, ''))} className="font-mono tnum" />
          </Field>
          <Field label="Lead time (days)">
            <Input value={leadTime} onChange={(e) => setLeadTime(e.target.value.replace(/\D/g, ''))} className="font-mono tnum" />
          </Field>
        </div>
        <h4 className="eyebrow mt-2">Cycle count class</h4>
        <div className="grid grid-cols-2 gap-3 items-end">
          <Field label="Count class">
            <NativeSelect value={countClass} onChange={(e) => setCountClass(e.target.value as 'A' | 'B' | 'C' | '')}>
              <option value="">— unclassified —</option>
              <option value="A">A — count weekly (top sellers)</option>
              <option value="B">B — count every 2-3 weeks</option>
              <option value="C">C — count monthly (long tail)</option>
            </NativeSelect>
          </Field>
          <div className="text-xs text-text-tertiary self-center">
            ABC class lets you target a stocktake to just the fast movers
            instead of counting the whole shop every time.
          </div>
        </div>
        {mode === 'add' && (
          <div className="rounded-xl border border-border bg-bg-surface p-4 flex flex-col gap-3">
            <h4 className="eyebrow">
              Sellable / purchasable units (optional)
            </h4>
            <div className="text-text-tertiary text-xs">
              Add CRATE, PACK, BAG_50KG, etc. now and they'll be created with the
              product in one go. You can also add them later from the edit view.
              Stock is tracked in the canonical single unit; each row's factor
              multiplies in (e.g. CRATE × 12 means one crate = 12 bottles).
            </div>

            {draftUnits.length > 0 && (
              <div className="rounded-lg border border-border-subtle bg-bg-elevated">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="px-3">Name</TableHead>
                    <TableHead className="px-3 text-right">Factor</TableHead>
                    <TableHead className="px-3 text-right">Price (each)</TableHead>
                    <TableHead className="px-3 text-center">Sale</TableHead>
                    <TableHead className="px-3 text-center">Purchase</TableHead>
                    <TableHead className="px-3"><span className="sr-only">Actions</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {draftUnits.map((u, idx) => (
                    <TableRow key={idx}>
                      <TableCell className="font-mono px-3 py-2">{u.unitName}</TableCell>
                      <TableCell className="text-right font-mono tnum px-3 py-2">× {u.conversionFactor}</TableCell>
                      <TableCell className="text-right font-mono tnum px-3 py-2">{formatMoney(u.pricePesewas)}</TableCell>
                      <TableCell className="text-center px-3 py-2"><YesNo value={u.isSaleUnit} /></TableCell>
                      <TableCell className="text-center px-3 py-2"><YesNo value={u.isPurchaseUnit} /></TableCell>
                      <TableCell className="text-right px-3 py-1">
                        <Button variant="ghost" size="sm" onClick={() => removeDraftUnit(idx)}>Remove</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            )}

            <div className="flex flex-col gap-3 border-t border-border pt-3">
              <div className="grid grid-cols-[1fr_7rem_9rem] gap-3">
                <Field label="Unit name">
                  <Input value={du_name} onChange={(e) => setDuName(e.target.value.toUpperCase())}
                    placeholder="CRATE, PACK, BAG_50KG…" className="font-mono" />
                </Field>
                <Field label="Factor">
                  <Input value={du_factor} onChange={(e) => setDuFactor(e.target.value.replace(/\D/g, ''))}
                    placeholder="12" className="font-mono tnum text-right" />
                </Field>
                <Field label="Price (cedis)">
                  <Input value={du_price} onChange={(e) => setDuPrice(e.target.value)}
                    placeholder="180.00" className="font-mono tnum text-right" />
                </Field>
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4 text-sm text-text-secondary">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="size-4 accent-accent" checked={du_sale} onChange={(e) => setDuSale(e.target.checked)} />
                    Sellable
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" className="size-4 accent-accent" checked={du_purchase} onChange={(e) => setDuPurchase(e.target.checked)} />
                    Purchasable
                  </label>
                </div>
                <Button type="button" onClick={addDraftUnit}>
                  <PlusIcon aria-hidden="true" />Add unit
                </Button>
              </div>
            </div>
            {draftUnits.some((u) => u.isSaleUnit) && (
              <label className="flex flex-col gap-1.5 text-sm border-t border-border pt-3">
                <span className="text-text-secondary">Default at the till</span>
                <NativeSelect value={defaultSaleUnitName} onChange={(e) => setDefaultSaleUnitName(e.target.value)}>
                  <option value="">— smallest (canonical)</option>
                  {draftUnits.filter((u) => u.isSaleUnit).map((u) => (
                    <option key={u.unitName} value={u.unitName}>
                      {u.unitName}{u.conversionFactor > 1 ? ` (× ${u.conversionFactor})` : ''}
                    </option>
                  ))}
                </NativeSelect>
                <span className="text-text-tertiary text-xs">
                  Which size shows up first when a cashier rings up this product.
                  Cashiers can still switch units at the till.
                </span>
              </label>
            )}
          </div>
        )}
        {mode === 'edit' && existing && (
          <ProductUnitsEditor
            productId={existing.id}
            initialPrimaryPurchaseUnitId={existing.primaryPurchaseUnitId}
            initialPrimarySaleUnitId={existing.primarySaleUnitId}
            onError={showModalError}
          />
        )}
        {mode === 'edit' && existing && (
          <PricingTiersEditor productId={existing.id} onError={showModalError} />
        )}
        </div>
        {/* Sticky footer */}
        <footer className="px-8 py-4 border-t border-border-subtle flex gap-3 justify-end shrink-0">
          <Button onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()}
            disabled={submitting || !sku.trim() || !name.trim()}>
            {submitting ? 'Saving…' : (mode === 'add' ? 'Add product' : 'Save changes')}
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function YesNo({ value }: { value: boolean }) {
  return value
    ? <CheckIcon className="mx-auto size-4 text-success" aria-label="Yes" />
    : <span className="text-text-tertiary" aria-label="No">—</span>;
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
      <div>
        <h4 className="text-text-secondary uppercase tracking-wider text-xs mb-1.5">Volume tiers</h4>
        <div className="text-text-tertiary text-xs">
          Apply automatically when cart line quantity meets the threshold.
          Channel ALL applies to walk-in, wholesale, and route.
        </div>
      </div>
      <Table className="border border-border-subtle">
        <TableHeader>
          <TableRow className="bg-bg-surface/60">
            <TableHead className="px-3">Channel</TableHead>
            <TableHead className="px-3">Applies to</TableHead>
            <TableHead className="text-right px-3">Min qty</TableHead>
            <TableHead className="text-right px-3">Unit price</TableHead>
            <TableHead className="px-3">Status</TableHead>
            <TableHead className="px-3"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tiers.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="px-3 py-2">{t.channel}</TableCell>
              <TableCell className="px-3 py-2 text-text-tertiary text-xs">{unitName(t.appliesToUnitId)}</TableCell>
              <TableCell className="text-right font-mono tnum px-3 py-2">{t.minQuantity}</TableCell>
              <TableCell className="text-right font-mono tnum px-3 py-2">{formatMoney(t.unitPricePesewas)}</TableCell>
              <TableCell className="px-3 py-2">{t.active ? <span className="text-success">active</span> : <span className="text-text-tertiary">inactive</span>}</TableCell>
              <TableCell className="text-right px-3 py-2">
                {t.active
                  ? <Button variant="link" className="text-text-tertiary hover:text-warning no-underline hover:underline text-xs" onClick={() => void deactivate(t)}>deactivate</Button>
                  : <Button variant="link" className="text-text-tertiary hover:text-success no-underline hover:underline text-xs" onClick={() => void reactivate(t)}>reactivate</Button>}
              </TableCell>
            </TableRow>
          ))}
          {tiers.length === 0 && (
            <TableRow><TableCell colSpan={6} className="text-text-tertiary text-center py-4 px-3">No tiers yet.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      <div className="flex flex-col gap-3 border-t border-border pt-3">
        <div className="grid grid-cols-4 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-text-secondary text-xs uppercase tracking-wider">Channel</span>
            <NativeSelect value={draftChannel} onChange={(e) => setDraftChannel(e.target.value as TierRow['channel'])}>
              {(['ALL', 'WALK_IN', 'WHOLESALE', 'ROUTE'] as const).map((c) => <option key={c}>{c}</option>)}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-text-secondary text-xs uppercase tracking-wider">Applies to</span>
            <NativeSelect value={draftUnitId} onChange={(e) => setDraftUnitId(e.target.value)}>
              <option value="">any unit</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>{u.unitName}{u.conversionFactor > 1 ? ` ×${u.conversionFactor}` : ''}</option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-text-secondary text-xs uppercase tracking-wider">Min qty</span>
            <Input className="font-mono tnum text-right" value={draftMinQty} onChange={(e) => setDraftMinQty(e.target.value.replace(/\D/g, ''))}
              placeholder="e.g. 12" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-text-secondary text-xs uppercase tracking-wider">Unit price (cedis)</span>
            <Input className="font-mono tnum text-right" value={draftPrice} onChange={(e) => setDraftPrice(e.target.value)}
              placeholder="e.g. 14.50" />
          </div>
        </div>
        <div className="flex justify-end">
          <Button variant="primary" className="whitespace-nowrap" onClick={() => void addOne()}>
            + Add tier
          </Button>
        </div>
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

function ProductUnitsEditor({
  productId, initialPrimaryPurchaseUnitId, initialPrimarySaleUnitId, onError,
}: {
  productId: string;
  initialPrimaryPurchaseUnitId: string | null;
  initialPrimarySaleUnitId: string | null;
  onError: (e: string) => void;
}) {
  const [primarySaved, setPrimarySaved] = useState(false);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [draftName, setDraftName] = useState('');
  const [draftFactor, setDraftFactor] = useState('');
  const [draftPrice, setDraftPrice] = useState('');
  const [draftIsSale, setDraftIsSale] = useState(true);
  const [draftIsPurchase, setDraftIsPurchase] = useState(true);
  const [primaryPurchaseUnitId, setPrimaryPurchaseUnitId] = useState<string>(initialPrimaryPurchaseUnitId ?? '');
  const [primarySaleUnitId, setPrimarySaleUnitId] = useState<string>(initialPrimarySaleUnitId ?? '');
  const [savingPrimary, setSavingPrimary] = useState(false);

  // Inline edit of an existing row — fix a typo'd name/factor/price without
  // having to deactivate-and-re-add (which the UNIQUE name constraint blocks).
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editFactor, setEditFactor] = useState('');
  const [editPrice, setEditPrice] = useState('');
  const [editSale, setEditSale] = useState(true);
  const [editPurchase, setEditPurchase] = useState(true);

  function startEdit(u: UnitRow) {
    setEditId(u.id);
    setEditName(u.unitName);
    setEditFactor(String(u.conversionFactor));
    setEditPrice(formatMoney(u.pricePesewas));
    setEditSale(u.isSaleUnit);
    setEditPurchase(u.isPurchaseUnit);
  }
  function cancelEdit() { setEditId(null); }

  async function saveEdit(u: UnitRow) {
    const name = editName.trim().toUpperCase();
    const factor = Number(editFactor.replace(/\D/g, ''));
    const price = parseCedisToPesewas(editPrice);
    if (!name || !factor || price == null) {
      onError('Name, factor, and price are all required.');
      return;
    }
    if (!editSale && !editPurchase) {
      onError('Mark as sellable, purchasable, or both.');
      return;
    }
    const r = await counter.updateProductUnit({
      unitId: u.id,
      fields: {
        unitName: name, conversionFactor: factor, pricePesewas: price,
        isSaleUnit: editSale, isPurchaseUnit: editPurchase,
      },
    });
    if (!r.success) { onError(r.error); return; }
    setEditId(null);
    await refresh();
  }

  async function refresh() {
    const r = await counter.listProductUnits(productId, false);
    if (r.success) setUnits(r.data.units as UnitRow[]);
  }
  useEffect(() => { void refresh(); }, [productId]);

  async function savePrimaryUnits() {
    setSavingPrimary(true);
    const r = await counter.updateProduct({
      productId,
      fields: {
        primaryPurchaseUnitId: primaryPurchaseUnitId || null,
        primarySaleUnitId: primarySaleUnitId || null,
      },
    });
    setSavingPrimary(false);
    if (!r.success) { onError(r.error); return; }
    setPrimarySaved(true);
    setTimeout(() => setPrimarySaved(false), 2500);
  }

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
      <div>
        <h4 className="text-text-secondary uppercase tracking-wider text-xs mb-1.5">Sellable / purchasable units</h4>
        <div className="text-text-tertiary text-xs leading-relaxed">
          Define every way you transact this product — BOTTLE, CRATE, BAG_50KG.
          Stock is tracked in the smallest unit; the factor is how many smallest-units
          are in that row (CRATE × 12 = 12 bottles per crate). If you only ever sell
          whole boxes, just add ONE row with factor 1.
        </div>
      </div>
      <Table className="border border-border-subtle">
        <TableHeader>
          <TableRow className="bg-bg-deep/60">
            <TableHead className="px-3">Name</TableHead>
            <TableHead className="text-right px-3">Factor</TableHead>
            <TableHead className="text-right px-3">Price (each)</TableHead>
            <TableHead className="text-center px-3">Sale</TableHead>
            <TableHead className="text-center px-3">Purchase</TableHead>
            <TableHead className="px-3">Status</TableHead>
            <TableHead className="px-3"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {units.map((u) => (
            editId === u.id ? (
              <TableRow key={u.id} className="bg-bg-deep/40">
                <TableCell className="px-2 py-1.5">
                  <Input className="font-mono h-8 px-2" value={editName} onChange={(e) => setEditName(e.target.value.toUpperCase())} />
                </TableCell>
                <TableCell className="px-2 py-1.5">
                  <Input className="font-mono tnum text-right h-8 px-2" value={editFactor} onChange={(e) => setEditFactor(e.target.value.replace(/\D/g, ''))} />
                </TableCell>
                <TableCell className="px-2 py-1.5">
                  <Input className="font-mono tnum text-right h-8 px-2" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} />
                </TableCell>
                <TableCell className="text-center px-2 py-1.5">
                  <input type="checkbox" checked={editSale} onChange={(e) => setEditSale(e.target.checked)} />
                </TableCell>
                <TableCell className="text-center px-2 py-1.5">
                  <input type="checkbox" checked={editPurchase} onChange={(e) => setEditPurchase(e.target.checked)} />
                </TableCell>
                <TableCell className="px-3 py-1.5">{u.active ? <span className="text-success">active</span> : <span className="text-text-tertiary">inactive</span>}</TableCell>
                <TableCell className="text-right px-3 py-1.5 whitespace-nowrap">
                  <Button variant="link" className="text-accent hover:text-accent-light no-underline hover:underline text-xs" onClick={() => void saveEdit(u)}>save</Button>
                  <Button variant="link" className="text-text-tertiary hover:text-text-primary ml-3 no-underline hover:underline text-xs" onClick={cancelEdit}>cancel</Button>
                </TableCell>
              </TableRow>
            ) : (
            <TableRow key={u.id}>
              <TableCell className="font-mono px-3 py-2">{u.unitName}</TableCell>
              <TableCell className="text-right font-mono tnum px-3 py-2">× {u.conversionFactor}</TableCell>
              <TableCell className="text-right font-mono tnum px-3 py-2">{formatMoney(u.pricePesewas)}</TableCell>
              <TableCell className="text-center px-3 py-2"><YesNo value={u.isSaleUnit} /></TableCell>
              <TableCell className="text-center px-3 py-2"><YesNo value={u.isPurchaseUnit} /></TableCell>
              <TableCell className="px-3 py-2">{u.active ? <span className="text-success">active</span> : <span className="text-text-tertiary">inactive</span>}</TableCell>
              <TableCell className="text-right px-3 py-2 whitespace-nowrap">
                <Button variant="link" className="text-text-tertiary hover:text-text-primary no-underline hover:underline text-xs" onClick={() => startEdit(u)}>edit</Button>
                {u.active
                  ? <Button variant="link" className="text-text-tertiary hover:text-warning ml-3 no-underline hover:underline text-xs" onClick={() => void deactivate(u)}>deactivate</Button>
                  : <Button variant="link" className="text-text-tertiary hover:text-success ml-3 no-underline hover:underline text-xs" onClick={() => void reactivate(u)}>reactivate</Button>}
              </TableCell>
            </TableRow>
            )
          ))}
          {units.length === 0 && (
            <TableRow><TableCell colSpan={7} className="text-text-tertiary text-center py-4 px-3">No units defined yet.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      <div className="flex flex-col gap-3 border-t border-border pt-3">
        <div className="grid grid-cols-[1fr_7rem_9rem] gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-text-secondary text-xs uppercase tracking-wider">Unit name</span>
            <Input className="font-mono" value={draftName} onChange={(e) => setDraftName(e.target.value.toUpperCase())}
              placeholder="CRATE, PACK, BAG_50KG…" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-text-secondary text-xs uppercase tracking-wider">Factor</span>
            <Input className="font-mono tnum text-right" value={draftFactor} onChange={(e) => setDraftFactor(e.target.value.replace(/\D/g, ''))}
              placeholder="24" />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-text-secondary text-xs uppercase tracking-wider">Price (cedis)</span>
            <Input className="font-mono tnum text-right" value={draftPrice} onChange={(e) => setDraftPrice(e.target.value)}
              placeholder="180.00" />
          </div>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 text-sm text-text-secondary">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={draftIsSale} onChange={(e) => setDraftIsSale(e.target.checked)} />
              Sellable
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={draftIsPurchase} onChange={(e) => setDraftIsPurchase(e.target.checked)} />
              Purchasable
            </label>
          </div>
          <Button variant="primary" className="whitespace-nowrap" onClick={() => void addOne()}>
            + Add unit
          </Button>
        </div>
      </div>

      {units.length > 0 && (
        <div className="border-t border-border pt-3 mt-1 flex flex-col gap-2">
          <div className="text-text-secondary uppercase tracking-wider text-xs">Default units</div>
          <div className="text-text-tertiary text-xs">
            Pick which unit shows up first at the till (sale) and on the stock-receive screen
            (purchase). These are display defaults — cashiers can still pick any unit at the moment.
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-text-secondary text-xs uppercase tracking-wider">Default at the till</span>
              <NativeSelect value={primarySaleUnitId} onChange={(e) => setPrimarySaleUnitId(e.target.value)}>
                <option value="">— smallest (canonical)</option>
                {units.filter((u) => u.isSaleUnit && u.active).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.unitName}{u.conversionFactor > 1 ? ` (× ${u.conversionFactor})` : ''}
                  </option>
                ))}
              </NativeSelect>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-text-secondary text-xs uppercase tracking-wider">Default on receive</span>
              <NativeSelect value={primaryPurchaseUnitId} onChange={(e) => setPrimaryPurchaseUnitId(e.target.value)}>
                <option value="">— smallest (canonical)</option>
                {units.filter((u) => u.isPurchaseUnit && u.active).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.unitName}{u.conversionFactor > 1 ? ` (× ${u.conversionFactor})` : ''}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </div>
          <div className="flex justify-end items-center gap-3">
            {primarySaved && (
              <span className="inline-flex items-center gap-1 text-success text-xs"><CheckIcon aria-hidden="true" className="size-3.5" />Saved</span>
            )}
            <Button size="sm" onClick={() => void savePrimaryUnits()} disabled={savingPrimary}>
              {savingPrimary ? 'Saving…' : 'Save default units'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
