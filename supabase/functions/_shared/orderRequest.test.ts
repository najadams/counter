// Run with: deno test supabase/functions/_shared/orderRequest.test.ts

import { assert, assertEquals } from "jsr:@std/assert";
import { validateCreateOrderRequest, type CreateOrderRequestInput } from "./orderRequest.ts";

const LIMITS = { maxLines: 20, maxLineQuantity: 500 };

function baseBody(overrides: Partial<CreateOrderRequestInput> = {}): CreateOrderRequestInput {
  return {
    shopId: "OSU",
    customerPhone: "+233555000000",
    lines: [{ productId: "p1", quantity: 2 }],
    ...overrides,
  };
}

Deno.test("accepts a well-formed request and normalizes optional fields", () => {
  const r = validateCreateOrderRequest(baseBody(), LIMITS);
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value.shopId, "OSU");
    assertEquals(r.value.customerPhone, "+233555000000");
    assertEquals(r.value.channel, "WALK_IN"); // default
    assertEquals(r.value.customerName, null);
    assertEquals(r.value.idempotencyKey, null);
    assertEquals(r.value.lines, [{ productId: "p1", unitId: null, quantity: 2 }]);
  }
});

Deno.test("strips separators from a phone number before validating", () => {
  const r = validateCreateOrderRequest(baseBody({ customerPhone: "+233 555-000-000" }), LIMITS);
  assert(r.ok);
  if (r.ok) assertEquals(r.value.customerPhone, "+233555000000");
});

Deno.test("rejects a missing shopId", () => {
  const r = validateCreateOrderRequest(baseBody({ shopId: "" }), LIMITS);
  assert(!r.ok);
  if (!r.ok) assertEquals(r.error, "shopId is required");
});

Deno.test("rejects a malformed phone number", () => {
  const r = validateCreateOrderRequest(baseBody({ customerPhone: "not-a-phone" }), LIMITS);
  assert(!r.ok);
});

Deno.test("rejects an invalid channel", () => {
  const r = validateCreateOrderRequest(baseBody({ channel: "RETAIL" }), LIMITS);
  assert(!r.ok);
  if (!r.ok) assert(r.error.includes("channel"));
});

Deno.test("rejects an empty lines array", () => {
  const r = validateCreateOrderRequest(baseBody({ lines: [] }), LIMITS);
  assert(!r.ok);
});

Deno.test("rejects more lines than the cap", () => {
  const lines = Array.from({ length: 21 }, (_, i) => ({ productId: `p${i}`, quantity: 1 }));
  const r = validateCreateOrderRequest(baseBody({ lines }), LIMITS);
  assert(!r.ok);
  if (!r.ok) assert(r.error.includes("at most 20"));
});

Deno.test("rejects a line with a non-positive or fractional quantity", () => {
  assert(!validateCreateOrderRequest(baseBody({ lines: [{ productId: "p1", quantity: 0 }] }), LIMITS).ok);
  assert(!validateCreateOrderRequest(baseBody({ lines: [{ productId: "p1", quantity: -3 }] }), LIMITS).ok);
  assert(!validateCreateOrderRequest(baseBody({ lines: [{ productId: "p1", quantity: 1.5 }] }), LIMITS).ok);
});

Deno.test("rejects a line quantity over the per-line cap", () => {
  const r = validateCreateOrderRequest(baseBody({ lines: [{ productId: "p1", quantity: 501 }] }), LIMITS);
  assert(!r.ok);
  if (!r.ok) assert(r.error.includes("exceeds the maximum"));
});

Deno.test("rejects a line with a missing productId", () => {
  const r = validateCreateOrderRequest(baseBody({ lines: [{ productId: "", quantity: 1 }] }), LIMITS);
  assert(!r.ok);
});

Deno.test("passes through an explicit unitId and idempotencyKey", () => {
  const r = validateCreateOrderRequest(
    baseBody({ lines: [{ productId: "p1", unitId: "u1", quantity: 2 }], idempotencyKey: "wa-msg-123" }),
    LIMITS,
  );
  assert(r.ok);
  if (r.ok) {
    assertEquals(r.value.lines[0]?.unitId, "u1");
    assertEquals(r.value.idempotencyKey, "wa-msg-123");
  }
});
