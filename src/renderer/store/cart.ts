// useCart: in-progress sale lines + payment selection.
// All optimistic locally; we never write until completeSale().

import { create } from 'zustand';

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
  phone: string;
  currentBalancePesewas: number;
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

  setChannel: (channel: SaleChannel) => void;
  addLine: (line: Partial<CartLine> & { productId: string; sku: string; name: string; unitPricePesewas: number; unitsOnHand: number; unitId?: string | null; unitName?: string; factor?: number }) => void;
  removeLine: (productId: string) => void;
  setQuantity: (productId: string, quantity: number) => void;
  bumpQuantity: (productId: string, delta: number) => void;
  setPaymentMethod: (m: PaymentMethod | null) => void;
  setPaymentReference: (s: string) => void;
  setCashGivenPesewas: (n: number | null) => void;
  setCustomer: (c: CartCustomer | null) => void;
  setDiscount: (pesewas: number, reason: string) => void;
  applyTier: (productId: string, tier: { id: string; unitPricePesewas: number; minQuantity: number } | null) => void;
  swapUnit: (productId: string, unit: { id: string; unitName: string; conversionFactor: number; pricePesewas: number }) => void;
  loadLines: (lines: CartLine[], channel?: SaleChannel, customer?: CartCustomer | null) => void;
  clear: () => void;

  subtotalPesewas: () => number;
  totalPesewas: () => number;
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

  removeLine: (productId) =>
    set((state) => ({ lines: state.lines.filter((l) => l.productId !== productId) })),

  setQuantity: (productId, quantity) =>
    set((state) => ({
      lines: quantity > 0
        ? state.lines.map((l) => l.productId === productId ? { ...l, quantity } : l)
        : state.lines.filter((l) => l.productId !== productId),
    })),

  bumpQuantity: (productId, delta) => {
    const current = get().lines.find((l) => l.productId === productId);
    if (!current) return;
    get().setQuantity(productId, Math.max(0, current.quantity + delta));
  },

  setPaymentMethod: (paymentMethod) => set({ paymentMethod }),
  setPaymentReference: (paymentReference) => set({ paymentReference }),
  setCashGivenPesewas: (cashGivenPesewas) => set({ cashGivenPesewas }),
  setCustomer: (customer) => set({ customer }),
  setDiscount: (discountPesewas, discountReason) => set({ discountPesewas, discountReason }),

  applyTier: (productId, tier) => set((state) => ({
    lines: state.lines.map((l) => {
      if (l.productId !== productId) return l;
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

  swapUnit: (productId, unit) => set((state) => ({
    lines: state.lines.map((l) =>
      l.productId === productId
        ? {
            ...l,
            unitId: unit.id,
            unitName: unit.unitName,
            factor: unit.conversionFactor,
            basePricePesewas: unit.pricePesewas,
            unitPricePesewas: unit.pricePesewas,        // tier will reapply on next qty change
            appliedTierId: null,
            appliedTierMinQuantity: null,
            // Reset quantity to 1 when swapping units — '5 crates' doesn't translate
            // sensibly to '5 of a smaller/different unit.'
            quantity: 1,
          }
        : l,
    ),
  })),

  loadLines: (lines, channel, customer) => set((state) => ({
    lines: lines.map((l) => ({ ...l })),
    channel: channel ?? state.channel,
    customer: customer ?? null,
    paymentMethod: null,
    paymentReference: '',
    cashGivenPesewas: null,
    discountPesewas: 0,
    discountReason: '',
  })),

  clear: () => set({
    lines: [], paymentMethod: null, paymentReference: '',
    cashGivenPesewas: null, customer: null,
    discountPesewas: 0, discountReason: '',
  }),

  subtotalPesewas: () =>
    get().lines.reduce((sum, l) => sum + l.unitPricePesewas * l.quantity, 0),

  totalPesewas: () => Math.max(0, get().subtotalPesewas() - get().discountPesewas),
}));
