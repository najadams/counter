// StockHistoryModal — last N stock_movements for one product, signed,
// with running balance. The forensic surface for "where did the missing
// stock go".

import { XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoneyWithCurrency } from '../../shared/lib/money';
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

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
    <Dialog onClose={onClose}>
      <DialogContent showCloseButton={false} className="w-[min(64rem,calc(100%-2rem))] max-h-[90vh] gap-0 p-0">
        <header className="px-6 py-4 border-b border-border-subtle flex items-center justify-between gap-4">
          <div>
            <DialogTitle>Stock history</DialogTitle>
            <DialogDescription>{productName} · current on-hand: <span className="text-accent font-mono tnum">{onHand}</span></DialogDescription>
          </div>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}><XIcon aria-hidden="true" /></Button>
        </header>

        <div className="flex-1 overflow-auto p-4">
          {loading && <div className="text-center text-text-tertiary py-6">Loading…</div>}
          {error && <FeedbackBanner className="mb-2">{error}</FeedbackBanner>}
          {!loading && rows.length === 0 && (
            <div className="text-text-tertiary py-6 text-center">No stock movements recorded yet.</div>
          )}
          {!loading && rows.length > 0 && (
            <Table scroll={false}>
              <TableHeader className="sticky top-0 bg-bg-surface">
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">After</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Worker</TableHead>
                  <TableHead>Supervisor</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const sign = r.signedQuantity > 0 ? '+' : '';
                  const tone = r.signedQuantity > 0 ? 'text-success' : 'text-danger';
                  return (
                    <TableRow key={r.movementId}>
                      <TableCell className="px-3 py-2 font-mono text-xs text-text-secondary">
                        {new Date(r.createdAt).toLocaleString()}
                      </TableCell>
                      <TableCell className={`px-3 py-2 text-right font-mono tnum ${tone}`}>
                        {sign}{r.signedQuantity}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-right font-mono tnum text-text-secondary">
                        {r.runningBalance}
                      </TableCell>
                      <TableCell className="px-3 py-2">
                        <div>{r.reasonCode}</div>
                        <div className="text-xs text-text-tertiary">{r.reasonCategory}</div>
                      </TableCell>
                      <TableCell className="px-3 py-2">
                        <div>{r.workerName}</div>
                        <div className="text-xs text-text-tertiary">{r.workerRole}</div>
                      </TableCell>
                      <TableCell className="px-3 py-2 text-text-secondary">
                        {r.supervisorName ?? '—'}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-right font-mono tnum text-text-secondary">
                        {formatMoneyWithCurrency(Math.abs(r.totalValuePesewas))}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-text-tertiary text-xs">{r.notes ?? '—'}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>

        <footer className="px-6 py-3 border-t border-border-subtle flex justify-end">
          <Button onClick={onClose} shortcut="Esc">Close</Button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
