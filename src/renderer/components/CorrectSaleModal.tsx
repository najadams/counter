// CorrectSaleModal — additive sale correction (Approach A).
//
// Shows the original lines (read-only), lets the cashier search and ADD the
// missed items, shows the new total + the extra to collect, and calls
// correctSale (which voids the original + re-rings it + prints one CORRECTED
// receipt). Additive only: original lines can't be edited here.
//
// What the customer already paid stays as it was (the server carries the
// original tenders over); the cashier only says how the EXTRA is paid.

import { XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';

interface RecentSale {
  id: string; channel: string; totalPesewas: number; workerName: string;
  paymentMethod: string; customerName: string | null;
}

type ExtraMethod = 'CASH' | 'MOMO_MTN' | 'MOMO_VODAFONE' | 'MOMO_AIRTELTIGO' | 'BANK_TRANSFER' | 'CREDIT';
const EXTRA_METHODS: Array<{ value: ExtraMethod; label: string }> = [
  { value: 'CASH', label: 'Cash' },
  { value: 'MOMO_MTN', label: 'MTN MoMo' },
  { value: 'MOMO_VODAFONE', label: 'Telecel Cash' },
  { value: 'MOMO_AIRTELTIGO', label: 'AirtelTigo Money' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CREDIT', label: 'Pay later (on account)' },
];
const methodLabel = (m: string) => EXTRA_METHODS.find((x) => x.value === m)?.label ?? m;
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
  // The extra is paid the way the sale was, unless the cashier says otherwise.
  const [method, setMethod] = useState<ExtraMethod>(() => {
    const m = EXTRA_METHODS.find((x) => x.value === sale.paymentMethod)?.value ?? 'CASH';
    return m === 'CREDIT' && !sale.customerName ? 'CASH' : m;
  });
  const [cashGivenRaw, setCashGivenRaw] = useState('');
  const [reference, setReference] = useState('');

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
  // Blank means exact money; anything unreadable counts as short.
  const cashGiven = method === 'CASH' && cashGivenRaw.trim() !== '' ? parseCedisToPesewas(cashGivenRaw) ?? 0 : null;
  const cashShort = cashGiven != null && cashGiven < delta;
  const needsReference = method.startsWith('MOMO_') || method === 'BANK_TRANSFER';
  const collectLabel = method === 'CREDIT'
    ? `add ${formatMoneyWithCurrency(delta)} to ${sale.customerName ?? 'the account'}`
    : `collect ${formatMoneyWithCurrency(delta)} by ${methodLabel(method)}`;

  async function submit() {
    if (additions.length === 0 || cashShort) return;
    setBusy(true); setError(null);
    const r = await counter.correctSale({
      originalSaleId: sale.id,
      addedLines: additions.map((a) => ({
        productId: a.productId, quantity: a.quantity,
        unitPricePesewas: a.unitPricePesewas, unitId: a.unitId,
      })),
      extraPayment: {
        method,
        reference: needsReference ? reference.trim() || null : null,
        cashGivenPesewas: cashGiven,
      },
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    const d = r.data;
    const change = d.changePesewas ? ` Give ${formatMoneyWithCurrency(d.changePesewas)} change.` : '';
    const what = method === 'CREDIT'
      ? `Added ${formatMoneyWithCurrency(d.deltaPesewas)} to the account.`
      : `Collected ${formatMoneyWithCurrency(d.deltaPesewas)} extra by ${methodLabel(method)}.`;
    onDone(`Corrected #${sale.id.slice(-6)} → new #${d.newSaleId.slice(-6)}. ${what}${change}${d.printerFailed ? ' Receipt failed — send to counter.' : ''}`);
  }

  return (
    <Dialog onClose={onCancel} busy={busy}>
      {/* Full-screen + scrollable on a phone (so the keyboard never hides the
          search results or the confirm button); a centred card on desktop. */}
      <DialogContent
        showCloseButton={false}
        className="w-[min(32rem,calc(100%-2rem))] max-h-[90vh] gap-4 max-sm:inset-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0 max-sm:p-4"
      >
        <div className="flex items-center justify-between gap-2">
          <DialogTitle>Correct sale #{sale.id.slice(-6)} — add missed items</DialogTitle>
          <Button variant="ghost" size="icon-sm" className="sm:hidden" aria-label="Close" onClick={onCancel}><XIcon aria-hidden="true" /></Button>
        </div>

        {/* Add item FIRST so the search box + results sit at the top, above the
            on-screen keyboard, on a phone. */}
        <Field label="Add a missed item">
          <Input
            autoFocus value={query} onChange={(e) => setQuery(e.target.value)}
            inputMode="search" placeholder="Search by SKU or name"
            className="h-12 text-base"
          />
        </Field>
        {hits.length > 0 && (
          <ul className="rounded-lg border border-border max-h-56 overflow-y-auto">
            {hits.map((h) => (
              <li key={h.id}>
                <button onClick={() => addHit(h)} className="w-full text-left px-3 py-3 border-b border-border-subtle last:border-0 hover:bg-bg-surface active:bg-bg-surface flex justify-between gap-2">
                  <span className="min-w-0 truncate">{h.name} <span className="text-text-tertiary text-xs font-mono">{h.sku}</span></span>
                  <span className="font-mono tnum shrink-0">{formatMoney(h.unitPricePesewas)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {additions.length > 0 && (
          <ul className="text-sm rounded-lg border border-accent">
            {additions.map((a, i) => (
              <li key={i} className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border-subtle last:border-0">
                <span className="flex-1 min-w-0 truncate">{a.name}{a.unitName !== 'UNIT' ? ` (${a.unitName})` : ''}</span>
                <Input type="number" min={0} inputMode="numeric" value={a.quantity}
                  aria-label={`Quantity of ${a.name}`}
                  onChange={(e) => setQty(i, Math.floor(Number(e.target.value) || 0))}
                  className="h-8 w-16 px-2 text-right font-mono tnum" />
                <span className="w-20 text-right font-mono tnum shrink-0">{formatMoney(a.quantity * a.unitPricePesewas)}</span>
              </li>
            ))}
          </ul>
        )}

        {/* Original lines — context, capped so a long sale doesn't push the
            confirm button off-screen. */}
        <div className="text-text-tertiary text-xs">On the original sale ({formatMoneyWithCurrency(sale.totalPesewas)})</div>
        <ul className="text-sm rounded-lg border border-border max-h-32 overflow-y-auto">
          {origLines.map((l, i) => (
            <li key={i} className="flex justify-between gap-2 px-3 py-2 border-b border-border-subtle last:border-0">
              <span className="min-w-0 truncate">{l.quantity}× {l.productName}{l.unitName !== 'UNIT' ? ` (${l.unitName})` : ''}</span>
              <span className="font-mono tnum text-text-tertiary shrink-0">{formatMoney(l.quantity * l.unitPricePesewas)}</span>
            </li>
          ))}
        </ul>

        {error && <FeedbackBanner>{error}</FeedbackBanner>}

        {/* Totals + confirm pinned to the bottom of the sheet so they're always
            reachable without hunting. */}
        <div className="mt-auto sm:mt-0 sticky bottom-0 bg-bg-modal pt-3 flex flex-col gap-3">
          <div className="flex justify-between text-base border-t border-border pt-3">
            <span className="text-text-secondary">New total</span>
            <span className="font-mono tnum">{formatMoneyWithCurrency(newTotal)}</span>
          </div>
          <div className="text-xs text-text-tertiary">
            Already paid: {formatMoneyWithCurrency(sale.totalPesewas)} by {methodLabel(sale.paymentMethod)}{sale.customerName ? ` (${sale.customerName})` : ''}. That stays as it was.
          </div>
          <div className="flex justify-between text-sm font-semibold text-accent">
            <span>{method === 'CREDIT' ? 'Add to account' : 'Collect now'}</span>
            <span className="font-mono tnum">{formatMoneyWithCurrency(delta)}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Extra paid by">
              <NativeSelect value={method} onChange={(e) => setMethod(e.target.value as ExtraMethod)} disabled={busy}>
                {EXTRA_METHODS.filter((m) => m.value !== 'CREDIT' || sale.customerName).map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </NativeSelect>
            </Field>
            {method === 'CASH' && (
              <Field label="Cash received"
                hint={cashShort
                  ? <span className="text-danger">Less than {formatMoneyWithCurrency(delta)}</span>
                  : cashGiven != null && cashGiven > delta ? `Change ${formatMoneyWithCurrency(cashGiven - delta)}` : undefined}>
                <Input inputMode="decimal" value={cashGivenRaw} placeholder={formatMoney(delta)}
                  onChange={(e) => setCashGivenRaw(e.target.value)} className="font-mono tnum text-right" />
              </Field>
            )}
            {needsReference && (
              <Field label="Reference">
                <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transaction ID" />
              </Field>
            )}
          </div>
          <div className="flex gap-3">
            <Button size="lg" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button size="lg" variant="primary" onClick={() => void submit()} disabled={additions.length === 0 || busy || cashShort} className="flex-1">
              {busy ? 'Correcting…' : `Confirm & ${collectLabel}`}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
