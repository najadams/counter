// SaleScreen: keyboard-first product search + cart + payment.
//
// Keyboard map:
//   type            search products (debounced ~150ms)
//   ↑ / ↓           move selection in results list
//   Enter           add 1 of selected product to cart
//   F4              Cash payment
//   F5              MoMo payment (modal asks for reference)
//   F6              Credit payment (modal asks for customer)
//   Backspace       delete query char (focus stays on search)
//   Esc             clear cart + payment
//   F2              complete sale (when payment is ready)
//   F9              go back to home

import { useEffect, useMemo, useRef, useState } from 'react';
import { CustomerCreateModal } from '../components/CustomerCreateModal';
import { ReceiptPrintModal } from '../components/ReceiptPrintModal';
import { SplitPaymentModal, type SplitPaymentResult } from '../components/SplitPaymentModal';
import type { SaleReceipt } from '../../shared/lib/receipt';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { useCart, type PaymentMethod } from '../store/cart';
import { AppHeader } from '../components/AppHeader';
import {
  formatMoney, formatMoneyWithCurrency, parseCedisToPesewas,
} from '../../shared/lib/money';
import {
  DISCOUNT_ABS_THRESHOLD_PESEWAS, DISCOUNT_PERCENT_THRESHOLD_BPS,
} from '../../shared/lib/constants';
import { SupervisorPinModal } from '../components/SupervisorPinModal';
import { chimeSuccess, chimeWarning, flashBody } from '../lib/feedback';

interface ProductHit {
  id: string; sku: string; name: string; brand: string | null;
  category: string; unitPricePesewas: number; costPricePesewas: number;
  unitsOnHand: number; isReturnable: boolean;
  defaultUnitId: string | null; defaultUnitName: string; defaultUnitFactor: number;
  canonicalChannelPricePesewas: number;
}

export default function SaleScreen({ onExit }: { onExit: () => void }) {
  const shiftId = useSession((s) => s.shiftId)!;
  const channel = useCart((s) => s.channel);
  const lines = useCart((s) => s.lines);
  const paymentMethod = useCart((s) => s.paymentMethod);
  const paymentReference = useCart((s) => s.paymentReference);
  const cashGiven = useCart((s) => s.cashGivenPesewas);
  const customer = useCart((s) => s.customer);
  const subtotal = useCart((s) => s.subtotalPesewas)();
  const total = useCart((s) => s.totalPesewas)();
  const discount = useCart((s) => s.discountPesewas);
  const addLine = useCart((s) => s.addLine);
  const removeLine = useCart((s) => s.removeLine);
  const bumpQuantity = useCart((s) => s.bumpQuantity);
  const setQuantity = useCart((s) => s.setQuantity);
  const setPaymentMethod = useCart((s) => s.setPaymentMethod);
  const setChannel = useCart((s) => s.setChannel);
  const setPaymentReference = useCart((s) => s.setPaymentReference);
  const setCashGivenPesewas = useCart((s) => s.setCashGivenPesewas);
  const setCustomer = useCart((s) => s.setCustomer);
  const clearCart = useCart((s) => s.clear);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [hitIdx, setHitIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completedToast, setCompletedToast] = useState<string | null>(null);
  // Last completed sale's receipt — kept after the toast clears so the cashier
  // can still hit F8 / the Print button to bring up the OS print dialog.
  // Reset when a new line is added to start the next sale.
  const [lastReceipt, setLastReceipt] = useState<SaleReceipt | null>(null);
  const [showReceiptPrint, setShowReceiptPrint] = useState(false);
  const [discountRaw, setDiscountRaw] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const setDiscount = useCart((s) => s.setDiscount);
  const [needsDiscountSupervisor, setNeedsDiscountSupervisor] = useState(false);
  const [pendingSupervisor, setPendingSupervisor] = useState<{ id: string; pin: string } | null>(null);
  const [swapUnitFor, setSwapUnitFor] = useState<string | null>(null);
  const [channelSwitchBanner, setChannelSwitchBanner] = useState<'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null>(null);
  const [showCustomerPicker, setShowCustomerPicker] = useState(false);
  const swapUnit = useCart((s) => s.swapUnit);
  const repriceLines = useCart((s) => s.repriceLines);

  async function attemptChannelChange(next: 'WALK_IN' | 'WHOLESALE' | 'ROUTE') {
    if (next === channel) return;
    // Re-price each existing line for the new channel BEFORE flipping the
    // channel flag — that way subtotals don't briefly render with stale
    // pricing. Empty cart? Just flip.
    if (lines.length > 0) {
      const r = await counter.repriceLines({
        channel: next,
        lines: lines.map((l) => ({ productId: l.productId, unitId: l.unitId })),
      });
      if (!r.success) {
        setError(`Channel switch failed: ${r.error}`);
        return;
      }
      repriceLines(r.data.lines);
    }
    setChannel(next);
    setChannelSwitchBanner(null);
  }

  // When the picked customer has a preferredChannel that differs from the
  // current cart channel, surface a banner offering to switch.
  useEffect(() => {
    const pref = (customer as { preferredChannel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null } | null)?.preferredChannel ?? null;
    if (pref && pref !== channel) {
      setChannelSwitchBanner(pref);
    } else {
      setChannelSwitchBanner(null);
    }
  }, [customer, channel]);
  const [showPaymentModal, setShowPaymentModal] = useState<PaymentMethod | null>(null);
  const [showSplit, setShowSplit] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { searchRef.current?.focus(); }, []);

  // Push discount input to the cart store
  useEffect(() => {
    const p = parseCedisToPesewas(discountRaw);
    setDiscount(p ?? 0, discountReason);
  }, [discountRaw, discountReason, setDiscount]);

  // Clear stale submit errors when the cart composition changes (item added
  // or removed) — that's a meaningfully different submission. Don't clear
  // on quantity-only edits, customer swaps, or channel switches, since the
  // user is often remediating exactly what the error flagged and silently
  // wiping the message hides whether they fixed it. All submit paths
  // already clear the error at start (see submit handlers), so a successful
  // re-submit will clear it too.
  useEffect(() => {
    setError(null);
  }, [lines.length]);


  // Debounced product search
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await counter.searchProducts(query, channel, 12);
      if (cancelled) return;
      if (res.success) {
        setHits(res.data.products);
        setHitIdx(0);
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query, channel]);

  function addHitToCart(idx: number) {
    const hit = hits[idx];
    if (!hit) return;
    addLine({
      productId: hit.id,
      sku: hit.sku,
      name: hit.name,
      unitId: hit.defaultUnitId,
      unitName: hit.defaultUnitName,
      factor: hit.defaultUnitFactor,
      basePricePesewas: hit.unitPricePesewas,
      unitPricePesewas: hit.unitPricePesewas,
      appliedTierId: null,
      appliedTierMinQuantity: null,
      unitsOnHand: hit.unitsOnHand,
    });
    // Keep query so user can keep adding or clear with backspace.
  }

  // Tier auto-application: when a cart line's quantity changes, fetch the
  // best applicable tier for the current channel and apply (or revert).
  const applyTier = useCart((s) => s.applyTier);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const line of lines) {
        const canonicalQty = line.quantity * line.factor;
        const r = await counter.getBestPricingTier(line.productId, channel === 'WHOLESALE' ? 'WHOLESALE' : channel === 'ROUTE' ? 'ROUTE' : 'WALK_IN', canonicalQty, line.unitId);
        if (cancelled) return;
        if (r.success) {
          const tier = r.data.tier;
          // Tier price is per-canonical. Compare to per-unit base price after × factor.
          const tierUnitPrice = tier ? tier.unitPricePesewas * line.factor : null;
          if (tier && tierUnitPrice != null && tierUnitPrice < line.basePricePesewas) {
            applyTier(line.productId, { id: tier.id, unitPricePesewas: tier.unitPricePesewas, minQuantity: tier.minQuantity });
          } else if (line.appliedTierId !== null) {
            applyTier(line.productId, null);
          }
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines.map((l) => `${l.productId}:${l.quantity}`).join('|'), channel]);

  // Global keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't intercept while a modal is open and an input is focused
      if (showPaymentModal && document.activeElement?.tagName === 'INPUT') return;

      if (e.key === 'F4') { e.preventDefault(); openPayment('CASH'); }
      else if (e.key === 'F5') { e.preventDefault(); openPayment('MOMO_MTN'); }
      else if (e.key === 'F6') { e.preventDefault(); openPayment('CREDIT'); }
      else if (e.key === 'F2') { e.preventDefault(); void submitSale(); }
      else if (e.key === 'F8') { e.preventDefault(); if (lastReceipt) setShowReceiptPrint(true); }
      else if (e.key === 'F9') { e.preventDefault(); onExit(); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        if (showPaymentModal) setShowPaymentModal(null);
        else { clearCart(); setError(null); }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPaymentModal, paymentMethod, paymentReference, cashGiven, customer, lines.length, lastReceipt]);

  function openPayment(method: PaymentMethod) {
    if (lines.length === 0) {
      setError('Add items before choosing payment.');
      return;
    }
    setError(null);
    setPaymentMethod(method);
    setShowPaymentModal(method);
  }

  async function submitWithSplit(result: SplitPaymentResult): Promise<void> {
    setShowSplit(false);
    setSubmitting(true);
    setError(null);
    const sup = pendingSupervisor;
    if (discount > 0 && discount > Math.max(Math.floor((subtotal * DISCOUNT_PERCENT_THRESHOLD_BPS) / 10000), DISCOUNT_ABS_THRESHOLD_PESEWAS)) {
      if (!sup) {
        setSubmitting(false);
        setError('Discount above threshold needs a supervisor PIN.');
        return;
      }
      if (!discountReason.trim()) {
        setSubmitting(false);
        setError('Discount needs a reason.');
        return;
      }
    }
    const res = await counter.completeSale({
      shiftId,
      channel,
      lines: lines.map((l) => ({
        productId: l.productId, quantity: l.quantity, unitPricePesewas: l.unitPricePesewas,
        unitId: l.unitId,
      })),
      discountPesewas: discount,
      discountReason: discount > 0 ? discountReason : null,
      supervisorWorkerId: sup?.id ?? null,
      supervisorPin: sup?.pin ?? null,
      payments: result.payments,
      customerId: customer?.id ?? null,
    });
    setSubmitting(false);
    if (!res.success) { setError(res.error); return; }
    const { saleId, changePesewas, printerFailed, printerError, receipt } = res.data;
    if (printerFailed) { chimeWarning(); flashBody('flash-warning'); }
    else { chimeSuccess(); flashBody('flash-success'); }
    let toast = `Sale ${saleId.slice(-8)} complete.`;
    if (changePesewas != null && changePesewas > 0) toast += ` Change: ${formatMoneyWithCurrency(changePesewas)}.`;
    if (printerFailed) toast += `  ⚠ Receipt queued — ${printerError ?? 'printer offline'}.`;
    setCompletedToast(toast);
    setLastReceipt(receipt);
    clearCart();
    setDiscountRaw('');
    setDiscountReason('');
    setPendingSupervisor(null);
    setQuery('');
    setHits([]);
    setShowPaymentModal(null);
    setTimeout(() => setCompletedToast(null), 5000);
    searchRef.current?.focus();
  }

  async function submitSale(supervisorOverride?: { id: string; pin: string }) {
    if (submitting) return;
    if (lines.length === 0) { setError('Cart is empty.'); return; }
    if (!paymentMethod) { setError('Pick a payment method (F4/F5/F6).'); return; }
    if (paymentMethod.startsWith('MOMO_') && paymentReference.trim() === '') {
      setError('MoMo needs a transaction reference.');
      setShowPaymentModal(paymentMethod);
      return;
    }
    if (paymentMethod === 'CASH' && (cashGiven == null || cashGiven < total)) {
      setError('Cash given must be at least the total.');
      setShowPaymentModal('CASH');
      return;
    }
    if (paymentMethod === 'CREDIT' && !customer) {
      setError('Pick a customer for credit.');
      setShowPaymentModal('CREDIT');
      return;
    }

    // Discount supervisor gate
    const sup = supervisorOverride ?? pendingSupervisor;
    if (discount > 0) {
      const percentLimit = Math.floor((subtotal * DISCOUNT_PERCENT_THRESHOLD_BPS) / 10000);
      const limit = Math.max(percentLimit, DISCOUNT_ABS_THRESHOLD_PESEWAS);
      if (discount > limit && !sup) {
        setNeedsDiscountSupervisor(true);
        return;
      }
      if (discount > 0 && !discountReason.trim()) {
        setError('Discount needs a reason.');
        return;
      }
    }

    setSubmitting(true);
    setError(null);
    const res = await counter.completeSale({
      shiftId,
      channel,
      lines: lines.map((l) => ({
        productId: l.productId, quantity: l.quantity, unitPricePesewas: l.unitPricePesewas,
        unitId: l.unitId,
      })),
      discountPesewas: discount,
      discountReason: discount > 0 ? discountReason : null,
      supervisorWorkerId: sup?.id ?? null,
      supervisorPin: sup?.pin ?? null,
      paymentMethod,
      paymentReference: paymentMethod.startsWith('MOMO_') ? paymentReference : null,
      cashGivenPesewas: paymentMethod === 'CASH' ? cashGiven : null,
      customerId: customer?.id ?? null,
    });
    setSubmitting(false);
    if (!res.success) { setError(res.error); return; }
    const { saleId, changePesewas, printerFailed, printerError, receipt } = res.data;
    if (printerFailed) {
      chimeWarning();
      flashBody('flash-warning');
    } else {
      chimeSuccess();
      flashBody('flash-success');
    }
    let toast = `Sale ${saleId.slice(-8)} complete.`;
    if (changePesewas != null) toast += ` Change: ${formatMoneyWithCurrency(changePesewas)}.`;
    if (printerFailed) toast += `  ⚠ Receipt queued — ${printerError ?? 'printer offline'}.`;
    setCompletedToast(toast);
    setLastReceipt(receipt);
    clearCart();
    setDiscountRaw('');
    setDiscountReason('');
    setPendingSupervisor(null);
    setQuery('');
    setHits([]);
    setShowPaymentModal(null);
    setTimeout(() => setCompletedToast(null), 5000);
    searchRef.current?.focus();
  }

  // Barcode-scanner detection. USB scanners type ~ms-fast digit bursts
  // ending with Enter. If the gap between keystrokes since the previous
  // digit is < 30ms AND we've seen 6+ digits in this burst, treat the
  // Enter as a barcode submission and look up the exact match.
  const lastKeyAtRef = useRef<number>(0);
  const burstLenRef = useRef<number>(0);
  async function tryBarcodeSubmit(): Promise<boolean> {
    const text = query.trim();
    if (text.length < 6) return false;
    if (!/^\d+$/.test(text)) return false;
    const r = await counter.searchProducts(text, channel, 5);
    if (!r.success || r.data.products.length === 0) return false;
    // Prefer exact barcode match if any returned product has matching barcode field.
    // searchProducts returns name/sku/etc but barcode wasn't selected; the search itself
    // does the equality check, so the first hit is the right one if there is exactly one.
    const exact = r.data.products[0]!;
    setHits([exact]);
    setHitIdx(0);
    addHitToCart(0);
    return true;
  }

  function searchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    const now = performance.now();
    const gap = now - lastKeyAtRef.current;
    if (e.key.length === 1 && /\d/.test(e.key)) {
      if (gap < 30) burstLenRef.current += 1; else burstLenRef.current = 1;
      lastKeyAtRef.current = now;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHitIdx((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHitIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // If we just received a fast digit burst, try the barcode path first.
      if (burstLenRef.current >= 6) {
        burstLenRef.current = 0;
        void (async () => {
          const handled = await tryBarcodeSubmit();
          if (!handled) addHitToCart(hitIdx);
        })();
      } else {
        addHitToCart(hitIdx);
      }
    }
  }

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <AppHeader subtitle="sale" />
      <main className="flex-1 grid grid-cols-[2fr_1fr] gap-0">
        {/* Left: search + results */}
        <section className="border-r border-border flex flex-col">
          <div className="px-6 py-4 border-b border-border bg-bg-surface">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={searchKey}
              placeholder="Search by SKU or name…"
              className="w-full bg-bg-input border border-border-strong px-4 py-3 text-lg focus:outline-none focus:border-accent"
            />
            <div className="text-text-tertiary text-xs mt-2">
              <span className="kbd">↑</span><span className="kbd">↓</span> move ·
              <span className="kbd">Enter</span> add ·
              <span className="kbd">F4</span> Cash ·
              <span className="kbd">F5</span> MoMo ·
              <span className="kbd">F6</span> Credit ·
              <span className="kbd">F2</span> Complete ·
              <span className="kbd">F8</span> Print ·
              <span className="kbd">F9</span> Back ·
              <span className="kbd">Esc</span> Clear
            </div>
          </div>
          <ul className="flex-1 overflow-y-auto">
            {hits.length === 0 && (
              <li className="px-6 py-4 text-text-tertiary">No products match.</li>
            )}
            {hits.map((p, i) => {
              const active = i === hitIdx;
              const lowStock = p.unitsOnHand <= 0;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => { setHitIdx(i); addHitToCart(i); }}
                    className={[
                      'w-full text-left px-6 py-3 grid grid-cols-[1fr_auto_auto] gap-4 items-baseline border-b border-border',
                      active ? 'bg-bg-elevated' : 'bg-bg-surface hover:bg-bg-elevated',
                    ].join(' ')}
                  >
                    <div className="min-w-0">
                      <div className="text-text-primary truncate">{p.name}</div>
                      <div className="text-text-tertiary text-xs">{p.sku} · {p.category}</div>
                    </div>
                    <div className={`tnum text-sm ${lowStock ? 'text-danger' : 'text-text-secondary'}`}>
                      {p.unitsOnHand} on hand
                    </div>
                    <div className="font-mono tnum text-text-primary">{formatMoney(p.unitPricePesewas)}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        {/* Right: cart + totals + payment */}
        <section className="flex flex-col bg-bg-surface">
          <div className="px-6 py-4 border-b border-border flex flex-col gap-3">
            <div className="text-text-secondary uppercase tracking-wider text-xs">Cart</div>
            <div>
              <div className="text-text-tertiary uppercase tracking-wider text-[10px] mb-1">Channel</div>
              <div className="grid grid-cols-3 gap-1">
                {(['WALK_IN', 'WHOLESALE', 'ROUTE'] as const).map((c) => {
                  const active = c === channel;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => attemptChannelChange(c)}
                      className={[
                        'px-2 py-1.5 border text-xs uppercase tracking-wider',
                        active
                          ? 'bg-bg-elevated border-accent text-accent'
                          : 'border-border bg-bg-deep text-text-primary hover:bg-bg-elevated',
                      ].join(' ')}>
                      {c === 'WALK_IN' ? 'Walk-in' : c === 'WHOLESALE' ? 'Wholesale' : 'Route'}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="text-text-tertiary uppercase tracking-wider text-[10px] mb-1">Customer</div>
              {customer ? (
                <div className="flex items-baseline justify-between gap-2 bg-bg-deep border border-border px-3 py-1.5">
                  <div className="min-w-0">
                    <div className="text-text-primary text-sm truncate">{customer.displayName}</div>
                    <div className="text-text-tertiary text-xs truncate">
                      {customer.phone} · bal {formatMoneyWithCurrency(customer.currentBalancePesewas)}
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => setShowCustomerPicker(true)}
                      className="text-accent text-xs hover:text-accent-light">change</button>
                    <button
                      type="button"
                      onClick={() => setCustomer(null)}
                      className="text-text-tertiary text-xs hover:text-danger">clear</button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setShowCustomerPicker(true)}
                  className="w-full px-3 py-1.5 border border-border bg-bg-deep text-text-primary hover:bg-bg-elevated text-xs text-left">
                  + Attach customer (optional)
                </button>
              )}
            </div>
            {channelSwitchBanner && (
              <div className="bg-bg-deep border border-warning px-3 py-2 text-warning text-xs flex items-center justify-between gap-2">
                <span>{customer?.displayName} prefers <span className="font-semibold">{channelSwitchBanner.replace('_', ' ')}</span> pricing.</span>
                <button
                  onClick={() => attemptChannelChange(channelSwitchBanner)}
                  className="px-2 py-0.5 border border-warning text-warning hover:bg-warning hover:text-ink">
                  Switch
                </button>
              </div>
            )}
          </div>
          <ul className="flex-1 overflow-y-auto">
            {lines.length === 0 && (
              <li className="px-6 py-6 text-text-tertiary">Empty.</li>
            )}
            {lines.map((l) => (
              <li key={l.productId} className="px-6 py-3 border-b border-border">
                <div className="flex items-baseline justify-between">
                  <span className="text-text-primary truncate">{l.name}</span>
                  <span className="font-mono tnum">{formatMoney(l.unitPricePesewas * l.quantity)}</span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-text-tertiary text-xs">
                  <button
                    onClick={() => bumpQuantity(l.productId, -1)}
                    className="px-2 py-0.5 border border-border hover:bg-bg-elevated text-text-primary"
                    aria-label="Decrease quantity"
                  >−</button>
                  <QuantityInput
                    productId={l.productId}
                    quantity={l.quantity}
                    onCommit={(n) => setQuantity(l.productId, n)}
                    onRemove={() => removeLine(l.productId)}
                  />
                  <button
                    onClick={() => bumpQuantity(l.productId, +1)}
                    className="px-2 py-0.5 border border-border hover:bg-bg-elevated text-text-primary"
                    aria-label="Increase quantity"
                  >+</button>
                  <button
                    onClick={() => setSwapUnitFor(l.productId)}
                    className="px-1.5 py-0.5 border border-border text-text-primary hover:bg-bg-elevated text-[10px] uppercase tracking-wider"
                    title="Swap unit"
                  >{l.unitName}</button>
                  <span>× {formatMoney(l.unitPricePesewas)}</span>
                  {l.appliedTierId && l.appliedTierMinQuantity != null && (
                    <span className="bg-accent-dim text-ink px-1.5 py-0.5 text-[10px] uppercase tracking-wider">
                      ≥ {l.appliedTierMinQuantity} tier
                    </span>
                  )}
                  <button
                    onClick={() => removeLine(l.productId)}
                    className="ml-auto text-text-tertiary hover:text-danger"
                  >remove</button>
                </div>
              </li>
            ))}
          </ul>

          <div className="border-t border-border px-6 py-4 flex flex-col gap-2">
            <Row label="Subtotal" value={formatMoney(subtotal)} />

            <div className="grid grid-cols-[1fr_2fr] gap-2 items-baseline">
              <span className="text-text-secondary uppercase tracking-wider text-xs">Discount</span>
              <input
                value={discountRaw}
                onChange={(e) => setDiscountRaw(e.target.value)}
                placeholder="0.00"
                className="bg-bg-input border border-border-strong px-2 py-1 font-mono tnum text-right text-sm" />
            </div>
            {discount > 0 && (
              <div className="grid grid-cols-[1fr_2fr] gap-2 items-baseline">
                <span className="text-text-secondary uppercase tracking-wider text-xs">Reason</span>
                <input
                  value={discountReason}
                  onChange={(e) => setDiscountReason(e.target.value)}
                  placeholder="why? (e.g. regular customer)"
                  className="bg-bg-input border border-border-strong px-2 py-1 text-sm" />
              </div>
            )}
            {discount > 0 && (() => {
              const limit = Math.max(Math.floor((subtotal * DISCOUNT_PERCENT_THRESHOLD_BPS) / 10000), DISCOUNT_ABS_THRESHOLD_PESEWAS);
              return discount > limit ? (
                <div className="text-warning text-xs">
                  Above {formatMoney(limit)} — supervisor PIN required at completion.
                </div>
              ) : null;
            })()}
            <Row label="TOTAL" value={formatMoney(total)} large />

            {paymentMethod && (
              <div className="text-text-secondary text-xs mt-2">
                Payment: <span className="text-text-primary">{paymentMethod}</span>
                {paymentMethod.startsWith('MOMO_') && paymentReference && (
                  <> · ref <span className="font-mono">{paymentReference}</span></>
                )}
                {paymentMethod === 'CASH' && cashGiven != null && (
                  <> · cash <span className="font-mono tnum">{formatMoney(cashGiven)}</span> · change <span className="font-mono tnum">{formatMoney(Math.max(0, cashGiven - total))}</span></>
                )}
                {paymentMethod === 'CREDIT' && customer && (
                  <> · {customer.displayName}</>
                )}
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 mt-2">
              <PayBtn label="Cash" hot="F4" onClick={() => openPayment('CASH')} active={paymentMethod === 'CASH'} />
              <PayBtn label="MoMo" hot="F5" onClick={() => openPayment('MOMO_MTN')} active={paymentMethod?.startsWith('MOMO_') ?? false} />
              <PayBtn label="Credit" hot="F6" onClick={() => openPayment('CREDIT')} active={paymentMethod === 'CREDIT'} />
            </div>
            <button
              onClick={() => { if (lines.length > 0) setShowSplit(true); }}
              disabled={lines.length === 0}
              className="text-sm px-3 py-2 border border-border hover:bg-bg-deep disabled:opacity-40 mt-1"
            >
              Split payment (cash + MoMo, etc.)
            </button>
            <button
              onClick={() => void submitSale()}
              disabled={submitting || lines.length === 0 || !paymentMethod}
              className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed mt-2"
            >
              {submitting ? 'Completing…' : 'Complete sale'} <span className="kbd">F2</span>
            </button>

            {error && (
              <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{error}</div>
            )}
            {completedToast && (
              <div className="bg-bg-deep border border-success px-4 py-2 text-success text-sm flex items-center justify-between gap-3">
                <span>{completedToast}</span>
                {lastReceipt && (
                  <button
                    type="button"
                    onClick={() => setShowReceiptPrint(true)}
                    className="border border-success px-3 py-1 text-xs hover:bg-success hover:text-ink">
                    Print receipt <span className="kbd">F8</span>
                  </button>
                )}
              </div>
            )}
            {!completedToast && lastReceipt && (
              <button
                type="button"
                onClick={() => setShowReceiptPrint(true)}
                className="text-text-tertiary text-xs hover:text-text-secondary text-left">
                Reprint last sale #{lastReceipt.receiptId.slice(-8)} <span className="kbd">F8</span>
              </button>
            )}
          </div>
        </section>
      </main>

      {showReceiptPrint && lastReceipt && (
        <ReceiptPrintModal receipt={lastReceipt} onClose={() => setShowReceiptPrint(false)} />
      )}

      {showSplit && (
        <SplitPaymentModal
          totalPesewas={total}
          hasCustomer={!!customer}
          onCancel={() => setShowSplit(false)}
          onConfirm={(r) => void submitWithSplit(r)}
        />
      )}

      {showPaymentModal && (
        <PaymentModal
          method={showPaymentModal}
          totalPesewas={total}
          onClose={() => setShowPaymentModal(null)}
          onConfirm={() => setShowPaymentModal(null)}
          paymentReference={paymentReference}
          setPaymentReference={setPaymentReference}
          setPaymentMethod={setPaymentMethod}
          cashGiven={cashGiven}
          setCashGivenPesewas={setCashGivenPesewas}
          customer={customer}
          setCustomer={setCustomer}
        />
      )}
      {needsDiscountSupervisor && (
        <SupervisorPinModal
          title={`Approve discount of ${formatMoneyWithCurrency(discount)}`}
          onCancel={() => setNeedsDiscountSupervisor(false)}
          onApprove={(supId, pin) => {
            setPendingSupervisor({ id: supId, pin });
            setNeedsDiscountSupervisor(false);
            void submitSale({ id: supId, pin });
          }}
        />
      )}
      {showCustomerPicker && (
        <CustomerPickerModal
          currentId={customer?.id ?? null}
          onCancel={() => setShowCustomerPicker(false)}
          onPick={(c) => {
            setCustomer(c);
            setShowCustomerPicker(false);
          }}
          onClear={() => {
            setCustomer(null);
            setShowCustomerPicker(false);
          }}
        />
      )}
      {swapUnitFor && (
        <UnitSwapModal
          productId={swapUnitFor}
          currentUnitId={lines.find((l) => l.productId === swapUnitFor)?.unitId ?? null}
          onCancel={() => setSwapUnitFor(null)}
          onPick={(u) => {
            swapUnit(swapUnitFor, u);
            setSwapUnitFor(null);
          }}
        />
      )}
    </div>
  );
}

interface UnitOption {
  id: string; productId: string; unitName: string;
  conversionFactor: number; pricePesewas: number;
  isPurchaseUnit: boolean; isSaleUnit: boolean;
  displayOrder: number; active: boolean; notes: string | null;
}

function CustomerPickerModal({
  currentId, onCancel, onPick, onClear,
}: {
  currentId: string | null;
  onCancel: () => void;
  onPick: (c: NonNullable<ReturnType<typeof useCart.getState>['customer']>) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<NonNullable<ReturnType<typeof useCart.getState>['customer']>[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await counter.searchCustomers(query, 10);
      if (cancelled) return;
      if (res.success) {
        setHits(res.data.customers as NonNullable<ReturnType<typeof useCart.getState>['customer']>[]);
      }
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [query]);

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center z-[60]" onClick={onCancel}>
      <div className="bg-bg-surface border border-border w-full max-w-lg p-6 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">Pick customer</h3>
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or phone…"
          className="bg-bg-input border border-border-strong px-4 py-3"
        />
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="self-start text-accent text-sm hover:text-accent-light">
          + New customer
        </button>
        <ul className="flex flex-col max-h-72 overflow-y-auto">
          {hits.length === 0 && (
            <li className="text-text-tertiary text-sm px-2 py-2">
              {query.length > 0 ? 'No matches.' : 'Start typing to search.'}
            </li>
          )}
          {hits.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick({
                  id: c.id,
                  displayName: c.displayName,
                  phone: c.phone,
                  currentBalancePesewas: c.currentBalancePesewas,
                  preferredChannel: (c as { preferredChannel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null }).preferredChannel ?? null,
                })}
                className={[
                  'w-full text-left px-4 py-3 border-b border-border',
                  currentId === c.id ? 'bg-bg-elevated' : 'bg-bg-deep hover:bg-bg-elevated',
                ].join(' ')}>
                <div className="text-text-primary">{c.displayName}</div>
                <div className="text-text-tertiary text-xs">
                  {c.phone} · balance {formatMoneyWithCurrency(c.currentBalancePesewas)}
                </div>
              </button>
            </li>
          ))}
        </ul>
        <div className="flex justify-between items-center mt-1">
          {currentId ? (
            <button
              type="button"
              onClick={onClear}
              className="text-danger text-sm hover:text-text-primary">Remove customer</button>
          ) : <span />}
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">Cancel</button>
        </div>
        {showCreate && (
          <CustomerCreateModal
            initialPhone={/^[0+\d]/.test(query) ? query : ''}
            onCancel={() => setShowCreate(false)}
            onCreated={(c) => {
              setShowCreate(false);
              onPick({
                id: c.id,
                displayName: c.displayName,
                phone: c.phone,
                currentBalancePesewas: c.currentBalancePesewas,
                preferredChannel: null,
              });
            }}
          />
        )}
      </div>
    </div>
  );
}

function UnitSwapModal({
  productId, currentUnitId, onCancel, onPick,
}: {
  productId: string;
  currentUnitId: string | null;
  onCancel: () => void;
  onPick: (u: { id: string; unitName: string; conversionFactor: number; pricePesewas: number }) => void;
}) {
  const [units, setUnits] = useState<UnitOption[]>([]);
  useEffect(() => {
    void (async () => {
      const r = await counter.listProductUnits(productId, true);
      if (r.success) setUnits(r.data.units.filter((u: UnitOption) => u.isSaleUnit));
    })();
  }, [productId]);

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center z-[60]" onClick={onCancel}>
      <div className="bg-bg-surface border border-border w-full max-w-md p-6 flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">Sellable units</h3>
        {units.length === 0 && <div className="text-text-tertiary text-sm">No sellable units defined.</div>}
        <ul className="flex flex-col gap-1">
          {units.map((u) => {
            const active = u.id === currentUnitId;
            return (
              <li key={u.id}>
                <button
                  onClick={() => onPick({ id: u.id, unitName: u.unitName, conversionFactor: u.conversionFactor, pricePesewas: u.pricePesewas })}
                  disabled={active}
                  className={[
                    'w-full px-4 py-3 text-left border flex items-center justify-between',
                    active ? 'border-accent bg-bg-elevated' : 'border-border bg-bg-deep hover:bg-bg-elevated',
                  ].join(' ')}>
                  <div>
                    <div className="text-text-primary">{u.unitName}</div>
                    <div className="text-text-tertiary text-xs">factor × {u.conversionFactor}</div>
                  </div>
                  <span className="font-mono tnum">{formatMoney(u.pricePesewas)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <button onClick={onCancel} className="self-end px-4 py-2 border border-border hover:bg-bg-elevated text-sm">Cancel</button>
      </div>
    </div>
  );
}

// Editable per-line quantity. Owns a local string buffer so the cashier can
// type "50" naturally (intermediate empty / partial states are fine — the
// store only updates on Enter / blur with a valid positive integer). Esc
// cancels; backspace into empty + blur removes the line, matching the spirit
// of `setQuantity(0)` in the store.
function QuantityInput({
  productId, quantity, onCommit, onRemove,
}: {
  productId: string;
  quantity: number;
  onCommit: (n: number) => void;
  onRemove: () => void;
}) {
  const [raw, setRaw] = useState(String(quantity));
  const [focused, setFocused] = useState(false);

  // Sync local buffer back to the line's quantity when it changes externally
  // (e.g. +/- buttons, tier reload) and we aren't currently editing.
  useEffect(() => {
    if (!focused) setRaw(String(quantity));
  }, [quantity, focused]);

  function commit() {
    const trimmed = raw.trim();
    if (trimmed === '') { onRemove(); return; }
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n <= 0) { setRaw(String(quantity)); return; }
    if (n !== quantity) onCommit(n);
    else setRaw(String(quantity));
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={raw}
      onChange={(e) => setRaw(e.target.value.replace(/[^\d]/g, ''))}
      onFocus={(e) => { setFocused(true); e.target.select(); }}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLInputElement).blur(); }
        else if (e.key === 'Escape') {
          e.preventDefault();
          setRaw(String(quantity));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      aria-label={`Quantity for ${productId}`}
      className="font-mono tnum text-text-primary w-14 text-center bg-bg-input border border-border hover:border-border-strong focus:border-accent focus:outline-none px-1 py-0.5"
    />
  );
}

function Row({ label, value, large }: { label: string; value: string; large?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={`text-text-secondary uppercase tracking-wider ${large ? 'text-sm' : 'text-xs'}`}>{label}</span>
      <span className={`font-mono tnum ${large ? 'text-2xl text-accent' : 'text-text-primary'}`}>{value}</span>
    </div>
  );
}

function PayBtn({ label, hot, onClick, active }: { label: string; hot: string; onClick: () => void; active: boolean }) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-3 py-3 border text-sm flex flex-col items-center gap-1',
        active ? 'bg-bg-elevated border-accent text-accent' : 'border-border bg-bg-deep hover:bg-bg-elevated text-text-primary',
      ].join(' ')}
    >
      <span>{label}</span>
      <span className="kbd">{hot}</span>
    </button>
  );
}

interface PaymentModalProps {
  method: PaymentMethod;
  totalPesewas: number;
  onClose: () => void;
  onConfirm: () => void;
  paymentReference: string;
  setPaymentReference: (s: string) => void;
  setPaymentMethod: (m: PaymentMethod | null) => void;
  cashGiven: number | null;
  setCashGivenPesewas: (n: number | null) => void;
  customer: ReturnType<typeof useCart.getState>['customer'];
  setCustomer: (c: ReturnType<typeof useCart.getState>['customer']) => void;
}

function PaymentModal(p: PaymentModalProps) {
  const isMomo = p.method.startsWith('MOMO_');
  const isCash = p.method === 'CASH';
  const isCredit = p.method === 'CREDIT';

  const [cashRaw, setCashRaw] = useState(p.cashGiven != null ? formatMoney(p.cashGiven) : formatMoney(p.totalPesewas));
  const [refRaw, setRefRaw] = useState(p.paymentReference);
  const [showCreate, setShowCreate] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [custHits, setCustHits] = useState<NonNullable<ReturnType<typeof useCart.getState>['customer']>[]>([]);
  const [momoProvider, setMomoProvider] = useState<PaymentMethod>(isMomo ? p.method : 'MOMO_MTN');

  const cashPesewas = useMemo(() => parseCedisToPesewas(cashRaw), [cashRaw]);
  const change = cashPesewas != null ? cashPesewas - p.totalPesewas : null;

  // Customer search
  useEffect(() => {
    if (!isCredit) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await counter.searchCustomers(custQuery, 8);
      if (cancelled) return;
      if (res.success) setCustHits(res.data.customers as NonNullable<ReturnType<typeof useCart.getState>['customer']>[]);
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [custQuery, isCredit]);

  function confirm() {
    if (isCash) {
      if (cashPesewas == null || cashPesewas < p.totalPesewas) return;
      p.setCashGivenPesewas(cashPesewas);
    } else if (isMomo) {
      if (refRaw.trim() === '') return;
      p.setPaymentMethod(momoProvider);
      p.setPaymentReference(refRaw.trim());
    } else if (isCredit) {
      if (!p.customer) return;
    }
    p.onConfirm();
  }

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center" onClick={p.onClose}>
      <div className="bg-bg-surface border border-border w-full max-w-md p-8 flex flex-col gap-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-text-secondary uppercase tracking-wider text-xs">
          {isCash && 'Cash'}
          {isMomo && 'MoMo'}
          {isCredit && 'Credit (on account)'}
        </h3>

        {isCash && (
          <>
            <div className="text-text-tertiary text-sm">Total due: <span className="font-mono tnum text-text-primary">{formatMoneyWithCurrency(p.totalPesewas)}</span></div>
            <label className="text-text-secondary text-xs uppercase tracking-wider">Cash given</label>
            <input
              autoFocus
              value={cashRaw}
              onChange={(e) => setCashRaw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
              className="bg-bg-input border border-border-strong px-4 py-3 text-2xl font-mono tnum text-right"
            />
            {cashPesewas != null && change != null && change >= 0 && (
              <div className="text-text-secondary text-sm">Change due: <span className="font-mono tnum text-text-primary">{formatMoneyWithCurrency(change)}</span></div>
            )}
            {cashPesewas != null && change != null && change < 0 && (
              <div className="text-danger text-sm">Short by {formatMoneyWithCurrency(-change)}.</div>
            )}
          </>
        )}

        {isMomo && (
          <>
            <div className="grid grid-cols-3 gap-2">
              {(['MOMO_MTN', 'MOMO_VODAFONE', 'MOMO_AIRTELTIGO'] as const).map((m) => (
                <button key={m}
                  onClick={() => setMomoProvider(m)}
                  className={[
                    'px-3 py-2 border text-sm',
                    m === momoProvider ? 'bg-bg-elevated border-accent text-accent' : 'border-border bg-bg-deep text-text-primary hover:bg-bg-elevated',
                  ].join(' ')}>
                  {m === 'MOMO_MTN' ? 'MTN' : m === 'MOMO_VODAFONE' ? 'Telecel' : 'AirtelTigo'}
                </button>
              ))}
            </div>
            <label className="text-text-secondary text-xs uppercase tracking-wider">Transaction reference</label>
            <input
              autoFocus
              value={refRaw}
              onChange={(e) => setRefRaw(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirm(); }}
              placeholder="e.g. 7812345678"
              className="bg-bg-input border border-border-strong px-4 py-3 font-mono"
            />
            <div className="text-text-tertiary text-xs">
              Required (invariant 10). Hubtel auto-reconciliation matches this in Week 8.
            </div>
          </>
        )}

        {isCredit && (
          <>
            <input
              autoFocus
              value={custQuery}
              onChange={(e) => setCustQuery(e.target.value)}
              placeholder="Search customer (name or phone)"
              className="bg-bg-input border border-border-strong px-4 py-3"
            />
            <button
              onClick={() => setShowCreate(true)}
              className="self-start text-accent text-sm hover:text-accent-light">
              + New customer
            </button>
            <ul className="flex flex-col max-h-64 overflow-y-auto">
              {custHits.length === 0 && custQuery.length > 0 && (
                <li className="text-text-tertiary text-sm px-2 py-2">No matches.</li>
              )}
              {custHits.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => p.setCustomer({
                      id: c.id, displayName: c.displayName, phone: c.phone,
                      currentBalancePesewas: c.currentBalancePesewas,
                      preferredChannel: (c as { preferredChannel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null }).preferredChannel ?? null,
                    })}
                    className={[
                      'w-full text-left px-4 py-3 border-b border-border',
                      p.customer?.id === c.id ? 'bg-bg-elevated' : 'bg-bg-deep hover:bg-bg-elevated',
                    ].join(' ')}>
                    <div className="text-text-primary">{c.displayName}</div>
                    <div className="text-text-tertiary text-xs">
                      {c.phone} · balance {formatMoneyWithCurrency(c.currentBalancePesewas)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {p.customer && (
              <div className="text-text-secondary text-sm">
                Selected: <span className="text-text-primary">{p.customer.displayName}</span>
              </div>
            )}
            {showCreate && (
              <CustomerCreateModal
                initialPhone={/^[0+\d]/.test(custQuery) ? custQuery : ''}
                onCancel={() => setShowCreate(false)}
                onCreated={(c) => {
                  setShowCreate(false);
                  p.setCustomer({
                    id: c.id,
                    displayName: c.displayName,
                    phone: c.phone,
                    currentBalancePesewas: c.currentBalancePesewas,
                  });
                }}
              />
            )}
          </>
        )}

        <div className="flex gap-3 mt-2">
          <button onClick={p.onClose} className="px-5 py-3 border border-border text-text-primary hover:bg-bg-elevated">Cancel</button>
          <button
            onClick={confirm}
            disabled={
              (isCash && (cashPesewas == null || cashPesewas < p.totalPesewas)) ||
              (isMomo && refRaw.trim() === '') ||
              (isCredit && !p.customer)
            }
            className="bg-accent text-ink px-5 py-3 font-semibold hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
