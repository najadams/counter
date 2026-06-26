// CorrectSaleModal — additive sale correction (Approach A).
//
// Shows the original lines (read-only), lets the cashier search and ADD the
// missed items, shows the new total + the extra to collect, and calls
// correctSale (which voids the original + re-rings it + prints one CORRECTED
// receipt). Additive only: original lines can't be edited here.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';

interface RecentSale {
  id: string; channel: string; totalPesewas: number; workerName: string;
}
interface OrigLine { productName: string; quantity: number; unitPricePesewas: number; unitName: string; }
interface Addition {
  productId: string; name: string; unitId: string | undefined; unitName: string;
  quantity: number; unitPricePesewas: number;
}
type Hit = {
  id: string; name: string; sku: string; unitPricePesewas: number;
  defaultUnitId: string | null; defaultUnitName: string;
};

export function CorrectSaleModal({ sale, onCancel, onDone }: {
  sale: RecentSale; onCancel: () => void; onDone: (msg: string) => void;
}) {
  const [origLines, setOrigLines] = useState<OrigLine[]>([]);
  const [additions, setAdditions] = useState<Addition[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void counter.getSaleLines(sale.id).then((r) => {
      if (r.success) setOrigLines(r.data.lines.map((l) => ({
        productName: l.productName, quantity: l.quantity,
        unitPricePesewas: l.unitPricePesewas, unitName: l.unitName,
      })));
    });
  }, [sale.id]);

  useEffect(() => {
    if (query.trim() === '') { setHits([]); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await counter.searchProducts(query, sale.channel as 'WALK_IN' | 'WHOLESALE' | 'ROUTE', 8);
      if (!cancelled && r.success) {
        setHits(r.data.products.map((p) => ({
          id: p.id, name: p.name, sku: p.sku, unitPricePesewas: p.unitPricePesewas,
          defaultUnitId: p.defaultUnitId, defaultUnitName: p.defaultUnitName,
        })));
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, sale.channel]);

  function addHit(h: Hit) {
    setAdditions((cur) => {
      const existing = cur.findIndex((a) => a.productId === h.id && a.unitId === (h.defaultUnitId ?? undefined));
      if (existing >= 0) {
        const next = [...cur];
        next[existing] = { ...next[existing]!, quantity: next[existing]!.quantity + 1 };
        return next;
      }
      return [...cur, {
        productId: h.id, name: h.name, unitId: h.defaultUnitId ?? undefined,
        unitName: h.defaultUnitName, quantity: 1, unitPricePesewas: h.unitPricePesewas,
      }];
    });
    setQuery(''); setHits([]);
  }

  function setQty(i: number, q: number) {
    setAdditions((cur) => {
      if (q <= 0) return cur.filter((_, idx) => idx !== i);
      const next = [...cur]; next[i] = { ...next[i]!, quantity: q }; return next;
    });
  }

  const delta = additions.reduce((s, a) => s + a.quantity * a.unitPricePesewas, 0);
  const newTotal = sale.totalPesewas + delta;

  async function submit() {
    if (additions.length === 0) return;
    setBusy(true); setError(null);
    const r = await counter.correctSale({
      originalSaleId: sale.id,
      addedLines: additions.map((a) => ({
        productId: a.productId, quantity: a.quantity,
        unitPricePesewas: a.unitPricePesewas, unitId: a.unitId,
      })),
      payments: [{ method: 'CASH', amountPesewas: newTotal, cashGivenPesewas: newTotal }],
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    const d = r.data;
    onDone(`Corrected #${sale.id.slice(-6)} → new #${d.newSaleId.slice(-6)}. Collected ${formatMoneyWithCurrency(d.deltaPesewas)} extra.${d.printerFailed ? ' ⚠ Receipt failed — send to counter.' : ''}`);
  }

  return (
    <div className="fixed inset-0 bg-scrim z-50 flex sm:items-center sm:justify-center" onClick={onCancel}>
      {/* Full-screen + scrollable on a phone (so the keyboard never hides the
          search results or the confirm button); a centred card on desktop. */}
      <div
        className="bg-bg-surface w-full h-full sm:h-auto sm:max-w-lg sm:max-h-[90vh] overflow-y-auto p-4 sm:p-6 flex flex-col gap-4 sm:border sm:border-border sm:rounded"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-text-secondary uppercase tracking-wider text-xs">Correct sale #{sale.id.slice(-6)} — add missed items</h3>
          <button onClick={onCancel} className="text-text-secondary text-2xl leading-none px-2 sm:hidden" aria-label="Close">×</button>
        </div>

        {/* Add item FIRST so the search box + results sit at the top, above the
            on-screen keyboard, on a phone. */}
        <label className="text-text-secondary text-xs uppercase tracking-wider">Add a missed item</label>
        <input
          autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
          inputMode="search" placeholder="Search by SKU or name"
          className="bg-bg-input border border-border-strong px-4 py-3"
        />
        {hits.length > 0 && (
          <ul className="border border-border max-h-56 overflow-y-auto">
            {hits.map((h) => (
              <li key={h.id}>
                <button onClick={() => addHit(h)} className="w-full text-left px-3 py-3 border-b border-border last:border-0 hover:bg-bg-elevated active:bg-bg-elevated flex justify-between gap-2">
                  <span className="min-w-0 truncate">{h.name} <span className="text-text-tertiary text-xs">{h.sku}</span></span>
                  <span className="font-mono tnum shrink-0">{formatMoney(h.unitPricePesewas)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {additions.length > 0 && (
          <ul className="text-sm border border-accent">
            {additions.map((a, i) => (
              <li key={i} className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border last:border-0">
                <span className="flex-1 min-w-0 truncate">{a.name}{a.unitName !== 'UNIT' ? ` (${a.unitName})` : ''}</span>
                <input type="number" min={0} inputMode="numeric" value={a.quantity}
                  onChange={(e) => setQty(i, Math.floor(Number(e.target.value) || 0))}
                  className="w-16 bg-bg-input border border-border px-2 py-1 text-right font-mono tnum" />
                <span className="w-20 text-right font-mono tnum shrink-0">{formatMoney(a.quantity * a.unitPricePesewas)}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Original lines — context, capped so a long sale doesn't push the
            confirm button off-screen. */}
        <div className="text-text-tertiary text-xs">On the original sale ({formatMoneyWithCurrency(sale.totalPesewas)})</div>
        <ul className="text-sm border border-border max-h-32 overflow-y-auto">
          {origLines.map((l, i) => (
            <li key={i} className="flex justify-between gap-2 px-3 py-2 border-b border-border last:border-0">
              <span className="min-w-0 truncate">{l.quantity}× {l.productName}{l.unitName !== 'UNIT' ? ` (${l.unitName})` : ''}</span>
              <span className="font-mono tnum text-text-tertiary shrink-0">{formatMoney(l.quantity * l.unitPricePesewas)}</span>
            </li>
          ))}
        </ul>

        {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}

        {/* Totals + confirm pinned to the bottom of the sheet so they're always
            reachable without hunting. */}
        <div className="mt-auto sm:mt-0 sticky bottom-0 bg-bg-surface pt-3 flex flex-col gap-3">
          <div className="flex justify-between text-base border-t border-border pt-3">
            <span className="text-text-secondary">New total</span>
            <span className="font-mono tnum">{formatMoneyWithCurrency(newTotal)}</span>
          </div>
          <div className="flex justify-between text-sm text-accent">
            <span>Collect now</span>
            <span className="font-mono tnum">{formatMoneyWithCurrency(delta)}</span>
          </div>
          <div className="flex gap-3">
            <button onClick={onCancel} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
            <button onClick={() => void submit()} disabled={additions.length === 0 || busy}
              className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40 flex-1">
              {busy ? 'Correcting…' : `Confirm & collect ${formatMoneyWithCurrency(delta)}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
