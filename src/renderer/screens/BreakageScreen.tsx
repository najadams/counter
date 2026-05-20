// BreakageScreen: log a broken/leaked/expired item with photo evidence.

import { useEffect, useRef, useState } from 'react';
import { counter } from '../lib/ipc';
import { AppHeader } from '../components/AppHeader';
import { formatMoney, formatMoneyWithCurrency } from '../../shared/lib/money';

interface ProductHit { id: string; sku: string; name: string; unitPricePesewas: number; costPricePesewas: number; unitsOnHand: number }

const CAUSES = [
  { code: 'DROPPED', label: 'Dropped' },
  { code: 'CUSTOMER_ACCIDENT', label: 'Customer accident' },
  { code: 'TRANSPORT', label: 'Transport damage' },
  { code: 'EXPIRED_LEAK', label: 'Expired / leaked' },
  { code: 'UNKNOWN', label: 'Unknown' },
  { code: 'OTHER', label: 'Other' },
] as const;

type Cause = typeof CAUSES[number]['code'];

export default function BreakageScreen({ onExit }: { onExit: () => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [selected, setSelected] = useState<ProductHit | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [cause, setCause] = useState<Cause>('DROPPED');
  const [description, setDescription] = useState('');
  const [photoB64, setPhotoB64] = useState<string | null>(null);
  const [photoExt, setPhotoExt] = useState<string>('jpg');
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

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
      if (e.key === 'F9' || e.key === 'Escape') { e.preventDefault(); onExit(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  async function pickFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      setError('Photo must be jpg, png, or webp.'); return;
    }
    if (file.size > 5 * 1024 * 1024) { setError('Photo must be under 5MB.'); return; }
    const buf = await file.arrayBuffer();
    let bin = '';
    const arr = new Uint8Array(buf);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
    setPhotoB64(btoa(bin));
    setPhotoExt(ext === 'jpeg' ? 'jpg' : ext);
    setPhotoPreview(URL.createObjectURL(file));
    setError(null);
  }

  async function submit() {
    if (!selected) { setError('Pick a product.'); return; }
    if (!photoB64) { setError('Photo is required (invariant 8 — no breakage without evidence).'); return; }
    if (quantity < 1) { setError('Quantity must be at least 1.'); return; }
    setSubmitting(true);
    const r = await counter.reportBreakage({
      productId: selected.id, quantity, cause,
      causeDescription: description.trim() || null,
      photoBase64: photoB64, photoExtension: photoExt,
    });
    setSubmitting(false);
    if (!r.success) { setError(r.error); return; }
    setInfo(`Logged. Loss recorded at ${formatMoneyWithCurrency(r.data.totalLossPesewas)}.`);
    setSelected(null); setQuery(''); setQuantity(1); setCause('DROPPED');
    setDescription(''); setPhotoB64(null); setPhotoPreview(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="report breakage" />
      <main className="flex-1 max-w-3xl w-full mx-auto px-12 py-8 flex flex-col gap-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">Break / leak / expire</h2>
          <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
        </div>
        {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}

        <input
          ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search product (SKU or name)…"
          className="bg-bg-input border border-border-strong px-4 py-3"
        />
        <ul className="bg-bg-surface border border-border max-h-48 overflow-y-auto">
          {hits.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setSelected(p)}
                className={`w-full text-left px-4 py-2 flex justify-between border-b border-border ${selected?.id === p.id ? 'bg-bg-elevated' : 'hover:bg-bg-elevated'}`}>
                <span>{p.name} <span className="text-text-tertiary text-xs">{p.sku}</span></span>
                <span className="text-text-tertiary text-sm">{p.unitsOnHand} on hand · cost {formatMoney(p.costPricePesewas)}</span>
              </button>
            </li>
          ))}
          {hits.length === 0 && <li className="px-4 py-2 text-text-tertiary text-sm">No products match.</li>}
        </ul>

        {selected && (
          <div className="bg-bg-surface border border-border p-5 flex flex-col gap-4">
            <div className="text-text-primary">{selected.name} <span className="text-text-tertiary text-xs">{selected.sku}</span></div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-text-secondary text-xs uppercase tracking-wider">Quantity</label>
                <div className="flex items-center gap-2 mt-1">
                  <button onClick={() => setQuantity((q) => Math.max(1, q - 1))} className="px-3 py-2 border border-border">−</button>
                  <span className="font-mono tnum text-2xl w-12 text-center">{quantity}</span>
                  <button onClick={() => setQuantity((q) => q + 1)} className="px-3 py-2 border border-border">+</button>
                </div>
              </div>
              <div>
                <label className="text-text-secondary text-xs uppercase tracking-wider">Cause</label>
                <select
                  value={cause} onChange={(e) => setCause(e.target.value as Cause)}
                  className="w-full mt-1 bg-bg-input border border-border-strong px-3 py-2">
                  {CAUSES.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
              </div>
            </div>
            <textarea
              value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="What happened? (optional)"
              className="bg-bg-input border border-border-strong px-3 py-2 text-sm"
              rows={2}
            />
            <div className="flex flex-col gap-2">
              <label className="text-text-secondary text-xs uppercase tracking-wider">Photo (required)</label>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" onChange={pickFile}
                className="text-text-primary file:bg-accent file:text-ink file:border-0 file:px-4 file:py-2 file:font-semibold file:cursor-pointer" />
              {photoPreview && (
                <img src={photoPreview} alt="evidence preview"
                  className="max-h-48 border border-border object-contain bg-bg-deep" />
              )}
            </div>
            {error && <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>}
            <div className="flex gap-3">
              <button onClick={() => setSelected(null)} className="px-5 py-3 border border-border hover:bg-bg-elevated">Cancel</button>
              <button
                onClick={() => void submit()}
                disabled={!photoB64 || submitting}
                className="bg-danger text-ink px-5 py-3 font-semibold hover:opacity-90 disabled:opacity-40">
                {submitting ? 'Logging…' : 'Report breakage'}
              </button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
