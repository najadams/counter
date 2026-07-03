// Pure validation for POST /agent/v1/orders request bodies. Dependency-free,
// same reasoning as pricing.ts: the shape of "is this request well-formed"
// shouldn't need a live database to test.
//
// Note what's NOT validated here: whether productId/unitId actually exist in
// the catalog, and whether shopId belongs to this agent's company. Those
// require a DB round-trip and are checked by the handler after this passes —
// this module only rejects malformed input, cheaply, before any I/O happens.

export interface CreateOrderLineInput {
  productId?: string;
  unitId?: string | null;
  quantity?: number;
}

export interface CreateOrderRequestInput {
  shopId?: string;
  customerPhone?: string;
  customerName?: string | null;
  channel?: string;
  lines?: CreateOrderLineInput[];
  idempotencyKey?: string | null;
}

export interface ValidatedCreateOrderRequest {
  shopId: string;
  customerPhone: string;
  customerName: string | null;
  channel: "WALK_IN" | "WHOLESALE" | "ROUTE";
  lines: Array<{ productId: string; unitId: string | null; quantity: number }>;
  idempotencyKey: string | null;
}

export interface OrderRequestLimits {
  maxLines: number;
  maxLineQuantity: number;
}

export type ValidationResult =
  | { ok: true; value: ValidatedCreateOrderRequest }
  | { ok: false; error: string };

// Loose E.164-ish check: optional leading +, 7-15 digits, no leading zero.
// Deliberately not a strict E.164 validator — phone formats vary enough
// internationally that "obviously malformed" is the right bar here, not
// "provably valid"; the real check is whether WhatsApp itself accepted the
// number as a chat identity, which happens upstream of this call.
const PHONE_RE = /^\+?[1-9]\d{6,14}$/;

export function validateCreateOrderRequest(
  body: CreateOrderRequestInput,
  limits: OrderRequestLimits,
): ValidationResult {
  const shopId = (body.shopId ?? "").trim();
  if (!shopId) return { ok: false, error: "shopId is required" };

  const normalizedPhone = (body.customerPhone ?? "").trim().replace(/[\s\-()]/g, "");
  if (!PHONE_RE.test(normalizedPhone)) {
    return { ok: false, error: "customerPhone must be a valid phone number, e.g. +233555000000" };
  }

  const channel = body.channel ?? "WALK_IN";
  if (channel !== "WALK_IN" && channel !== "WHOLESALE" && channel !== "ROUTE") {
    return { ok: false, error: `channel must be WALK_IN, WHOLESALE, or ROUTE, got '${channel}'` };
  }

  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    return { ok: false, error: "lines: at least one line is required" };
  }
  if (body.lines.length > limits.maxLines) {
    return { ok: false, error: `lines: at most ${limits.maxLines} lines per order (got ${body.lines.length})` };
  }

  const lines: ValidatedCreateOrderRequest["lines"] = [];
  for (let i = 0; i < body.lines.length; i++) {
    const l = body.lines[i] ?? {};
    const productId = (l.productId ?? "").trim();
    if (!productId) return { ok: false, error: `lines[${i}]: productId is required` };
    if (!Number.isInteger(l.quantity) || (l.quantity as number) <= 0) {
      return { ok: false, error: `lines[${i}]: quantity must be a positive integer` };
    }
    if ((l.quantity as number) > limits.maxLineQuantity) {
      return { ok: false, error: `lines[${i}]: quantity exceeds the maximum of ${limits.maxLineQuantity}` };
    }
    lines.push({ productId, unitId: l.unitId ?? null, quantity: l.quantity as number });
  }

  return {
    ok: true,
    value: {
      shopId,
      customerPhone: normalizedPhone,
      customerName: (body.customerName ?? "").trim() || null,
      channel,
      lines,
      idempotencyKey: (body.idempotencyKey ?? "").trim() || null,
    },
  };
}
