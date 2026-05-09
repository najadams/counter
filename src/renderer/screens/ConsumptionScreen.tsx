// ConsumptionScreen: log a worker drink against monthly allowance.
// Allowance pill goes warning yellow when <=2 left, danger red when 0 (paid).

import { useEffect, useRef, useState } from 'react';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { SupervisorPinModal } from '../components/SupervisorPinModal';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';

interface ProductHit {
  id: string; sku: string; name: string;
  unitPricePesewas: number; costPricePesewas: number; unitsOnHand: number;
}
interface Usage { unitsAllowed: number; unitsUsed: number; unitsRemaining: number }

export default function ConsumptionScreen({ onExit }: { onExit: () => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [selected, setSelected] = useState<ProductHit | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [needsSupervisor, setNeedsSupervisor] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  async function refresh() {
    const r = await counter.getMonthlyUsage();
    if (r.success) setUsage({
      unitsAllowed: r.data.unitsAllowed,
      unitsUsed: r.data.unitsUsed,
      unitsRemaining: r.data.unitsRemaining,
    });
  }
  useEffect(() => { void refresh(); searchRef.current?.focus(); }, []);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await counter.searchProducts(query, 'WALK_IN', 12);
      if (cancelled) return;
      if (r.success) setHits(r.data.products);
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') { e.preventDefault(); if (needsSupervisor) setNeedsSupervisor(false); else onExit(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [needsSupervisor, onExit]);

  const willCrossThreshold = usage && quantity > usage.unitsRemaining;

  async function submit(supervisorWorkerId?: string) {
    if (!selected) { setError('Pick a product.'); return; }
    if (willCrossThreshold && !supervisorWorkerId) { setNeedsSupervisor(true); return; }
    setSubmitting(true);
    setError(null);
    const r = await counter.recordConsumption({
      productId: selected.id, quantity,
      supervisorApprovalId: supervisorWorkerId ?? null,
    });
    setSubmitting(false);
    setNeedsSupervisor(false);
    if (!r.success) { setError(r.error); return; }
    const { unitsFree, unitsPaid, costToWorkerPesewas } = r.data;
    let msg = '';
    if (unitsPaid > 0) msg = `Logged: ${unitsFree} free + ${unitsPaid} paid (${formatMoneyWithCurrency(costToWorkerPesewas)} due from wages).`;
    else msg = `Logged: ${unitsFree} unit(s) within allowance.`;
    setInfo(msg);
    setSelected(null); setQuery(''); setQuantity(1);
    await refresh();
  }

  function pillClass(): string {
    if (!usage) return 'border-border text-text-secondary';
    if (usage.unitsRemaining === 0) return 'border-danger text-danger';
    if (usage.unitsRemaining <= 2) return 'border-warning text-warning';
    return 'border-success text-success';
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="log drink" />
      <main className="flex-1 max-w-3xl w-full mx-auto px-12 py-8 flex flex-col gap-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">Worker consumption</h2>
          <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
        </div>

        {usage && (
          <div className={`border px-5 py-3 flex items-center justify-between ${pillClass()}`}>
            <span className="uppercase tracking-wider text-xs">This month</span>
            <span className="font-mono tnum">
              {usage.unitsUsed} used · {usage.unitsRemaining} of {usage.unitsAllowed} free remaining
            </span>
          </div>
        )}

        {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}

        <input
          ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search product…"
          className="bg-bg-input border border-border-strong px-4 py-3"
        />
        <ul className="bg-bg-surface border border-border max-h-48 overflow-y-auto">
          {hits.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setSelected(p)}
                className={`w-full text-left px-4 py-2 flex justify-between border-b border-border ${selected?.id === p.id ? 'bg-bg-elevated' : 'hover:bg-bg-elevated'}`}>
                <span>{p.name} <span className="text-text-tertiary text-xs">{p.sku}</span></span>
                <span className="text-text-tertiary text-sm">price {formatMoney(p.unitPricePesewas)} · {p.unitsOnHand} on hand</span>
              </button>
            </li>
          ))}
          {hits.length === 0 && <li className="px-4 py-2 text-text-tertiary text-sm">No products match.</li>}
        </ul>

        {selected && (
          <div className="bg-bg-surface border border-border p-5 flex flex-col gap-4">
            <div className="text-text-primary">{selected.name}</div>
            <div className="flex items-center gap-3">
              <span className="text-text-secondary text-xs uppercase tracking-wider">Quantity</span>
              <button onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="px-3 py-2 border border-border">−</button>
              <span className="font-mono tnum text-2xl w-12 text-center">{quantity}</span>
              <button onClick={() => setQuantity((q) => q + 1)} className="px-3 py-2 border border-border">+</button>
            </div>
            {willCrossThreshold && (
              <div className="bg-bg-deep border border-warning px-4 py-2 text-warning text-sm">
                {usage && quantity > usage.unitsRemaining
                  ? `${quantity - usage.unitsRemaining} unit(s) over allowance — supervisor approval will be required, ${formatMoneyWithCurrency((quantity - usage.unitsRemaining) * selected.unitPricePesewas)} deducted from wages.`
                  : null}
              </div>
            )}
            {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}
            <div className="flex gap-3">
              <button onClick={() => setSelected(null)} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
              <button
                onClick={() => void submit()}
                disabled={submitting}
                className="bg-accent text-bg-deep px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
                {submitting ? 'Logging…' : willCrossThreshold ? 'Get supervisor approval' : 'Log consumption'}
              </button>
            </div>
          </div>
        )}

        {needsSupervisor && (
          <SupervisorPinModal
            title="Approve over-allowance consumption"
            onCancel={() => setNeedsSupervisor(false)}
            onApprove={(supId) => void submit(supId)}
          />
        )}
      </main>
    </div>
  );
}
