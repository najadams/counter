// CustomerReturnModal — record a return from a customer.
//
// Distinct from a void: customer brings stock back days later. We re-shelve
// the goods (positive RETURN_FROM_CUSTOMER stock movement) and refund them
// either as CASH (negative impact on till) or CREDIT (FIFO allocation
// against open credit balances; overage becomes store credit).
//
// Wave C.3.

import { XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { SupervisorPinModal } from './SupervisorPinModal';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';
import type { SaleListRecentResponse } from '../../shared/types/ipc';
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';
import { NativeSelect } from './ui/native-select';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from './ui/table';

interface Props {
  customerId: string;
  customerName: string;
  onClose: () => void;
  onRecorded: (summary: { returnId: string; totalRefundPesewas: number }) => void;
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

interface Line {
  productId: string;
  productName: string;
  unitId: string;
  unitName: string;
  quantity: number;
  unitPricePesewas: number;
}

export function CustomerReturnModal({ customerId, customerName, onClose, onRecorded }: Props): JSX.Element {
  const [originalSaleId, setOriginalSaleId] = useState('');
  const [receiptLess, setReceiptLess] = useState(false);
  const [recentSales, setRecentSales] = useState<SaleListRecentResponse['sales']>([]);
  useEffect(() => {
    let cancelled = false;
    counter.listRecentSales(100).then(r => { if (!cancelled && r.success) setRecentSales(r.data.sales.filter(s => !s.voided)); });
    return () => { cancelled = true; };
  }, []);
  const [refundMethod, setRefundMethod] = useState<'CASH' | 'CREDIT'>('CREDIT');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [showSup, setShowSup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = lines.reduce((s, l) => s + l.unitPricePesewas * l.quantity, 0);

  function addLine(line: Line) {
    setLines((prev) => [...prev, line]);
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
  }

  function changeQty(idx: number, q: number) {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, quantity: q } : l)));
  }

  function tryRecord() {
    setError(null);
    if (!originalSaleId && !receiptLess) { setError('Choose the original sale, or confirm a return without a receipt.'); return; }
    if (lines.length === 0) { setError('Add at least one line.'); return; }
    if (!reason.trim()) { setError('Reason is required.'); return; }
    if (lines.some((l) => l.quantity <= 0)) { setError('All quantities must be positive.'); return; }
    setShowSup(true);
  }

  async function submit(supervisorWorkerId: string, supervisorPin: string) {
    setShowSup(false);
    const r = await counter.recordReturn({
      customerId,
      originalSaleId: originalSaleId || null,
      refundMethod,
      reason: reason.trim(),
      notes: notes.trim() || null,
      lines: lines.map((l) => ({
        productId: l.productId,
        unitId: l.unitId,
        quantity: l.quantity,
        unitPricePesewas: l.unitPricePesewas,
      })),
      supervisorWorkerId,
      supervisorPin,
    });
    if (!r.success) { setError(r.error); return; }
    onRecorded({ returnId: r.data.returnId, totalRefundPesewas: r.data.totalRefundPesewas });
  }

  return (
    <Dialog onClose={onClose}>
      <DialogContent showCloseButton={false} className="w-[min(48rem,calc(100%-2rem))] max-h-[90vh] gap-0 p-0">
        <header className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border">
          <div>
            <DialogTitle>Record return</DialogTitle>
            <DialogDescription className="text-xs mt-1">From {customerName}</DialogDescription>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}><XIcon aria-hidden="true" /></Button>
        </header>

        <div className="p-6 space-y-4 overflow-y-auto">
          {error && (
            <FeedbackBanner>{error}</FeedbackBanner>
          )}

          {/* A return names the sale it comes from, so quantities and refunds
              can be checked against it; a receipt-less return is an explicit,
              audited exception (returnLimits.ts). */}
          <Field label="Original sale">
            <NativeSelect value={originalSaleId} disabled={receiptLess} onChange={(e) => setOriginalSaleId(e.target.value)}>
              <option value="">Choose the sale</option>
              {recentSales.map((s) => (
                <option key={s.id} value={s.id}>
                  {new Date(s.createdAt).toLocaleString()} · {s.customerName ?? 'Walk-in'} · GHS {formatMoney(s.totalPesewas)} · {s.id.slice(-8)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <label className="flex items-start gap-3 text-sm">
            <Checkbox className="mt-0.5" checked={receiptLess}
              onCheckedChange={(checked) => { setReceiptLess(checked === true); setOriginalSaleId(''); }} />
            <span>Return without a receipt — the supervisor must check the goods before refunding.</span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Refund method">
              <NativeSelect
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value as 'CASH' | 'CREDIT')}>
                <option value="CREDIT">Reduce balance (CREDIT)</option>
                <option value="CASH">Cash from till (CASH)</option>
              </NativeSelect>
            </Field>
            <Field label="Reason">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Wrong order, damaged, unsold stock"
              />
            </Field>
          </div>

          <LinePicker onAdd={addLine} />

          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-3">Product</TableHead>
                  <TableHead className="px-3">Unit</TableHead>
                  <TableHead className="px-3 text-right">Qty</TableHead>
                  <TableHead className="px-3 text-right">Price</TableHead>
                  <TableHead className="px-3 text-right">Total</TableHead>
                  <TableHead className="px-3"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((l, i) => (
                  <TableRow key={i}>
                    <TableCell className="px-3 py-2">{l.productName}</TableCell>
                    <TableCell className="px-3 py-2">{l.unitName}</TableCell>
                    <TableCell className="px-3 py-2 text-right">
                      <Input
                        type="number"
                        aria-label={`Quantity of ${l.productName}`}
                        value={l.quantity}
                        onChange={(e) => changeQty(i, parseInt(e.target.value, 10) || 0)}
                        className="h-8 w-20 px-2 font-mono tnum text-right"
                      />
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right font-mono tnum">{formatMoney(l.unitPricePesewas)}</TableCell>
                    <TableCell className="px-3 py-2 text-right font-mono tnum font-semibold">
                      {formatMoney(l.unitPricePesewas * l.quantity)}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right">
                      <Button variant="ghost" size="sm" className="text-danger" onClick={() => removeLine(i)}>Remove</Button>
                    </TableCell>
                  </TableRow>
                ))}
                {lines.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="px-3 py-4 text-text-tertiary text-center">
                    Search a product above and click Add.
                  </TableCell></TableRow>
                )}
              </TableBody>
              {lines.length > 0 && (
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={4} className="px-3 py-2 text-right">Refund total</TableCell>
                    <TableCell className="px-3 py-2 text-right font-mono tnum">{formatMoney(total)}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              )}
            </Table>
          </div>

          <Field label="Notes (optional)">
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="any extra context"
            />
          </Field>

          <div className="flex justify-end gap-3 pt-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={tryRecord} disabled={lines.length === 0 || !reason.trim()}>
              Record return ({formatMoney(total)})
            </Button>
          </div>
        </div>

        {showSup && (
          <SupervisorPinModal
            title="Approve customer return"
            onCancel={() => setShowSup(false)}
            onApprove={(id, pin) => void submit(id, pin)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function LinePicker({ onAdd }: { onAdd: (line: Line) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [picked, setPicked] = useState<ProductHit | null>(null);
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [unitId, setUnitId] = useState('');
  const [qty, setQty] = useState(1);
  const [priceCedis, setPriceCedis] = useState('');

  useEffect(() => {
    const t = setTimeout(async () => {
      if (query.trim().length < 2) { setHits([]); return; }
      const r = await counter.searchProducts(query.trim(), 'WHOLESALE');
      if (r.success) setHits(r.data.products.map((p) => ({
        id: p.id, name: p.name, sku: p.sku, unitPricePesewas: p.unitPricePesewas,
      })));
    }, 200);
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
      if (dflt) {
        setUnitId(dflt.id);
        setPriceCedis((dflt.pricePesewas / 100).toFixed(2));
      }
    }
  }

  function add() {
    if (!picked) return;
    const u = units.find((x) => x.id === unitId);
    if (!u) return;
    const pesewas = parseCedisToPesewas(priceCedis);
    if (pesewas === null || pesewas < 0) return;
    onAdd({
      productId: picked.id,
      productName: picked.name,
      unitId: u.id,
      unitName: u.unitName,
      quantity: qty,
      unitPricePesewas: pesewas,
    });
    // Reset for next line
    setPicked(null); setQuery(''); setHits([]); setUnits([]);
    setUnitId(''); setQty(1); setPriceCedis('');
  }

  return (
    <div className="rounded-lg border border-border p-3 bg-bg-surface space-y-2">
      <div className="text-xs font-semibold text-text-secondary">Add line</div>
      <div className="relative">
        <Input
          aria-label="Search products"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPicked(null); }}
          placeholder="search by name or SKU"
        />
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
        <div className="grid grid-cols-4 gap-2 items-end">
          <NativeSelect
            aria-label="Unit"
            value={unitId}
            onChange={(e) => {
              setUnitId(e.target.value);
              const u = units.find((x) => x.id === e.target.value);
              if (u) setPriceCedis((u.pricePesewas / 100).toFixed(2));
            }}>
            {units.map((u) => (
              <option key={u.id} value={u.id}>{u.unitName}</option>
            ))}
          </NativeSelect>
          <Input type="number" value={qty} aria-label="Quantity"
            onChange={(e) => setQty(parseInt(e.target.value, 10) || 0)}
            placeholder="qty"
            className="font-mono tnum text-right" />
          <Input value={priceCedis} aria-label="Price per unit (cedis)"
            onChange={(e) => setPriceCedis(e.target.value)}
            placeholder="₵ / unit"
            className="font-mono tnum text-right" />
          <Button variant="primary" onClick={add} disabled={!unitId || qty <= 0 || !priceCedis}>
            Add
          </Button>
        </div>
      )}
    </div>
  );
}

export default CustomerReturnModal;
