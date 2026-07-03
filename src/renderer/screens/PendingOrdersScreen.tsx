// PendingOrdersScreen: WhatsApp orders the agent already confirmed with the
// customer, waiting on a shop decision.
//
// "Accept" has no separate persisted status — it loads the quoted lines into
// the cart and hands off to the Sale screen, where completeSale is Counter's
// one real commitment point (price floor, stock, receipt, audit all apply
// unchanged). "Reject" declines with a required reason and has no stock/
// money effect, so it needs no supervisor gate — see pendingOrders.ts.

import { useEffect, useState } from 'react';
import { useCart } from '../store/cart';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';
import type { PendingOrderDetail, PendingOrderSummary } from '../../shared/types/ipc';

export default function PendingOrdersScreen({ onExit, onAccept }: { onExit: () => void; onAccept: () => void }) {
  const loadLines = useCart((s) => s.loadLines);
  const setFulfillingOrderId = useCart((s) => s.setFulfillingOrderId);

  const [orders, setOrders] = useState<PendingOrderSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PendingOrderDetail | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const r = await counter.pendingOrdersList();
    if (r.success) setOrders(r.data.orders);
  }

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') {
        e.preventDefault();
        if (rejecting) setRejecting(false);
        else if (selectedId) setSelectedId(null);
        else onExit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit, selectedId, rejecting]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    setError(null);
    void (async () => {
      const r = await counter.pendingOrderGet(selectedId);
      if (r.success) setDetail(r.data);
      else { setError(r.error); setSelectedId(null); }
    })();
  }, [selectedId]);

  async function accept(orderId: string) {
    setBusy(true);
    setError(null);
    const r = await counter.pendingOrderResolveForCart(orderId);
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    const resolved = r.data;
    loadLines(
      resolved.lines.map((l) => ({
        productId: l.productId, sku: l.sku, name: l.name,
        unitId: l.unitId, unitName: l.unitName, factor: l.factor,
        basePricePesewas: l.unitPricePesewas, unitPricePesewas: l.unitPricePesewas,
        appliedTierId: null, appliedTierMinQuantity: null,
        quantity: l.quantity, unitsOnHand: l.unitsOnHand,
      })),
      resolved.channel as 'WALK_IN' | 'WHOLESALE' | 'ROUTE',
      null, // no local customer record linked from a WhatsApp order in v1
    );
    setFulfillingOrderId(orderId);
    onAccept();
  }

  async function reject(orderId: string) {
    if (!reason.trim()) { setError('A reason is required.'); return; }
    setBusy(true);
    setError(null);
    const r = await counter.pendingOrderReject(orderId, reason.trim());
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    setInfo(`Order #${orderId.slice(-8)} declined.`);
    setRejecting(false);
    setReason('');
    setSelectedId(null);
    await refresh();
    setTimeout(() => setInfo(null), 4000);
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="whatsapp orders" onBack={onExit} />
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-12 py-8 flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">
            Awaiting a decision {orders.length > 0 && `(${orders.length})`}
          </h2>
          <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
        </div>

        {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}
        {error && !selectedId && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}

        <div className="bg-bg-surface border border-border overflow-y-auto" style={{ maxHeight: '55vh' }}>
          <table className="w-full">
            <thead>
              <tr className="text-text-secondary text-xs uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Received</th>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Channel</th>
                <th className="px-4 py-3 text-right">Lines</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-border">
                  <td className="px-4 py-3 font-mono tnum">
                    {new Date(o.receivedAt).toLocaleTimeString()}
                    <span className="text-text-tertiary ml-2">#{o.id.slice(-6)}</span>
                  </td>
                  <td className="px-4 py-3">{o.customerName ?? o.customerPhone}</td>
                  <td className="px-4 py-3">{o.channel}</td>
                  <td className="px-4 py-3 text-right font-mono tnum">{o.lineCount}</td>
                  <td className="px-4 py-3 text-right font-mono tnum">{formatMoney(o.totalPesewas)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => { setSelectedId(o.id); setError(null); setInfo(null); }}
                      className="px-3 py-1 border border-accent text-accent hover:bg-accent hover:text-ink text-xs">
                      Review
                    </button>
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-text-tertiary text-center">No orders waiting.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {detail && !rejecting && (
          <div className="bg-bg-surface border border-border p-6 flex flex-col gap-4">
            <div className="flex items-baseline justify-between">
              <h3 className="text-text-secondary uppercase tracking-wider text-xs">
                Order #{detail.id.slice(-8)}
              </h3>
              <span className="text-text-tertiary text-xs">via WhatsApp agent</span>
            </div>
            <div className="text-sm text-text-secondary">
              {detail.customerName ?? 'Unnamed customer'} · {detail.customerPhone} · {detail.channel}
            </div>

            <div className="border border-border divide-y divide-border">
              {detail.lines.map((l, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span>{l.quantity} × {l.productName} {l.unitId && <span className="text-text-tertiary">({l.unitName})</span>}</span>
                  <span className="font-mono tnum">{formatMoney(l.lineTotalPesewas)}</span>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between text-base">
              <span className="text-text-secondary uppercase tracking-wider text-xs">Total</span>
              <span className="font-mono tnum font-semibold">{formatMoneyWithCurrency(detail.totalPesewas)}</span>
            </div>

            {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}

            <div className="flex gap-3">
              <button onClick={() => setSelectedId(null)} className="px-5 py-3 border border-border hover:bg-bg-elevated">
                Close
              </button>
              <button
                onClick={() => { setRejecting(true); setReason(''); setError(null); }}
                disabled={busy}
                className="px-5 py-3 border border-danger text-danger hover:bg-danger hover:text-ink disabled:opacity-40">
                Decline
              </button>
              <button
                onClick={() => void accept(detail.id)}
                disabled={busy}
                className="flex-1 bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
                {busy ? 'Loading…' : 'Accept & ring up'}
              </button>
            </div>
          </div>
        )}

        {detail && rejecting && (
          <div className="bg-bg-surface border border-border p-6 flex flex-col gap-4">
            <h3 className="text-text-secondary uppercase tracking-wider text-xs">
              Decline order #{detail.id.slice(-8)}
            </h3>
            <label className="text-text-secondary text-xs uppercase tracking-wider">Reason (required)</label>
            <input
              autoFocus value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. out of stock, closing early, can't deliver to that area"
              className="bg-bg-input border border-border-strong px-4 py-3"
            />
            <p className="text-text-tertiary text-xs">
              The customer will see this reason from the WhatsApp agent. No stock or payment is affected.
            </p>
            {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}
            <div className="flex gap-3">
              <button onClick={() => setRejecting(false)} className="px-5 py-3 border border-border hover:bg-bg-elevated">
                Back
              </button>
              <button
                onClick={() => void reject(detail.id)}
                disabled={busy || reason.trim().length < 3}
                className="bg-danger text-ink px-5 py-3 font-semibold hover:opacity-90 disabled:opacity-40">
                {busy ? 'Declining…' : 'Confirm decline'}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
