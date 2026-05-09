// CustomerReturnModal — record a return from a customer.
//
// Distinct from a void: customer brings stock back days later. We re-shelve
// the goods (positive RETURN_FROM_CUSTOMER stock movement) and refund them
// either as CASH (negative impact on till) or CREDIT (FIFO allocation
// against open credit balances; overage becomes store credit).
//
// Wave C.3.

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { SupervisorPinModal } from './SupervisorPinModal';
import { formatMoney, parseCedisToPesewas } from '../../shared/lib/money';

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
    if (lines.length === 0) { setError('Add at least one line.'); return; }
    if (!reason.trim()) { setError('Reason is required.'); return; }
    if (lines.some((l) => l.quantity <= 0)) { setError('All quantities must be positive.'); return; }
    setShowSup(true);
  }

  async function submit(supervisorWorkerId: string, supervisorPin: string) {
    setShowSup(false);
    const r = await counter.recordReturn({
      customerId,
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
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-6 z-50">
      <div className="bg-bg-surface rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-auto border border-border">
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold">Record return</h2>
            <div className="text-xs text-text-tertiary mt-1">From {customerName}</div>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">×</button>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="border border-danger bg-danger/10 text-danger px-3 py-2 rounded text-sm">{error}</div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-text-secondary">Refund method</label>
              <select
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value as 'CASH' | 'CREDIT')}
                className="w-full bg-bg-deep border border-border px-3 py-2 text-sm">
                <option value="CREDIT">Reduce balance (CREDIT)</option>
                <option value="CASH">Cash from till (CASH)</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-text-secondary">Reason</label>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Wrong order, damaged, unsold stock"
                className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
              />
            </div>
          </div>

          <LinePicker onAdd={addLine} />

          <div className="border border-border rounded">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-secondary text-xs uppercase tracking-wider border-b border-border">
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-left">Unit</th>
                  <th className="px-3 py-2 text-right">Qty</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b border-border">
                    <td className="px-3 py-2">{l.productName}</td>
                    <td className="px-3 py-2">{l.unitName}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number"
                        value={l.quantity}
                        onChange={(e) => changeQty(i, parseInt(e.target.value, 10) || 0)}
                        className="w-20 bg-bg-deep border border-border px-2 py-1 text-sm font-mono text-right"
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{formatMoney(l.unitPricePesewas)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">
                      {formatMoney(l.unitPricePesewas * l.quantity)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => removeLine(i)}
                        className="text-xs underline text-danger hover:text-danger-light">
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {lines.length === 0 && (
                  <tr><td colSpan={6} className="px-3 py-4 text-text-tertiary text-center">
                    Search a product above and click Add.
                  </td></tr>
                )}
              </tbody>
              {lines.length > 0 && (
                <tfoot>
                  <tr className="font-semibold bg-bg-deep">
                    <td colSpan={4} className="px-3 py-2 text-right">Refund total</td>
                    <td className="px-3 py-2 text-right font-mono">{formatMoney(total)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <div>
            <label className="text-xs text-text-secondary">Notes (optional)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="any extra context"
              className="w-full bg-bg-deep border border-border px-3 py-2 text-sm"
            />
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onClose}
              className="px-4 py-2 border border-border text-sm hover:bg-bg-elevated">Cancel</button>
            <button onClick={tryRecord} disabled={lines.length === 0 || !reason.trim()}
              className="px-4 py-2 bg-accent text-bg-deep font-semibold text-sm disabled:opacity-50">
              Record return ({formatMoney(total)})
            </button>
          </div>
        </div>
      </div>

      {showSup && (
        <SupervisorPinModal
          title="Approve customer return"
          onCancel={() => setShowSup(false)}
          onApprove={(id, pin) => void submit(id, pin)}
        />
      )}
    </div>
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
    <div className="border border-border rounded p-3 bg-bg-deep space-y-2">
      <div className="text-xs text-text-secondary">Add line</div>
      <div className="relative">
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
        <div className="grid grid-cols-4 gap-2 items-end">
          <select
            value={unitId}
            onChange={(e) => {
              setUnitId(e.target.value);
              const u = units.find((x) => x.id === e.target.value);
              if (u) setPriceCedis((u.pricePesewas / 100).toFixed(2));
            }}
            className="bg-bg-surface border border-border px-2 py-2 text-sm">
            {units.map((u) => (
              <option key={u.id} value={u.id}>{u.unitName}</option>
            ))}
          </select>
          <input type="number" value={qty}
            onChange={(e) => setQty(parseInt(e.target.value, 10) || 0)}
            placeholder="qty"
            className="bg-bg-surface border border-border px-2 py-2 text-sm font-mono text-right" />
          <input value={priceCedis}
            onChange={(e) => setPriceCedis(e.target.value)}
            placeholder="₵ / unit"
            className="bg-bg-surface border border-border px-2 py-2 text-sm font-mono text-right" />
          <button onClick={add} disabled={!unitId || qty <= 0 || !priceCedis}
            className="bg-accent text-bg-deep px-3 py-2 font-semibold text-sm disabled:opacity-50">
            Add
          </button>
        </div>
      )}
    </div>
  );
}

export default CustomerReturnModal;
