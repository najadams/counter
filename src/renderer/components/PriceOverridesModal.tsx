// PriceOverridesModal — admin UI for per-customer price overrides.
//
// Lists active overrides for a customer, lets OWNERs add new ones (product
// + unit + optional channel + price), edit the price/notes, or deactivate.
// Used from CustomerDetailScreen.
//
// Wave C.2.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import type { CpoOverrideRow } from '../../shared/types/ipc';

interface Props {
  customerId: string;
  customerName: string;
  onClose: () => void;
}

interface ProductHit {
  id: string;
  name: string;
  sku: string;
  unitPricePesewas: number;
}

interface UnitRow {
  id: string;
  unitName: string;
  conversionFactor: number;
  pricePesewas: number;
}

const CHANNELS: Array<'' | 'WALK_IN' | 'WHOLESALE' | 'ROUTE'> = [
  '', 'WALK_IN', 'WHOLESALE', 'ROUTE',
];

export function PriceOverridesModal({ customerId, customerName, onClose }: Props): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';

  const [rows, setRows] = useState<CpoOverrideRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function refresh() {
    const r = await counter.cpoListForCustomer(customerId);
    if (!r.success) { setError(r.error); return; }
    setRows(r.data.rows);
  }
  useEffect(() => { void refresh(); }, [customerId]);

  async function deactivate(id: string) {
    if (!confirm('Deactivate this override?')) return;
    const r = await counter.cpoDeactivate(id);
    if (!r.success) { setError(r.error); return; }
    void refresh();
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-auto border border-border">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold">Price overrides</h2>
            <div className="text-xs text-text-tertiary mt-1">For {customerName}</div>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 rounded text-sm">
              {error}
            </div>
          )}

          {!isOwner && (
            <div className="border border-warning bg-warning/10 text-warning px-3 py-2 rounded text-sm">
              You can view overrides, but only an OWNER can add or change them.
            </div>
          )}

          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-secondary text-xs uppercase tracking-wider border-b border-border">
                <th className="px-2 py-2 text-left">Product</th>
                <th className="px-2 py-2 text-left">Unit</th>
                <th className="px-2 py-2 text-left">Channel</th>
                <th className="px-2 py-2 text-right">Price</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border">
                  <td className="px-2 py-2">{r.productName}</td>
                  <td className="px-2 py-2">{r.unitName}</td>
                  <td className="px-2 py-2 text-text-tertiary">{r.channel ?? 'any'}</td>
                  <td className="px-2 py-2 text-right font-mono tnum">{formatMoney(r.pricePesewas)}</td>
                  <td className="px-2 py-2 text-right">
                    {isOwner && (
                      <button
                        onClick={() => void deactivate(r.id)}
                        className="text-xs underline text-danger hover:text-danger-light">
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={5} className="px-2 py-4 text-text-tertiary text-center">
                  No overrides configured. Falls through to channel/tier pricing.
                </td></tr>
              )}
            </tbody>
          </table>

          {isOwner && !adding && (
            <button onClick={() => setAdding(true)}
              className="bg-accent text-bg-deep px-4 py-2 font-semibold text-sm hover:bg-accent-light">
              + Add override
            </button>
          )}

          {isOwner && adding && (
            <AddOverrideForm
              customerId={customerId}
              onCancel={() => setAdding(false)}
              onAdded={() => { setAdding(false); void refresh(); }}
              onError={(e) => setError(e)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function AddOverrideForm({
  customerId, onCancel, onAdded, onError,
}: {
  customerId: string;
  onCancel: () => void;
  onAdded: () => void;
  onError: (e: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [picked, setPicked] = useState<ProductHit | null>(null);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [unitId, setUnitId] = useState('');
  const [channel, setChannel] = useState<'' | 'WALK_IN' | 'WHOLESALE' | 'ROUTE'>('');
  const [priceCedis, setPriceCedis] = useState('');
  const [notes, setNotes] = useState('');

  async function search() {
    if (query.trim().length < 2) { setHits([]); return; }
    const r = await counter.searchProducts(query.trim(), 'WHOLESALE');
    if (r.success) {
      setHits(r.data.products.map((p) => ({
        id: p.id, name: p.name, sku: p.sku, unitPricePesewas: p.unitPricePesewas,
      })));
    }
  }
  useEffect(() => {
    const t = setTimeout(() => { void search(); }, 200);
    return () => clearTimeout(t);
  }, [query]);

  async function pick(p: ProductHit) {
    setPicked(p);
    setHits([]);
    setQuery(p.name);
    const r = await counter.listProductUnits(p.id);
    if (r.success) {
      setUnits(r.data.units);
      const dflt = [...r.data.units].sort((a, b) => a.displayOrder - b.displayOrder)[0];
      if (dflt) { setUnitId(dflt.id); setPriceCedis(''); }
    }
  }

  async function submit() {
    if (!picked || !unitId) { onError('Pick a product and unit first.'); return; }
    const pesewas = parseCedisToPesewas(priceCedis);
    if (pesewas === null || pesewas <= 0) { onError('Enter a positive cedi amount.'); return; }
    const r = await counter.cpoAdd({
      customerId, productId: picked.id, appliesToUnitId: unitId,
      channel: channel === '' ? null : channel,
      pricePesewas: pesewas, notes: notes.trim() || null,
    });
    if (!r.success) { onError(r.error); return; }
    onAdded();
  }

  return (
    <div className="border border-border rounded p-4 space-y-3 bg-bg-deep">
      <div className="text-sm font-semibold">New override</div>

      <div className="space-y-1 relative">
        <label className="text-xs text-text-secondary">Product</label>
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPicked(null); }}
          placeholder="search by name or SKU"
          className="w-full bg-bg-surface border border-border px-3 py-2 text-sm"
        />
        {hits.length > 0 && !picked && (
          <ul className="absolute left-0 right-0 top-full mt-1 bg-bg-surface border border-border max-h-48 overflow-auto z-10">
            {hits.map((p) => (
              <li key={p.id}>
                <button onClick={() => void pick(p)}
                  className="w-full text-left px-3 py-2 hover:bg-bg-elevated text-sm">
                  <div>{p.name}</div>
                  <div className="text-text-tertiary text-xs">{p.sku} · {formatMoney(p.unitPricePesewas)}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {picked && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Unit</label>
              <select
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
                className="w-full bg-bg-surface border border-border px-3 py-2 text-sm">
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.unitName} ({formatMoney(u.pricePesewas)})
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-text-secondary">Channel</label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as typeof channel)}
                className="w-full bg-bg-surface border border-border px-3 py-2 text-sm">
                {CHANNELS.map((c) => (
                  <option key={c || 'any'} value={c}>{c === '' ? 'Any channel' : c}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Override price (cedis per unit)</label>
            <input
              value={priceCedis}
              onChange={(e) => setPriceCedis(e.target.value)}
              placeholder="e.g. 7.50"
              className="w-full bg-bg-surface border border-border px-3 py-2 text-sm font-mono"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-secondary">Notes (optional)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="why this price was agreed"
              className="w-full bg-bg-surface border border-border px-3 py-2 text-sm"
            />
          </div>
        </>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <button onClick={onCancel}
          className="px-3 py-2 border border-border text-sm hover:bg-bg-elevated">Cancel</button>
        <button onClick={() => void submit()} disabled={!picked || !unitId || !priceCedis}
          className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50">
          Save
        </button>
      </div>
    </div>
  );
}

export default PriceOverridesModal;
