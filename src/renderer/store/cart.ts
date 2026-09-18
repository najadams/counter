// useCart: in-progress sale lines + payment selection.
// All optimistic locally; we never write until completeSale().

import { create } from 'zustand';
import { vatForSale, VAT_ENABLED, type VatBreakdown } from '@shared/lib/vat';

export type SaleChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
export type PaymentMethod =
  | 'CASH' | 'MOMO_MTN' | 'MOMO_VODAFONE' | 'MOMO_AIRTELTIGO' | 'BANK_TRANSFER' | 'CREDIT';

export interface CartLine {
  productId: string;
  sku: string;
  name: string;
  /** Sellable unit info. unitId = '' for the legacy / synthetic UNIT case. */
  unitId: string | null;
  unitName: string;
  /** Conversion factor to canonical units. 1 for legacy/UNIT. */
  factor: number;
  /** Per-unit base price (channel-driven, before tier). */
  basePricePesewas: number;
  /** Per-unit price after any active tier; = basePricePesewas if no tier. */
  unitPricePesewas: number;
  appliedTierId: string | null;
  /** Tier min_quantity in canonical units (display chip). */
  appliedTierMinQuantity: number | null;
  /** Quantity in the chosen unit (NOT canonical). */
  quantity: number;
  /** Stock on hand in canonical units (for soft-warn at add time). */
  unitsOnHand: number;
}

export interface CartCustomer {
  id: string;
  displayName: string;
  businessName?: string | null;
  phone: string;
  currentBalancePesewas: number;
  cashOnly?: boolean;
  preferredChannel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
}

export interface CartState {
  channel: SaleChannel;
  lines: CartLine[];
  paymentMethod: PaymentMethod | null;
  paymentReference: string;
  cashGivenPesewas: number | null;
  customer: CartCustomer | null;
  discountPesewas: number;
  discountReason: string;
  /** Set when this cart was loaded by accepting a WhatsApp pending order —
   *  SaleScreen reads it after a successful completeSale to write back
   *  fulfilment (pendingOrderMarkFulfilled), then it's cleared. Null for an
   *  ordinary cart or a duplicated-from-past-sale cart. */
  fulfillingOrderId: string | null;
  /** Set when a reviewed paper receipt is opened at the till. SaleScreen uses
   *  it after completeSale succeeds to mark that receipt as POSTED. */
  sourcePaperReceiptId: string | null;

  setChannel: (channel: SaleChannel) => void;
  addLine: (line: Partial<CartLine> & { productId: string; sku: string; name: string; unitPricePesewas: number; unitsOnHand: number; unitId?: string | null; unitName?: string; factor?: number }) => void;
  removeLine: (productId: string, unitId?: string | null) => void;
  setQuantity: (productId: string, quantity: number, unitId?: string | null) => void;
  bumpQuantity: (productId: string, delta: number, unitId?: string | null) => void;
  setPaymentMethod: (m: PaymentMethod | null) => void;
  setPaymentReference: (s: string) => void;
  setCashGivenPesewas: (n: number | null) => void;
  setCustomer: (c: CartCustomer | null) => void;
  setDiscount: (pesewas: number, reason: string) => void;
  applyTier: (productId: string, tier: { id: string; unitPricePesewas: number; minQuantity: number } | null, unitId?: string | null) => void;
  swapUnit: (productId: string, unit: { id: string; unitName: string; conversionFactor: number; pricePesewas: number }, sourceUnitId?: string | null) => void;
  /**
   * Update the per-unit base price of one or more lines in place. Used when
   * the channel changes — each line's price is recomputed by the backend
   * (which applies channel scaling) and pushed back in. Tier discounts get
   * cleared because they were computed against the old channel; the
   * SaleScreen's tier-lookup effect will re-evaluate on the next render.
   */
  repriceLines: (entries: Array<{ productId: string; unitId: string | null; unitPricePesewas: number }>) => void;
  loadLines: (lines: CartLine[], channel?: SaleChannel, customer?: CartCustomer | null) => void;
  setFulfillingOrderId: (orderId: string | null) => void;
  setSourcePaperReceiptId: (draftId: string | null) => void;
  clear: () => void;

  subtotalPesewas: () => number;
  totalPesewas: () => number;
  /** VAT contained in the (inclusive) total — null in the no-VAT build. Display
   *  only; does NOT change totalPesewas. */
  vatBreakdown: () => VatBreakdown | null;
}

// Old single-row callers may omit the unit; till actions always pass it.
function matchesLine(line: CartLine, productId: string, unitId: string | null | undefined): boolean {
  return line.productId === productId && (unitId === undefined || line.unitId === unitId);
}

export const useCart = create<CartState>((set, get) => ({
  channel: 'WALK_IN',
  lines: [],
  paymentMethod: null,
  paymentReference: '',
  cashGivenPesewas: null,
  customer: null,
  discountPesewas: 0,
  discountReason: '',
  fulfillingOrderId: null,
  sourcePaperReceiptId: null,

  setChannel: (channel) => set({ channel }),

  addLine: (line) => set((state) => {
    const existing = state.lines.find((l) => l.productId === line.productId && l.unitId === (line.unitId ?? null));
    if (existing) {
      return {
        lines: state.lines.map((l) =>
          l.productId === line.productId && l.unitId === (line.unitId ?? null)
            ? { ...l, quantity: l.quantity + (line.quantity ?? 1) }
            : l,
        ),
      };
    }
    const fresh: CartLine = {
      productId: line.productId,
      sku: line.sku,
      name: line.name,
      unitId: line.unitId ?? null,
      unitName: line.unitName ?? 'UNIT',
      factor: line.factor ?? 1,
      basePricePesewas: line.basePricePesewas ?? line.unitPricePesewas,
      unitPricePesewas: line.unitPricePesewas,
      appliedTierId: line.appliedTierId ?? null,
      appliedTierMinQuantity: line.appliedTierMinQuantity ?? null,
      quantity: line.quantity ?? 1,
      unitsOnHand: line.unitsOnHand,
    };
    return { lines: [...state.lines, fresh] };
  }),

  removeLine: (productId, unitId) =>
    set((state) => ({ lines: state.lines.filter((l) => !matchesLine(l, productId, unitId)) })),

  setQuantity: (productId, quantity, unitId) =>
    set((state) => ({
      lines: quantity > 0
        ? state.lines.map((l) => matchesLine(l, productId, unitId) ? { ...l, quantity } : l)
        : state.lines.filter((l) => !matchesLine(l, productId, unitId)),
    })),

  bumpQuantity: (productId, delta, unitId) => {
    const current = get().lines.find((l) => matchesLine(l, productId, unitId));
    if (!current) return;
    get().setQuantity(productId, Math.max(0, current.quantity + delta), unitId);
  },

  setPaymentMethod: (paymentMethod) => set({ paymentMethod }),
  setPaymentReference: (paymentReference) => set({ paymentReference }),
  setCashGivenPesewas: (cashGivenPesewas) => set({ cashGivenPesewas }),
  setCustomer: (customer) => set({ customer }),
  setDiscount: (discountPesewas, discountReason) => set({ discountPesewas, discountReason }),

  applyTier: (productId, tier, unitId) => set((state) => ({
    lines: state.lines.map((l) => {
      if (!matchesLine(l, productId, unitId)) return l;
      const tierUnitPrice = tier ? tier.unitPricePesewas * l.factor : null;
      return {
        ...l,
        // Tier wins only if it produces a lower per-unit price than base.
        unitPricePesewas: tierUnitPrice != null && tierUnitPrice < l.basePricePesewas
          ? tierUnitPrice
          : l.basePricePesewas,
        appliedTierId: tierUnitPrice != null && tierUnitPrice < l.basePricePesewas ? tier!.id : null,
        appliedTierMinQuantity: tierUnitPrice != null && tierUnitPrice < l.basePricePesewas ? tier!.minQuantity : null,
      };
    }),
  })),

  repriceLines: (entries) => set((state) => ({
    lines: state.lines.map((l) => {
      const e = entries.find((x) => x.productId === l.productId && (x.unitId ?? null) === (l.unitId ?? null));
      if (!e) return l;
      return {
        ...l,
        basePricePesewas: e.unitPricePesewas,
        unitPricePesewas: e.unitPricePesewas,
        appliedTierId: null,
        appliedTierMinQuantity: null,
      };
    }),
  })),

  swapUnit: (productId, unit, sourceUnitId) => set((state) => {
    const source = state.lines.find((l) => matchesLine(l, productId, sourceUnitId));
    if (!source || source.unitId === unit.id) return {};
    const existing = state.lines.find((l) => l.productId === productId && l.unitId === unit.id);
    const changed: CartLine = {
      ...source, unitId: unit.id, unitName: unit.unitName, factor: unit.conversionFactor,
      basePricePesewas: unit.pricePesewas, unitPricePesewas: unit.pricePesewas,
      appliedTierId: null, appliedTierMinQuantity: null,
      // Switching units starts at one of the chosen unit. Merge if it is already in the cart.
      quantity: (existing?.quantity ?? 0) + 1,
    };
    return { lines: state.lines.flatMap((l) =>
      l === source ? (existing ? [] : [changed]) : l === existing ? [changed] : [l],
    ) };
  }),

  loadLines: (lines, channel, customer) => set((state) => ({
    lines: lines.map((l) => ({ ...l })),
    channel: channel ?? state.channel,
    customer: customer ?? null,
    paymentMethod: null,
    paymentReference: '',
    cashGivenPesewas: null,
    discountPesewas: 0,
    discountReason: '',
    // A fresh load (duplicate-as-new-sale, or a plain cart rebuild) is never
    // itself an accepted WhatsApp order — PendingOrdersScreen sets this
    // explicitly, right after calling loadLines, as a deliberate follow-up.
    fulfillingOrderId: null,
    sourcePaperReceiptId: null,
  })),

  setFulfillingOrderId: (orderId) => set({ fulfillingOrderId: orderId }),
  setSourcePaperReceiptId: (draftId) => set({ sourcePaperReceiptId: draftId }),

  clear: () => set({
    lines: [], paymentMethod: null, paymentReference: '',
    cashGivenPesewas: null, customer: null,
    discountPesewas: 0, discountReason: '', fulfillingOrderId: null, sourcePaperReceiptId: null,
  }),

  subtotalPesewas: () =>
    get().lines.reduce((sum, l) => sum + l.unitPricePesewas * l.quantity, 0),

  totalPesewas: () => Math.max(0, get().subtotalPesewas() - get().discountPesewas),

  vatBreakdown: () => (VAT_ENABLED ? vatForSale(get().totalPesewas()) : null),
}));
