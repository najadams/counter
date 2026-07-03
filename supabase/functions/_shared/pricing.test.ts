// Run with: deno test supabase/functions/_shared/pricing.test.ts

import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  availabilityVerdict, bufferCanonical, effectiveStatus, priceForUnit, priceLine, PricingError,
  type CatalogProduct, type CatalogUnit,
} from "./pricing.ts";

function product(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    id: "p1", sku: "STAR-330", name: "Star Beer 330ml", active: true, deletedAt: null,
    walkInPricePesewas: 800, wholesalePricePesewas: 700, routePricePesewas: 750,
    reorderThreshold: 30,
    ...overrides,
  };
}

function unit(overrides: Partial<CatalogUnit> = {}): CatalogUnit {
  return {
    id: "u1", productId: "p1", unitName: "CRATE", conversionFactor: 24,
    pricePesewas: 18000, isSaleUnit: true, active: true,
    ...overrides,
  };
}

Deno.test("priceForUnit: no unit returns the channel's canonical price", () => {
  assertEquals(priceForUnit(product(), null, "WALK_IN"), 800);
  assertEquals(priceForUnit(product(), null, "WHOLESALE"), 700);
  assertEquals(priceForUnit(product(), null, "ROUTE"), 750);
});

Deno.test("priceForUnit: walk-in returns the unit's own price verbatim", () => {
  assertEquals(priceForUnit(product(), unit(), "WALK_IN"), 18000);
});

Deno.test("priceForUnit: wholesale/route scale by the product's channel ratio", () => {
  // wholesale/walkIn = 700/800 = 0.875; 18000 * 0.875 = 15750
  assertEquals(priceForUnit(product(), unit(), "WHOLESALE"), 15750);
  // route/walkIn = 750/800 = 0.9375; 18000 * 0.9375 = 16875
  assertEquals(priceForUnit(product(), unit(), "ROUTE"), 16875);
});

Deno.test("priceForUnit: avoids div-by-zero on a free walk-in product", () => {
  const p = product({ walkInPricePesewas: 0 });
  assertEquals(priceForUnit(p, unit(), "WHOLESALE"), unit().pricePesewas);
});

Deno.test("priceForUnit: never negative, rounds half-away-from-zero", () => {
  const p = product({ walkInPricePesewas: 800, wholesalePricePesewas: 1 });
  const u = unit({ pricePesewas: 3 }); // 3 * 1 / 800 = 0.00375 -> rounds to 0
  assertEquals(priceForUnit(p, u, "WHOLESALE"), 0);
});

Deno.test("priceLine: canonical (no unit) prices at quantity * channel price", () => {
  const line = priceLine({ product: product(), unit: null, channel: "WALK_IN", quantity: 3 });
  assertEquals(line.unitPricePesewas, 800);
  assertEquals(line.lineTotalPesewas, 2400);
  assertEquals(line.quantityCanonical, 3);
});

Deno.test("priceLine: unit sale scales canonical quantity by conversion factor", () => {
  const line = priceLine({ product: product(), unit: unit(), channel: "WALK_IN", quantity: 2 });
  assertEquals(line.unitPricePesewas, 18000);
  assertEquals(line.lineTotalPesewas, 36000);
  assertEquals(line.quantityCanonical, 48);
});

Deno.test("priceLine: rejects non-positive or fractional quantity", () => {
  assertThrows(() => priceLine({ product: product(), unit: null, channel: "WALK_IN", quantity: 0 }), PricingError);
  assertThrows(() => priceLine({ product: product(), unit: null, channel: "WALK_IN", quantity: -1 }), PricingError);
  assertThrows(() => priceLine({ product: product(), unit: null, channel: "WALK_IN", quantity: 1.5 }), PricingError);
});

Deno.test("priceLine: rejects an inactive or deleted product", () => {
  assertThrows(() => priceLine({ product: product({ active: false }), unit: null, channel: "WALK_IN", quantity: 1 }), PricingError);
  assertThrows(() => priceLine({ product: product({ deletedAt: "2026-01-01" }), unit: null, channel: "WALK_IN", quantity: 1 }), PricingError);
});

Deno.test("priceLine: rejects a unit belonging to a different product", () => {
  assertThrows(
    () => priceLine({ product: product({ id: "p2" }), unit: unit(), channel: "WALK_IN", quantity: 1 }),
    PricingError,
    "does not belong",
  );
});

Deno.test("priceLine: rejects an inactive unit", () => {
  assertThrows(
    () => priceLine({ product: product(), unit: unit({ active: false }), channel: "WALK_IN", quantity: 1 }),
    PricingError,
    "inactive",
  );
});

Deno.test("priceLine: rejects a unit not flagged as a sale unit (purchase-only)", () => {
  assertThrows(
    () => priceLine({ product: product(), unit: unit({ isSaleUnit: false }), channel: "WALK_IN", quantity: 1 }),
    PricingError,
    "not flagged as a sale unit",
  );
});

Deno.test("availabilityVerdict: IN_STOCK when fresh and covered", () => {
  const now = new Date("2026-07-02T12:00:00Z");
  const verdict = availabilityVerdict({
    onHandCanonical: 100, qtyCanonical: 24, bufferCanonical: 30,
    lastSeenAt: "2026-07-02T11:00:00Z", now, freshWindowMs: 2 * 60 * 60 * 1000,
  });
  assertEquals(verdict, "IN_STOCK");
});

Deno.test("availabilityVerdict: LOW when fresh but the buffer isn't cleared", () => {
  const now = new Date("2026-07-02T12:00:00Z");
  const verdict = availabilityVerdict({
    onHandCanonical: 40, qtyCanonical: 24, bufferCanonical: 30, // 24+30=54 > 40
    lastSeenAt: "2026-07-02T11:00:00Z", now, freshWindowMs: 2 * 60 * 60 * 1000,
  });
  assertEquals(verdict, "LOW");
});

Deno.test("availabilityVerdict: UNKNOWN when the shop hasn't synced recently", () => {
  const now = new Date("2026-07-02T12:00:00Z");
  const verdict = availabilityVerdict({
    onHandCanonical: 1000, qtyCanonical: 1, bufferCanonical: 0,
    lastSeenAt: "2026-07-02T08:00:00Z", // 4h ago, past the 2h window
    now, freshWindowMs: 2 * 60 * 60 * 1000,
  });
  assertEquals(verdict, "UNKNOWN");
});

Deno.test("availabilityVerdict: UNKNOWN when the shop has never synced", () => {
  const now = new Date("2026-07-02T12:00:00Z");
  const verdict = availabilityVerdict({
    onHandCanonical: 1000, qtyCanonical: 1, bufferCanonical: 0,
    lastSeenAt: null, now, freshWindowMs: 2 * 60 * 60 * 1000,
  });
  assertEquals(verdict, "UNKNOWN");
});

Deno.test("bufferCanonical: at least one full unit even with no reorder threshold set", () => {
  assertEquals(bufferCanonical(0, 24), 24);
  assertEquals(bufferCanonical(50, 24), 50);
  assertEquals(bufferCanonical(0, 1), 1);
});

Deno.test("effectiveStatus: QUOTED past expiry reads as EXPIRED without a write", () => {
  const now = new Date("2026-07-02T12:00:00Z");
  assertEquals(effectiveStatus("QUOTED", "2026-07-01T00:00:00Z", now), "EXPIRED");
  assertEquals(effectiveStatus("QUOTED", "2026-07-03T00:00:00Z", now), "QUOTED");
});

Deno.test("effectiveStatus: non-QUOTED statuses are never reinterpreted by expiry", () => {
  const now = new Date("2026-07-02T12:00:00Z");
  assertEquals(effectiveStatus("CONFIRMED", "2026-01-01T00:00:00Z", now), "CONFIRMED");
  assertEquals(effectiveStatus("FULFILLED", "2026-01-01T00:00:00Z", now), "FULFILLED");
  assertEquals(effectiveStatus("CANCELLED", "2026-01-01T00:00:00Z", now), "CANCELLED");
});
