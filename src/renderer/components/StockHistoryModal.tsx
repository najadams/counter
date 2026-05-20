// StockHistoryModal — last N stock_movements for one product, signed,
// with running balance. The forensic surface for "where did the missing
// stock go".

import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoneyWithCurrency } from '../../shared/lib/money';

interface Row {
  movementId: string; createdAt: string; signedQuantity: number;
  reasonCode: string; reasonCategory: 'inflow' | 'outflow' | 'neutral';
  workerId: string; workerName: string; workerRole: string;
  supervisorApprovalId: string | null; supervisorName: string | null;
  unitCostPesewas: number; totalValuePesewas: number;
  notes: string | null;
  saleId: string | null; breakageLogId: string | null;
  runningBalance: number;
}

export function StockHistoryModal({
  productId, productName, onClose,
}: { productId: string; productName: string; onClose: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [onHand, setOnHand] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const r = await counter.stockHistoryForProduct(productId, 200);
      setLoading(false);
      if (!r.success) { setError(r.error); return; }
      setRows(r.data.rows);
      setOnHand(r.data.currentOnHand);
    })();
  }, [productId]);

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center p-6 z-50">
      <div className="bg-bg-elevated rounded-lg shadow-xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="px-6 py-4 border-b border-border-subtle flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Stock history</h2>
            <div className="text-sm text-text-tertiary">{productName} · current on-hand: <span className="text-accent font-mono">{onHand}</span></div>
          </div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">✕</button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading && <div className="text-center text-text-tertiary py-6">Loading…</div>}
          {error && <div className="text-sm text-danger bg-danger/10 border border-danger/40 rounded px-3 py-2 mb-2">{error}</div>}
          {!loading && rows.length === 0 && (
            <div className="text-text-tertiary py-6 text-center">No stock movements recorded yet.</div>
          )}
          {!loading && rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="bg-bg-deep text-text-tertiary uppercase text-xs sticky top-0">
                <tr>
                  <th className="text-left px-3 py-2">When</th>
                  <th className="text-right px-3 py-2">Qty</th>
                  <th className="text-right px-3 py-2">After</th>
                  <th className="text-left px-3 py-2">Reason</th>
                  <th className="text-left px-3 py-2">Worker</th>
                  <th className="text-left px-3 py-2">Supervisor</th>
                  <th className="text-right px-3 py-2">Value</th>
                  <th className="text-left px-3 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const sign = r.signedQuantity > 0 ? '+' : '';
                  const tone = r.signedQuantity > 0 ? 'text-success' : 'text-danger';
                  return (
                    <tr key={r.movementId} className="border-t border-border-subtle hover:bg-bg-deep/40">
                      <td className="px-3 py-2 font-mono text-xs text-text-secondary">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono tabular-nums ${tone}`}>
                        {sign}{r.signedQuantity}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-text-secondary">
                        {r.runningBalance}
                      </td>
                      <td className="px-3 py-2">
                        <div>{r.reasonCode}</div>
                        <div className="text-xs text-text-tertiary">{r.reasonCategory}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div>{r.workerName}</div>
                        <div className="text-xs text-text-tertiary">{r.workerRole}</div>
                      </td>
                      <td className="px-3 py-2 text-text-secondary">
                        {r.supervisorName ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-text-secondary">
                        {formatMoneyWithCurrency(Math.abs(r.totalValuePesewas))}
                      </td>
                      <td className="px-3 py-2 text-text-tertiary text-xs">{r.notes ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-6 py-3 border-t border-border-subtle flex justify-end">
          <button onClick={onClose} className="px-4 py-2 border border-border hover:bg-bg-deep text-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
