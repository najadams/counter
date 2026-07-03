// Pure pricing/availability/expiry logic for the agent Edge Function.
//
// Deliberately dependency-free (no Supabase client, no I/O) so it can be
// unit-tested directly with `deno test` and reasoned about without a live
// database — same reason src/shared/lib/units.ts on the shop side is pure.
//
// priceForUnit()/priceLine() port src/main/services/productUnits.ts's
// priceForUnit() and sales.ts's per-line resolution to operate on plain
// catalog objects (extracted from shop_events.data) instead of DB queries.
// Keep these two in sync if the shop-side pricing model changes — there is
// no shared package between the Electron app and Edge Functions runtimes, so
// this is a deliberate, commented duplication, not an accident.
//
// Note what's absent: there is no price FLOOR here, unlike completeSaleCore.
// The agent's create-order request never carries a client-supplied price —
// only productId/unitId/quantity — so priceForUnit() IS the price, always.
// The floor problem this mirrors on the till (CLAUDE.md's price-floor work)
// doesn't arise here because nothing untrusted ever proposes a price.

export type SaleChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';
export type OrderStatus = 'QUOTED' | 'CONFIRMED' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED';
export type AvailabilityVerdict = 'IN_STOCK' | 'LOW' | 'UNKNOWN';

export interface CatalogProduct {
  id: string;
  sku: string;
  name: string;
  active: boolean;
  deletedAt: string | null;
  walkInPricePesewas: number;
  wholesalePricePesewas: number;
  routePricePesewas: number;
  reorderThreshold: number;
}

export interface CatalogUnit {
  id: string;
  productId: string;
  unitName: string;
  conversionFactor: number;
  /** The unit's own price_pesewas column — the WALK-IN price for this unit.
   *  Wholesale/route are derived by scaling (see priceForUnit). */
  pricePesewas: number;
  isSaleUnit: boolean;
  active: boolean;
}

export class PricingError extends Error {}

/** Per-unit sale price for (product, unit, channel). Mirrors
 *  productUnits.ts's priceForUnit() exactly: walk-in returns the unit's own
 *  price; other channels scale that price by the product's channel-vs-walk-in
 *  canonical ratio. Rounded half-away-from-zero, never negative. */
export function priceForUnit(
  product: CatalogProduct,
  unit: CatalogUnit | null,
  channel: SaleChannel,
): number {
  const channelCanonical =
    channel === 'WHOLESALE' ? product.wholesalePricePesewas
    : channel === 'ROUTE' ? product.routePricePesewas
    : product.walkInPricePesewas;

  if (!unit) return channelCanonical;             // canonical (no explicit unit)
  if (channel === 'WALK_IN') return unit.pricePesewas;
  if (product.walkInPricePesewas <= 0) return unit.pricePesewas; // avoid div-by-zero
  const scaled = (unit.pricePesewas * channelCanonical) / product.walkInPricePesewas;
  return Math.max(0, Math.round(scaled));
}

export interface PriceLineInput {
  product: CatalogProduct;
  unit: CatalogUnit | null;   // null = canonical unit
  channel: SaleChannel;
  quantity: number;
}

export interface PricedLine {
  unitPricePesewas: number;
  lineTotalPesewas: number;
  quantityCanonical: number;
}

/** Validate + price one order line. Throws PricingError with a message
 *  naming the specific problem — same validation shape as completeSaleCore's
 *  per-line resolution (unit ownership, active flags, sale-unit flag), minus
 *  the DB round-trip. Never trusts a caller-supplied price because there
 *  isn't one — the price always comes from priceForUnit(). */
export function priceLine(input: PriceLineInput): PricedLine {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new PricingError(`quantity must be a positive integer, got ${input.quantity}`);
  }
  if (!input.product.active || input.product.deletedAt) {
    throw new PricingError(`product ${input.product.id} is not active`);
  }
  if (input.unit) {
    if (input.unit.productId !== input.product.id) {
      throw new PricingError(`unit ${input.unit.id} does not belong to product ${input.product.id}`);
    }
    if (!input.unit.active) {
      throw new PricingError(`unit ${input.unit.id} is inactive`);
    }
    if (!input.unit.isSaleUnit) {
      throw new PricingError(`unit '${input.unit.unitName}' is not flagged as a sale unit`);
    }
  }
  const factor = input.unit ? input.unit.conversionFactor : 1;
  const unitPricePesewas = priceForUnit(input.product, input.unit, input.channel);
  return {
    unitPricePesewas,
    lineTotalPesewas: unitPricePesewas * input.quantity,
    quantityCanonical: input.quantity * factor,
  };
}

export interface AvailabilityInput {
  onHandCanonical: number;
  qtyCanonical: number;
  bufferCanonical: number;
  /** shops.last_seen_at for the fulfilling shop, or null if it has never synced. */
  lastSeenAt: string | null;
  now: Date;
  freshWindowMs: number;
}

/** IN_STOCK only when the shop synced recently AND on-hand clears the buffer;
 *  LOW/UNKNOWN both mean "the agent should hand off", per design doc §6 — the
 *  agent promises what the mirror knows and hedges what it doesn't. */
export function availabilityVerdict(input: AvailabilityInput): AvailabilityVerdict {
  const fresh = input.lastSeenAt != null
    && (input.now.getTime() - new Date(input.lastSeenAt).getTime()) < input.freshWindowMs;
  if (!fresh) return 'UNKNOWN';
  return input.onHandCanonical >= input.qtyCanonical + input.bufferCanonical ? 'IN_STOCK' : 'LOW';
}

/** "min 1 [requested-unit]-equivalent" from the design doc §6: a product with
 *  no reorder_threshold configured still gets a sane non-zero buffer, scaled
 *  to whatever unit the customer is asking about (1 crate buffer for a crate
 *  order, 1 bottle buffer for a bottle order). */
export function bufferCanonical(reorderThreshold: number, conversionFactor: number): number {
  return Math.max(reorderThreshold, conversionFactor);
}

/** QUOTED orders past their expiry read as EXPIRED everywhere, without
 *  requiring a write — design doc §A4's "expiry-on-read". A write only
 *  happens when something tries to ACT on an expired order (confirm), which
 *  the caller handles by checking this before mutating. */
export function effectiveStatus(status: OrderStatus, quoteExpiresAt: string, now: Date): OrderStatus {
  if (status === 'QUOTED' && new Date(quoteExpiresAt).getTime() < now.getTime()) return 'EXPIRED';
  return status;
}
