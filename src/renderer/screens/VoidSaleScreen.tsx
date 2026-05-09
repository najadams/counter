// VoidSaleScreen: list recent sales, click Void → SupervisorPinModal → confirm.

import { useEffect, useState } from 'react';
import { useCart } from '../store/cart';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { SupervisorPinModal } from '../components/SupervisorPinModal';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';

interface RecentSale {
  id: string; createdAt: string; channel: string; totalPesewas: number;
  paymentMethod: string; workerName: string; customerName: string | null;
  voided: boolean; lineCount: number;
}

export default function VoidSaleScreen({ onExit, onDuplicate }: { onExit: () => void; onDuplicate?: () => void }) {
  const loadLines = useCart((s) => s.loadLines);
  const [sales, setSales] = useState<RecentSale[]>([]);
  const [selected, setSelected] = useState<RecentSale | null>(null);
  const [reason, setReason] = useState('');
  const [askingSupervisor, setAskingSupervisor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function refresh() {
    const r = await counter.listRecentSales(50);
    if (r.success) setSales(r.data.sales);
  }
  useEffect(() => {
    void refresh();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') { e.preventDefault(); if (askingSupervisor) setAskingSupervisor(false); else onExit(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [askingSupervisor, onExit]);

  async function reprint(saleId: string) {
    const r = await counter.reprintSaleReceipt(saleId);
    if (!r.success) { setError(r.error); setInfo(null); return; }
    if (r.data.printed) { setInfo(`Receipt for #${saleId.slice(-6)} reprinted.`); setError(null); }
    else { setError(`Reprint failed: ${r.data.error ?? 'printer offline'}`); setInfo(null); }
  }

  async function duplicate(saleId: string) {
    setError(null);
    const r = await counter.getSaleLines(saleId);
    if (!r.success) { setError(r.error); return; }
    const data = r.data;
    loadLines(
      data.lines.map((l) => ({
        productId: l.productId, sku: l.productSku, name: l.productName,
        basePricePesewas: l.unitPricePesewas, unitPricePesewas: l.unitPricePesewas,
        appliedTierId: null, appliedTierMinQuantity: null,
        quantity: l.quantity, unitsOnHand: l.unitsOnHand,
      })),
      data.channel,
      data.customerId && data.customerName
        ? { id: data.customerId, displayName: data.customerName, phone: '', currentBalancePesewas: 0 }
        : null,
    );
    onDuplicate?.();
  }

  async function approve(supervisorWorkerId: string, supervisorPin: string) {
    if (!selected) return;
    setError(null);
    const res = await counter.voidSale(selected.id, reason.trim(), supervisorWorkerId, supervisorPin);
    setAskingSupervisor(false);
    if (!res.success) { setError(res.error); return; }
    setInfo(`Voided ${selected.id.slice(-8)}. Reversed ${res.data.reversalMovementCount} stock movement(s).`);
    setSelected(null);
    setReason('');
    await refresh();
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="void sale" />
      <main className="flex-1 max-w-5xl w-full mx-auto px-12 py-8 flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">Recent sales</h2>
          <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
        </div>
        {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}
        <div className="bg-bg-surface border border-border overflow-y-auto" style={{ maxHeight: '60vh' }}>
          <table className="w-full">
            <thead>
              <tr className="text-text-secondary text-xs uppercase tracking-wider">
                <th className="px-4 py-3 text-left">When</th>
                <th className="px-4 py-3 text-left">Worker</th>
                <th className="px-4 py-3 text-left">Channel · Payment</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {sales.map((s) => (
                <tr key={s.id} className={`border-t border-border ${s.voided ? 'text-text-tertiary line-through' : ''}`}>
                  <td className="px-4 py-3 font-mono tnum">
                    {new Date(s.createdAt).toLocaleTimeString()}
                    <span className="text-text-tertiary ml-2">#{s.id.slice(-6)}</span>
                  </td>
                  <td className="px-4 py-3">{s.workerName}</td>
                  <td className="px-4 py-3">{s.channel} · {s.paymentMethod}{s.customerName ? ` · ${s.customerName}` : ''}</td>
                  <td className="px-4 py-3 text-right font-mono tnum">{formatMoney(s.totalPesewas)}</td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex gap-2 justify-end">
                      <button
                        onClick={() => void reprint(s.id)}
                        className="px-3 py-1 border border-border text-text-tertiary hover:text-accent hover:border-accent text-xs">
                        Print receipt
                      </button>
                      <button
                        onClick={() => void duplicate(s.id)}
                        className="px-3 py-1 border border-border text-text-tertiary hover:text-accent hover:border-accent text-xs">
                        Duplicate
                      </button>
                      {s.voided
                        ? <span className="text-danger text-xs self-center">VOIDED</span>
                        : <button
                            onClick={() => { setSelected(s); setReason(''); setError(null); setInfo(null); }}
                            className="px-3 py-1 border border-danger text-danger hover:bg-danger hover:text-bg-deep text-xs">
                            Void
                          </button>}
                    </div>
                  </td>
                </tr>
              ))}
              {sales.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-6 text-text-tertiary text-center">No sales yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {selected && !askingSupervisor && (
          <div className="bg-bg-surface border border-border p-6 flex flex-col gap-4">
            <h3 className="text-text-secondary uppercase tracking-wider text-xs">Void sale {selected.id.slice(-8)}</h3>
            <div className="text-text-tertiary text-sm">
              {selected.workerName} · {selected.channel} · {selected.paymentMethod} ·
              <span className="ml-2 font-mono tnum text-text-primary">{formatMoneyWithCurrency(selected.totalPesewas)}</span>
            </div>
            <label className="text-text-secondary text-xs uppercase tracking-wider">Reason (required)</label>
            <input
              autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. customer changed mind, wrong product, accidental double-scan"
              className="bg-bg-input border border-border-strong px-4 py-3"
            />
            {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}
            <div className="flex gap-3">
              <button onClick={() => setSelected(null)} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
              <button
                onClick={() => setAskingSupervisor(true)}
                disabled={reason.trim().length < 3}
                className="bg-danger text-bg-deep px-5 py-3 font-semibold hover:opacity-90 disabled:opacity-40">
                Get supervisor approval
              </button>
            </div>
          </div>
        )}

        {askingSupervisor && (
          <SupervisorPinModal
            title="Approve void"
            onCancel={() => setAskingSupervisor(false)}
            onApprove={approve}
          />
        )}
      </main>
    </div>
  );
}
