// Pricing tiers admin tab — list, add, edit, deactivate.
//
// Tiers apply automatically at sale time when a cart line's quantity hits
// the tier's min_quantity (see SaleScreen tier auto-apply). Owner can scope
// a tier to one specific unit (e.g. only CRATE) by setting appliesToUnitId.
//
// OWNER/FOUNDER gate is enforced server-side; the tab still renders for
// other roles but write buttons say "admin only".

import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { useSession } from '../../store/session';
import { formatMoney, parseCedisToPesewas } from '../../../shared/lib/money';
import type { PricingTierRow, PricingChannel } from '../../../shared/types/ipc';

interface AdminProduct {
  id: string; sku: string; name: string;
  walkInPricePesewas: number;
  units: Array<{ id: string; unitName: string; conversionFactor: number }>;
  active: boolean;
}

const CHANNELS: PricingChannel[] = ['ALL', 'WALK_IN', 'WHOLESALE', 'ROUTE'];

export function PricingTiersTab() {
  const myRole = useSession((s) => s.workerRole);
  const isAdmin = myRole === 'OWNER' || myRole === 'FOUNDER';

  const [products, setProducts] = useState<AdminProduct[]>([]);
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tiers, setTiers] = useState<PricingTierRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add-tier form state
  const [addChannel, setAddChannel] = useState<PricingChannel>('WHOLESALE');
  const [addMinQty, setAddMinQty] = useState('');
  const [addPriceRaw, setAddPriceRaw] = useState('');
  const [addUnitId, setAddUnitId] = useState<string>(''); // '' = any unit
  const [addPriority, setAddPriority] = useState('0');
  const [addNotes, setAddNotes] = useState('');

  // Edit-tier inline state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPriceRaw, setEditPriceRaw] = useState('');
  const [editPriority, setEditPriority] = useState('0');

  async function refreshProducts() {
    const r = await counter.adminListProducts();
    if (r.success) setProducts(r.data.products as unknown as AdminProduct[]);
  }
  async function refreshTiers(productId: string) {
    const r = await counter.listPricingTiersForProduct(productId);
    if (r.success) setTiers(r.data.tiers);
    else setError(r.error);
  }

  useEffect(() => { void refreshProducts(); }, []);
  useEffect(() => {
    if (selectedId) void refreshTiers(selectedId);
    else setTiers([]);
  }, [selectedId]);

  const selected = selectedId ? products.find((p) => p.id === selectedId) ?? null : null;
  const filteredProducts = products.filter((p) => {
    if (!p.active) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return p.sku.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
  });
  const visibleTiers = tiers.filter((t) => showInactive || t.active);

  async function add() {
    if (!selectedId) return;
    setError(null);
    const minQty = parseInt(addMinQty, 10);
    const price = parseCedisToPesewas(addPriceRaw);
    if (!Number.isInteger(minQty) || minQty <= 0) {
      setError('Min quantity must be a positive integer.');
      return;
    }
    if (price == null || price < 0) {
      setError('Price must be a non-negative number.');
      return;
    }
    const r = await counter.addPricingTier({
      productId: selectedId,
      channel: addChannel,
      minQuantity: minQty,
      unitPricePesewas: price,
      priority: parseInt(addPriority, 10) || 0,
      appliesToUnitId: addUnitId || null,
      notes: addNotes.trim() || null,
    });
    if (!r.success) { setError(r.error); return; }
    setInfo(`Added tier: ${addChannel} @ ${minQty}+ → ${formatMoney(price)}`);
    setAddMinQty(''); setAddPriceRaw(''); setAddUnitId('');
    setAddPriority('0'); setAddNotes('');
    await refreshTiers(selectedId);
    setTimeout(() => setInfo(null), 4000);
  }

  function startEdit(t: PricingTierRow) {
    setEditingId(t.id);
    setEditPriceRaw((t.unitPricePesewas / 100).toFixed(2));
    setEditPriority(String(t.priority));
  }

  async function saveEdit(t: PricingTierRow) {
    setError(null);
    const price = parseCedisToPesewas(editPriceRaw);
    if (price == null || price < 0) { setError('Price must be a non-negative number.'); return; }
    const r = await counter.updatePricingTier({
      tierId: t.id,
      fields: {
        unitPricePesewas: price,
        priority: parseInt(editPriority, 10) || 0,
      },
    });
    if (!r.success) { setError(r.error); return; }
    setEditingId(null);
    if (selectedId) await refreshTiers(selectedId);
  }

  async function toggle(t: PricingTierRow) {
    setError(null);
    const r = t.active
      ? await counter.deactivatePricingTier(t.id)
      : await counter.reactivatePricingTier(t.id);
    if (!r.success) { setError(r.error); return; }
    if (selectedId) await refreshTiers(selectedId);
  }

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Left: product picker. Full-width on small windows so the picker
       *  stays usable; collapses to a 18rem sidebar at lg+ widths. */}
      <div className="w-full lg:w-72 xl:w-80 lg:flex-shrink-0 flex flex-col gap-2">
        <input
          autoFocus
          placeholder="Filter SKU or name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-bg-deep border border-border-subtle px-3 py-2 text-sm rounded"
        />
        <div className="border border-border-subtle rounded max-h-[40vh] lg:max-h-[70vh] overflow-auto">
          {filteredProducts.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`w-full text-left px-3 py-2 text-sm border-b border-border-subtle last:border-b-0 ${
                selectedId === p.id ? 'bg-bg-elevated' : 'hover:bg-bg-elevated'
              }`}
            >
              <div className="font-mono tnum text-xs text-text-secondary">{p.sku}</div>
              <div className="text-text-primary">{p.name}</div>
              <div className="text-text-tertiary text-xs">Walk-in {formatMoney(p.walkInPricePesewas)}</div>
            </button>
          ))}
          {filteredProducts.length === 0 && (
            <div className="p-3 text-text-tertiary text-sm">No products match.</div>
          )}
        </div>
      </div>

      {/* Right: tiers for the selected product */}
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {!selected && (
          <div className="text-text-tertiary text-sm">Select a product on the left to manage its pricing tiers.</div>
        )}

        {selected && (
          <>
            <div className="flex items-baseline justify-between">
              <div>
                <div className="text-text-secondary uppercase tracking-wider text-xs">Pricing tiers for</div>
                <div className="text-xl font-semibold">{selected.name}</div>
                <div className="text-text-tertiary text-xs font-mono tnum">{selected.sku}</div>
              </div>
              <label className="text-sm flex items-center gap-2 text-text-secondary">
                <input
                  type="checkbox"
                  checked={showInactive}
                  onChange={(e) => setShowInactive(e.target.checked)}
                />
                Show inactive
              </label>
            </div>

            {info && <div className="border border-success bg-success/10 text-success px-3 py-2 rounded text-sm">{info}</div>}
            {error && <div className="border border-danger bg-danger/10 text-danger px-3 py-2 rounded text-sm">{error}</div>}

            {/* Tier table */}
            <div className="overflow-x-auto border border-border-subtle rounded">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-bg-elevated text-text-secondary text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-3 py-2 text-left">Channel</th>
                  <th className="px-3 py-2 text-right">Min qty</th>
                  <th className="px-3 py-2 text-right">Unit price</th>
                  <th className="px-3 py-2 text-left">Unit scope</th>
                  <th className="px-3 py-2 text-right">Priority</th>
                  <th className="px-3 py-2 text-left">Notes</th>
                  <th className="px-3 py-2 text-right">Status</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {visibleTiers.map((t) => {
                  const unitName = t.appliesToUnitId
                    ? selected.units.find((u) => u.id === t.appliesToUnitId)?.unitName ?? '?'
                    : 'Any';
                  const isEditing = editingId === t.id;
                  return (
                    <tr key={t.id} className={`border-t border-border-subtle ${t.active ? '' : 'opacity-50'}`}>
                      <td className="px-3 py-2">{t.channel}</td>
                      <td className="px-3 py-2 text-right font-mono tnum">{t.minQuantity}</td>
                      <td className="px-3 py-2 text-right font-mono tnum">
                        {isEditing ? (
                          <input
                            value={editPriceRaw}
                            onChange={(e) => setEditPriceRaw(e.target.value)}
                            className="bg-bg-deep border border-border-subtle px-2 py-1 text-right w-20 rounded"
                          />
                        ) : (
                          formatMoney(t.unitPricePesewas)
                        )}
                      </td>
                      <td className="px-3 py-2">{unitName}</td>
                      <td className="px-3 py-2 text-right font-mono tnum">
                        {isEditing ? (
                          <input
                            value={editPriority}
                            onChange={(e) => setEditPriority(e.target.value)}
                            className="bg-bg-deep border border-border-subtle px-2 py-1 text-right w-12 rounded"
                          />
                        ) : (
                          t.priority
                        )}
                      </td>
                      <td className="px-3 py-2 text-text-tertiary text-xs">{t.notes ?? ''}</td>
                      <td className="px-3 py-2 text-right">{t.active ? 'Active' : 'Inactive'}</td>
                      <td className="px-3 py-2 text-right">
                        {isAdmin && isEditing && (
                          <div className="flex gap-1 justify-end">
                            <button
                              onClick={() => saveEdit(t)}
                              className="bg-accent text-bg-deep px-2 py-1 text-xs rounded hover:bg-accent-light"
                            >
                              Save
                            </button>
                            <button
                              onClick={() => setEditingId(null)}
                              className="border border-border px-2 py-1 text-xs rounded hover:bg-bg-elevated"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                        {isAdmin && !isEditing && (
                          <div className="flex gap-1 justify-end">
                            <button
                              onClick={() => startEdit(t)}
                              className="border border-border px-2 py-1 text-xs rounded hover:bg-bg-elevated"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => toggle(t)}
                              className="border border-border px-2 py-1 text-xs rounded hover:bg-bg-elevated"
                            >
                              {t.active ? 'Deactivate' : 'Reactivate'}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visibleTiers.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-3 py-6 text-center text-text-tertiary text-sm">
                      No tiers yet for this product.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </div>

            {/* Add-tier form. Each field is wrapped with a label so the form
             *  can wrap onto multiple rows on narrow widths without losing
             *  context. The Add button sits at the end and stretches on
             *  small windows to remain easy to hit. */}
            {isAdmin && (
              <div className="border border-border-subtle rounded p-4 space-y-3">
                <div className="text-text-secondary uppercase tracking-wider text-xs">Add tier</div>
                <div className="flex flex-wrap gap-3 items-end">
                  <Field label="Channel" className="w-32">
                    <select
                      value={addChannel}
                      onChange={(e) => setAddChannel(e.target.value as PricingChannel)}
                      className="w-full bg-bg-deep border border-border-subtle px-2 py-2 rounded text-sm"
                    >
                      {CHANNELS.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Min qty" className="w-24">
                    <input
                      type="number"
                      min={1}
                      placeholder="0"
                      value={addMinQty}
                      onChange={(e) => setAddMinQty(e.target.value)}
                      className="w-full bg-bg-deep border border-border-subtle px-2 py-2 rounded text-sm font-mono tnum"
                    />
                  </Field>
                  <Field label="Unit price (GHS)" className="w-32">
                    <input
                      placeholder="0.00"
                      value={addPriceRaw}
                      onChange={(e) => setAddPriceRaw(e.target.value)}
                      className="w-full bg-bg-deep border border-border-subtle px-2 py-2 rounded text-sm font-mono tnum"
                    />
                  </Field>
                  <Field label="Unit scope" className="w-44">
                    <select
                      value={addUnitId}
                      onChange={(e) => setAddUnitId(e.target.value)}
                      className="w-full bg-bg-deep border border-border-subtle px-2 py-2 rounded text-sm"
                    >
                      <option value="">Any unit</option>
                      {selected.units.map((u) => (
                        <option key={u.id} value={u.id}>{u.unitName} (×{u.conversionFactor})</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Priority" className="w-20">
                    <input
                      type="number"
                      placeholder="0"
                      value={addPriority}
                      onChange={(e) => setAddPriority(e.target.value)}
                      className="w-full bg-bg-deep border border-border-subtle px-2 py-2 rounded text-sm font-mono tnum"
                    />
                  </Field>
                  <Field label="Notes" className="flex-1 min-w-[12rem]">
                    <input
                      placeholder="(optional)"
                      value={addNotes}
                      onChange={(e) => setAddNotes(e.target.value)}
                      className="w-full bg-bg-deep border border-border-subtle px-2 py-2 rounded text-sm"
                    />
                  </Field>
                  <button
                    onClick={add}
                    className="bg-accent text-bg-deep px-5 py-2 rounded text-sm font-semibold hover:bg-accent-light h-[38px]"
                  >
                    Add
                  </button>
                </div>
                <div className="text-text-tertiary text-xs">
                  Channel <strong>ALL</strong> applies to walk-in, wholesale, and route. Higher priority wins ties.
                </div>
              </div>
            )}
            {!isAdmin && (
              <div className="text-text-tertiary text-sm">Admin only — sign in as OWNER/FOUNDER to add or edit tiers.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ''}`}>
      <span className="text-text-tertiary text-xs uppercase tracking-wider">{label}</span>
      {children}
    </label>
  );
}
