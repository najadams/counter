import { useEffect, useRef, useState } from 'react';
import { AppHeader } from '../components/AppHeader';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { counter } from '../lib/ipc';
import { useCart } from '../store/cart';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import type {
  PaperReceiptDetail,
  PaperReceiptLineDraft,
  PaperReceiptSummary,
  SaleChannel,
} from '../../shared/types/ipc';

const PAYMENT_METHODS = ['CASH', 'MOMO_MTN', 'MOMO_VODAFONE', 'MOMO_AIRTELTIGO', 'BANK_TRANSFER', 'CREDIT'] as const;

function paperReceiptDisplayStatus(draft: Pick<PaperReceiptSummary, 'status' | 'tillOpenedAt'>): 'REVIEW' | 'AT TILL' | 'POSTED' | 'DISCARDED' {
  if (draft.status === 'REVIEW' && draft.tillOpenedAt) return 'AT TILL';
  return draft.status;
}

function paperReceiptStatusClass(status: ReturnType<typeof paperReceiptDisplayStatus>): string {
  if (status === 'POSTED') return 'text-success';
  if (status === 'DISCARDED') return 'text-danger';
  if (status === 'AT TILL') return 'text-accent';
  return 'text-warning';
}

export default function PaperReceiptsScreen({ onExit, onOpenAtTill }: { onExit: () => void; onOpenAtTill: () => void }) {
  const loadCartLines = useCart((s) => s.loadLines);
  const setSourcePaperReceiptId = useCart((s) => s.setSourcePaperReceiptId);
  const [drafts, setDrafts] = useState<PaperReceiptSummary[]>([]);
  const [selected, setSelected] = useState<PaperReceiptDetail | null>(null);
  const [photoB64, setPhotoB64] = useState<string | null>(null);
  const [photoExt, setPhotoExt] = useState('jpg');
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [channel, setChannel] = useState<SaleChannel>('WALK_IN');
  const [paymentMethod, setPaymentMethod] = useState<string>('CASH');
  const [paymentReference, setPaymentReference] = useState('');
  const [lines, setLines] = useState<PaperReceiptLineDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9' || e.key === 'Escape') {
        e.preventDefault();
        if (selected) clearSelected();
        else onExit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit, selected]);

  async function refresh() {
    const r = await counter.paperReceiptList(50);
    if (r.success) setDrafts(r.data.drafts);
  }

  function hydrate(detail: PaperReceiptDetail) {
    setSelected(detail);
    setChannel(detail.channel);
    setPaymentMethod(detail.paymentMethod);
    setPaymentReference(detail.paymentReference ?? '');
    setLines(detail.lines);
    setPhotoPreview(detail.photoDataUri);
    setPhotoB64(null);
  }

  function clearSelected() {
    setSelected(null);
    setPhotoB64(null);
    setPhotoExt('jpg');
    setPhotoPreview(null);
    setChannel('WALK_IN');
    setPaymentMethod('CASH');
    setPaymentReference('');
    setLines([]);
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function pickFile(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const ext = (file.name.split('.').pop() ?? 'jpg').toLowerCase();
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
      setError('Photo must be jpg, png, or webp.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Photo must be under 5MB.');
      return;
    }
    const buf = await file.arrayBuffer();
    let bin = '';
    const arr = new Uint8Array(buf);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]!);
    setPhotoB64(btoa(bin));
    setPhotoExt(ext === 'jpeg' ? 'jpg' : ext);
    setPhotoPreview(URL.createObjectURL(file));
    setError(null);
  }

  async function createDraft() {
    if (!photoB64) { setError('Receipt photo is required.'); return; }
    setBusy(true); setError(null);
    const r = await counter.paperReceiptCreate({
      photoBase64: photoB64,
      photoExtension: photoExt,
      ocrText: '',
      channel,
      paymentMethod,
      paymentReference: paymentReference.trim() || null,
      cashGivenPesewas: null,
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    const d = await counter.paperReceiptGet(r.data.draftId);
    if (d.success) hydrate(d.data);
    await refresh();
  }

  async function openDraft(id: string) {
    setBusy(true); setError(null);
    const r = await counter.paperReceiptGet(id);
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    hydrate(r.data);
  }

  async function saveDraft(showInfo = true) {
    if (!selected) return false;
    setBusy(true); setError(null);
    const r = await counter.paperReceiptUpdate({
      draftId: selected.id,
      ocrText: selected.ocrText,
      channel,
      paymentMethod,
      paymentReference: paymentReference.trim() || null,
      cashGivenPesewas: null,
      customerId: selected.customerId,
      lines: lines.map((l) => ({
        rawText: l.rawText,
        productId: l.productId,
        unitId: l.unitId,
        quantity: l.quantity,
        unitPricePesewas: l.unitPricePesewas,
        confidence: l.confidence,
        reviewNote: l.reviewNote,
      })),
    });
    setBusy(false);
    if (!r.success) { setError(r.error); return false; }
    const d = await counter.paperReceiptGet(selected.id);
    if (d.success) hydrate(d.data);
    await refresh();
    if (showInfo) {
      setInfo('Draft saved.');
      setTimeout(() => setInfo(null), 3000);
    }
    return true;
  }

  async function openAtTill() {
    if (!selected) return;
    if (!selected.tillOpenedAt) {
      const saved = await saveDraft(false);
      if (!saved) return;
    }
    setBusy(true); setError(null);
    const r = await counter.paperReceiptResolveForCart(selected.id);
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    loadCartLines(
      r.data.lines.map((l) => ({
        productId: l.productId,
        sku: l.sku,
        name: l.name,
        unitId: l.unitId,
        unitName: l.unitName,
        factor: l.factor,
        basePricePesewas: l.unitPricePesewas,
        unitPricePesewas: l.unitPricePesewas,
        appliedTierId: null,
        appliedTierMinQuantity: null,
        quantity: l.quantity,
        unitsOnHand: l.unitsOnHand,
      })),
      r.data.channel,
      null,
    );
    setSourcePaperReceiptId(r.data.draftId);
    onOpenAtTill();
  }

  async function postDraft() {
    if (!selected) return;
    const saved = await saveDraft();
    if (!saved) return;
    setBusy(true); setError(null);
    const r = await counter.paperReceiptPost(selected.id);
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    setInfo(`Posted sale #${r.data.saleId.slice(-6)} for ${formatMoneyWithCurrency(r.data.totalPesewas)}.`);
    clearSelected();
    await refresh();
  }

  async function discardDraft() {
    if (!selected) return;
    const reason = window.prompt('Discard reason')?.trim();
    if (!reason) return;
    setBusy(true); setError(null);
    const r = await counter.paperReceiptDiscard(selected.id, reason);
    setBusy(false);
    if (!r.success) { setError(r.error); return; }
    clearSelected();
    await refresh();
  }

  async function chooseProduct(index: number) {
    const q = window.prompt('Product SKU or name', lines[index]?.rawText ?? '')?.trim();
    if (!q) return;
    const r = await counter.searchProducts(q, channel, 6);
    if (!r.success) { setError(r.error); return; }
    const hit = r.data.products[0];
    if (!hit) { setError('No product match.'); return; }
    setLines((prev) => prev.map((line, i) => i === index ? {
      ...line,
      productId: hit.id,
      productSku: hit.sku,
      productName: hit.name,
      unitId: hit.defaultUnitId,
      unitName: hit.defaultUnitName,
      quantity: line.quantity ?? 1,
      unitPricePesewas: line.unitPricePesewas ?? hit.unitPricePesewas,
      confidence: Math.max(line.confidence, 80),
      reviewNote: null,
    } : line));
  }

  function patchLine(index: number, patch: Partial<PaperReceiptLineDraft>) {
    setLines((prev) => prev.map((line, i) => i === index ? { ...line, ...patch } : line));
  }

  function addLine() {
    setLines((prev) => [...prev, {
      id: `new-${Date.now()}`,
      lineNo: prev.length + 1,
      rawText: '',
      productId: null,
      productSku: null,
      productName: null,
      unitId: null,
      unitName: null,
      quantity: 1,
      unitPricePesewas: null,
      confidence: 0,
      reviewNote: 'Manual line',
    }]);
  }

  const total = lines.reduce((sum, l) => sum + ((l.quantity ?? 0) * (l.unitPricePesewas ?? 0)), 0);
  const canEdit = !selected || (selected.status === 'REVIEW' && !selected.tillOpenedAt);
  const selectedDisplayStatus = selected ? paperReceiptDisplayStatus(selected) : 'REVIEW';

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="paper receipts" onBack={onExit} />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-12 py-8 flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-text-secondary uppercase tracking-wider text-xs">Receipt import</h2>
          <span className="text-text-tertiary text-xs"><span className="kbd">F9</span> back</span>
        </div>
        {info && <div className="bg-bg-surface border border-success px-5 py-3 text-success text-sm">{info}</div>}
        {error && <FeedbackBanner>{error}</FeedbackBanner>}

        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
          <aside className="bg-bg-surface border border-border">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <span className="text-text-secondary uppercase tracking-wider text-xs">Queue</span>
              <button onClick={clearSelected} className="text-xs text-accent hover:text-accent-light">New</button>
            </div>
            <div className="max-h-[68vh] overflow-y-auto divide-y divide-border">
              {drafts.map((d) => (
                (() => {
                  const status = paperReceiptDisplayStatus(d);
                  return (
                    <button
                      key={d.id}
                      onClick={() => void openDraft(d.id)}
                      className={`w-full px-4 py-3 text-left hover:bg-bg-elevated ${selected?.id === d.id ? 'bg-bg-elevated' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs">#{d.id.slice(-6)}</span>
                        <span className={`text-xs ${paperReceiptStatusClass(status)}`}>{status}</span>
                      </div>
                      <div className="mt-1 text-sm">{formatMoneyWithCurrency(d.totalPesewas)}</div>
                      <div className="text-xs text-text-tertiary">{d.matchedLineCount}/{d.lineCount} lines · {new Date(d.createdAt).toLocaleString()}</div>
                      {status === 'AT TILL' && (
                        <div className="text-[11px] text-accent mt-1">
                          Opened by {d.tillOpenedByName ?? 'worker'} · {d.tillOpenedAt ? new Date(d.tillOpenedAt).toLocaleString() : ''}
                        </div>
                      )}
                    </button>
                  );
                })()
              ))}
              {drafts.length === 0 && <div className="px-4 py-6 text-text-tertiary text-sm">No paper receipts yet.</div>}
            </div>
          </aside>

          <section className="bg-bg-surface border border-border p-5 flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-4">
              <div className="flex flex-col gap-3">
                <label className="text-text-secondary text-xs uppercase tracking-wider">Receipt photo</label>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={pickFile}
                  disabled={!!selected}
                  className="text-text-primary text-sm file:bg-accent file:text-ink file:border-0 file:px-3 file:py-2 file:font-semibold file:cursor-pointer"
                />
                {photoPreview && <img src={photoPreview} alt="receipt preview" className="max-h-72 border border-border object-contain bg-bg-deep" />}
              </div>

              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label="Channel">
                    <select value={channel} disabled={!canEdit} onChange={(e) => setChannel(e.target.value as SaleChannel)} className="input">
                      <option value="WALK_IN">WALK_IN</option>
                      <option value="WHOLESALE">WHOLESALE</option>
                      <option value="ROUTE">ROUTE</option>
                    </select>
                  </Field>
                  <Field label="Payment">
                    <select value={paymentMethod} disabled={!canEdit} onChange={(e) => setPaymentMethod(e.target.value)} className="input">
                      {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </Field>
                  <Field label="Reference">
                    <input value={paymentReference} disabled={!canEdit} onChange={(e) => setPaymentReference(e.target.value)} className="input" />
                  </Field>
                </div>
                {!selected && (
                  <button onClick={() => void createDraft()} disabled={busy || !photoB64} className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40 self-start">
                    {busy ? 'Importing…' : 'Import receipt'}
                  </button>
                )}
              </div>
            </div>

            {selected && (
              <>
                <div className="flex items-center justify-between border-t border-border pt-4">
                  <div>
                    <div className="text-text-secondary uppercase tracking-wider text-xs">Review lines</div>
                    <div className="font-mono tnum text-xl mt-1">{formatMoneyWithCurrency(total)}</div>
                  </div>
                  {canEdit && (
                    <div className="flex gap-2">
                      <button onClick={addLine} className="px-3 py-2 border border-border hover:bg-bg-elevated text-sm">Add line</button>
                    </div>
                  )}
                </div>

                <div className="overflow-x-auto border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-text-secondary uppercase tracking-wider text-xs">
                        <th className="px-3 py-2 text-left">Raw</th>
                        <th className="px-3 py-2 text-left">Product</th>
                        <th className="px-3 py-2 text-right">Qty</th>
                        <th className="px-3 py-2 text-left">Unit</th>
                        <th className="px-3 py-2 text-right">Unit price</th>
                        <th className="px-3 py-2 text-right">Line</th>
                        <th className="px-3 py-2 text-right">Confidence</th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {lines.map((line, idx) => (
                        <tr key={line.id}>
                          <td className="px-3 py-2 min-w-44">
                            <input value={line.rawText} disabled={!canEdit} onChange={(e) => patchLine(idx, { rawText: e.target.value })} className="input text-xs" />
                          </td>
                          <td className="px-3 py-2 min-w-52">
                            <div className={line.productId ? '' : 'text-danger'}>
                              {line.productName ?? 'Unmatched'}
                              {line.productSku && <span className="text-text-tertiary text-xs ml-2">{line.productSku}</span>}
                            </div>
                            {line.reviewNote && <div className="text-xs text-text-tertiary">{line.reviewNote}</div>}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              min={1}
                              value={line.quantity ?? ''}
                              disabled={!canEdit}
                              onChange={(e) => patchLine(idx, { quantity: e.target.value ? Number(e.target.value) : null })}
                              className="input w-20 text-right font-mono tnum"
                            />
                          </td>
                          <td className="px-3 py-2 text-left">
                            <span className="text-xs uppercase tracking-wider text-text-tertiary">
                              {line.unitName ?? 'default'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              value={line.unitPricePesewas == null ? '' : formatMoney(line.unitPricePesewas)}
                              disabled={!canEdit}
                              onChange={(e) => patchLine(idx, { unitPricePesewas: e.target.value ? parseCedisToPesewas(e.target.value) : null })}
                              className="input w-28 text-right font-mono tnum"
                            />
                          </td>
                          <td className="px-3 py-2 text-right font-mono tnum">
                            {formatMoney((line.quantity ?? 0) * (line.unitPricePesewas ?? 0))}
                          </td>
                          <td className="px-3 py-2 text-right font-mono tnum">{line.confidence}</td>
                          <td className="px-3 py-2 text-right">
                            {canEdit && (
                              <button onClick={() => void chooseProduct(idx)} className="text-xs text-accent hover:text-accent-light">Find</button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {lines.length === 0 && (
                        <tr><td colSpan={8} className="px-3 py-6 text-center text-text-tertiary">No lines parsed.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap gap-3">
                  {selected.status === 'REVIEW' && (
                    <>
                      <button onClick={() => void openAtTill()} disabled={busy || lines.length === 0} className="px-5 py-3 border border-border hover:bg-bg-elevated disabled:opacity-40">
                        {selectedDisplayStatus === 'AT TILL' ? 'Reopen at till' : 'Open at till'}
                      </button>
                      {canEdit && (
                        <>
                          <button onClick={() => void postDraft()} disabled={busy || lines.length === 0} className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40">
                            {busy ? 'Posting…' : 'Post sale'}
                          </button>
                          <button onClick={() => void discardDraft()} disabled={busy} className="px-5 py-3 border border-danger text-danger hover:bg-danger/10">Discard</button>
                        </>
                      )}
                    </>
                  )}
                  {selectedDisplayStatus === 'AT TILL' && (
                    <div className="text-accent text-sm">
                      Opened at till{selected.tillOpenedByName ? ` by ${selected.tillOpenedByName}` : ''}. It will show POSTED after the sale is saved.
                    </div>
                  )}
                  {!canEdit && selected.postedSaleId && (
                    <div className="text-success text-sm">Posted as sale #{selected.postedSaleId.slice(-6)}.</div>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-text-secondary text-xs uppercase tracking-wider">{label}</span>
      {children}
    </label>
  );
}
