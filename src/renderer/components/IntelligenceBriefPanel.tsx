import { useEffect, useState } from 'react';
import { counter } from '../lib/ipc';
import { formatMoneyWithCurrency } from '../../shared/lib/money';
import type { IntelligenceBrief, IntelligenceItem } from '../../shared/types/ipc';

export function IntelligenceBriefPanel({ onOpen }: { onOpen: () => void }) {
  const [brief, setBrief] = useState<IntelligenceBrief | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const result = await counter.intelligenceGetBrief();
      if (cancelled) return;
      if (result.success) { setBrief(result.data); setError(null); }
      else setError(result.error);
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, []);

  if (error) return (
    <section className="panel border-warning p-4">
      <div className="eyebrow text-warning">Today&apos;s brief unavailable</div>
      <p className="text-sm text-text-secondary mt-1">{error}</p>
    </section>
  );
  if (!brief || brief.stage === 'OFF') return null;

  return (
    <section className="panel overflow-hidden">
      <div className="px-4 py-3 border-b border-border-subtle flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="eyebrow">Today&apos;s brief</div>
          <div className="text-sm text-text-secondary mt-1">
            {brief.openCount === 0
              ? 'No current action needs attention.'
              : `${brief.openCount} open · ${brief.criticalCount} critical · ${brief.highCount} high`}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {brief.totalExposurePesewas > 0 && (
            <div className="text-right">
              <div className="text-xs text-text-tertiary">Measurable exposure</div>
              <div className="font-mono tnum text-warning">{formatMoneyWithCurrency(brief.totalExposurePesewas)}</div>
            </div>
          )}
          <button onClick={onOpen} className="btn btn-primary">Open intelligence</button>
        </div>
      </div>
      {brief.stale && (
        <div className="px-4 py-2 bg-warning/10 text-warning text-xs">
          Intelligence is stale. Open the queue and refresh; existing evidence is still available.
        </div>
      )}
      {brief.items.length > 0 && (
        <div className="divide-y divide-border-subtle">
          {brief.items.map((item) => <BriefRow key={item.id} item={item} onOpen={onOpen} />)}
        </div>
      )}
      <div className="px-4 py-2 text-[11px] text-text-tertiary flex justify-between gap-3">
        <span>Advice only — Counter never changes business records from this brief.</span>
        <span>{brief.lastRefreshAt ? `Refreshed ${new Date(brief.lastRefreshAt).toLocaleString()}` : 'Awaiting first refresh'}</span>
      </div>
    </section>
  );
}

function BriefRow({ item, onOpen }: { item: IntelligenceItem; onOpen: () => void }) {
  const severity = item.severity === 'CRITICAL' ? 'text-danger' : item.severity === 'HIGH' ? 'text-warning' : 'text-text-secondary';
  return (
    <button onClick={onOpen} className="w-full px-4 py-3 text-left grid sm:grid-cols-[auto_1fr_auto] gap-3 items-start">
      <span className={`status-badge ${item.severity === 'CRITICAL' ? 'status-danger' : item.severity === 'HIGH' ? 'status-pending' : 'status-neutral'}`}>
        {item.severity}
      </span>
      <span>
        <span className="block font-medium">{item.title}</span>
        <span className="block text-xs text-text-secondary mt-1">{item.recommendation}</span>
      </span>
      <span className={`font-mono tnum text-sm ${severity}`}>
        {item.cediImpactPesewas == null ? `${(item.confidenceBps / 100).toFixed(0)}% confidence` : formatMoneyWithCurrency(item.cediImpactPesewas)}
      </span>
    </button>
  );
}
