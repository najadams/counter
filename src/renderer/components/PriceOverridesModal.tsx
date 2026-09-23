// PriceOverridesModal — admin UI for per-customer price overrides.
//
// Lists active overrides for a customer, lets OWNERs add new ones (product
// + unit + optional channel + price), edit the price/notes, or deactivate.
// Used from CustomerDetailScreen.
//
// Wave C.2.

import { PlusIcon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import type { CpoOverrideRow } from '../../shared/types/ipc';
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

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
    <Dialog onClose={onClose}>
      <DialogContent showCloseButton={false} className="w-[min(48rem,calc(100%-2rem))] max-h-[90vh] gap-0 p-0">
        <header className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border">
          <div>
            <DialogTitle>Price overrides</DialogTitle>
            <DialogDescription className="text-xs mt-1">For {customerName}</DialogDescription>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}><XIcon aria-hidden="true" /></Button>
        </header>

        <div className="p-6 space-y-4 overflow-y-auto">
          {error && (
            <FeedbackBanner>
              {error}
            </FeedbackBanner>
          )}

          {!isOwner && (
            <div className="notice notice-warning">
              You can view overrides, but only an OWNER can add or change them.
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="px-2">Product</TableHead>
                <TableHead className="px-2">Unit</TableHead>
                <TableHead className="px-2">Channel</TableHead>
                <TableHead className="px-2 text-right">Price</TableHead>
                <TableHead className="px-2"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="px-2 py-2">{r.productName}</TableCell>
                  <TableCell className="px-2 py-2">{r.unitName}</TableCell>
                  <TableCell className="px-2 py-2 text-text-tertiary">{r.channel ?? 'any'}</TableCell>
                  <TableCell className="px-2 py-2 text-right font-mono tnum">{formatMoney(r.pricePesewas)}</TableCell>
                  <TableCell className="px-2 py-2 text-right">
                    {isOwner && (
                      <Button variant="ghost" size="sm" className="text-danger" onClick={() => void deactivate(r.id)}>Remove</Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow><TableCell colSpan={5} className="px-2 py-4 text-text-tertiary text-center">
                  No overrides configured. Falls through to channel/tier pricing.
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>

          {isOwner && !adding && (
            <Button variant="primary" onClick={() => setAdding(true)}><PlusIcon aria-hidden="true" />Add override</Button>
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
      </DialogContent>
    </Dialog>
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
    <div className="rounded-lg border border-border p-4 space-y-3 bg-bg-surface">
      <div className="text-sm font-semibold">New override</div>

      <div className="relative">
        <Field label="Product">
          <Input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPicked(null); }}
            placeholder="search by name or SKU"
          />
        </Field>
        {hits.length > 0 && !picked && (
          <ul className="absolute left-0 right-0 top-full mt-1 rounded-lg bg-bg-elevated border border-border shadow-overlay max-h-48 overflow-auto z-10">
            {hits.map((p) => (
              <li key={p.id}>
                <button onClick={() => void pick(p)}
                  className="w-full text-left px-3 py-2 hover:bg-bg-surface text-sm">
                  <div>{p.name}</div>
                  <div className="text-text-tertiary text-xs font-mono">{p.sku} · {formatMoney(p.unitPricePesewas)}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {picked && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Unit">
              <NativeSelect value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.unitName} ({formatMoney(u.pricePesewas)})
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Channel">
              <NativeSelect value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)}>
                {CHANNELS.map((c) => (
                  <option key={c || 'any'} value={c}>{c === '' ? 'Any channel' : c}</option>
                ))}
              </NativeSelect>
            </Field>
          </div>

          <Field label="Override price (cedis per unit)">
            <Input
              value={priceCedis}
              onChange={(e) => setPriceCedis(e.target.value)}
              placeholder="e.g. 7.50" inputMode="decimal"
              className="font-mono tnum"
            />
          </Field>

          <Field label="Notes (optional)">
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="why this price was agreed"
            />
          </Field>
        </>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={() => void submit()} disabled={!picked || !unitId || !priceCedis}>
          Save
        </Button>
      </div>
    </div>
  );
}

export default PriceOverridesModal;
