// /functions/v1/agent/v1/... — the WhatsApp order agent's read/write surface.
//
// Agent-bearer-token authenticated (see _shared/auth.ts authenticateAgent),
// distinct from both the per-shop token (ingest/catalog/add-shop) and the
// admin secret (bootstrap-company/register-agent). A token resolves to
// company_id server-side; the caller never asserts it, same discipline as
// every other caller of this store.
//
// Grouped as ONE function with internal path routing (unlike ingest/catalog/
// add-shop, which are each a single route) because every route here shares
// the same auth check and the same HQ-catalog load — splitting them into five
// functions would mean five cold starts and five copies of that boilerplate
// for no isolation benefit (they're all the same trust boundary). Routes:
//
//   GET  /agent/v1/catalog?q=&channel=&limit=
//   GET  /agent/v1/availability?shopId=&productId=&unitId=&qty=
//   POST /agent/v1/orders
//   GET  /agent/v1/orders/:id
//   POST /agent/v1/orders/:id/confirm
//   POST /agent/v1/orders/:id/cancel
//
// Deploy with verify_jwt=false (auth is the agent bearer token, checked here).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { type Agent, authenticateAgent, hasScope, jsonResponse } from "../_shared/auth.ts";
import { findHqShopId, loadHqCatalog, searchCatalog } from "../_shared/catalog.ts";
import {
  availabilityVerdict, bufferCanonical, effectiveStatus, priceLine, PricingError, type SaleChannel,
} from "../_shared/pricing.ts";
import { validateCreateOrderRequest } from "../_shared/orderRequest.ts";

// --- Config (env-overridable so a pilot can tune without a redeploy) -------
const FRESH_WINDOW_MS = Number(Deno.env.get("AGENT_FRESH_WINDOW_MINUTES") ?? "120") * 60_000;
const QUOTE_VALIDITY_MS = Number(Deno.env.get("AGENT_QUOTE_VALIDITY_HOURS") ?? "48") * 3_600_000;
const MAX_LINES = Number(Deno.env.get("AGENT_MAX_LINES") ?? "20");
const MAX_LINE_QTY = Number(Deno.env.get("AGENT_MAX_LINE_QTY") ?? "500");
const MAX_ORDERS_PER_MINUTE = Number(Deno.env.get("AGENT_MAX_ORDERS_PER_MINUTE") ?? "30");
const CATALOG_SEARCH_LIMIT = 20;

Deno.serve(async (req: Request) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const agent = await authenticateAgent(req, supabase);
  if (!agent) return jsonResponse({ error: "unauthorized" }, 401);

  // Best-effort liveness stamp — not on the hot path's correctness, so we
  // don't await-block the response on it failing.
  void supabase.from("agents")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("company_id", agent.company_id).eq("agent_id", agent.agent_id);

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const fnIndex = segments.indexOf("agent");
  const route = fnIndex >= 0 ? segments.slice(fnIndex + 1) : segments; // e.g. ["v1","orders",":id","confirm"]

  try {
    if (route[0] !== "v1") return jsonResponse({ error: "not found" }, 404);

    if (req.method === "GET" && route[1] === "catalog") {
      return await handleCatalog(req, supabase, agent, url);
    }
    if (req.method === "GET" && route[1] === "availability") {
      return await handleAvailability(req, supabase, agent, url);
    }
    if (req.method === "POST" && route[1] === "orders" && route.length === 2) {
      return await handleCreateOrder(req, supabase, agent);
    }
    if (req.method === "GET" && route[1] === "orders" && route.length === 3) {
      return await handleGetOrder(supabase, agent, route[2]!);
    }
    if (req.method === "POST" && route[1] === "orders" && route.length === 4 && route[3] === "confirm") {
      return await handleConfirmOrder(supabase, agent, route[2]!);
    }
    if (req.method === "POST" && route[1] === "orders" && route.length === 4 && route[3] === "cancel") {
      return await handleCancelOrder(supabase, agent, route[2]!);
    }
    return jsonResponse({ error: "not found" }, 404);
  } catch (err) {
    // Any unexpected throw becomes a clean 500 instead of a raw stack trace —
    // catalog/pricing errors that ARE expected (PricingError) are caught and
    // turned into 400s inside their own handlers, before they reach here.
    return jsonResponse({ error: err instanceof Error ? err.message : "internal error" }, 500);
  }
});

// --- GET /v1/catalog ---------------------------------------------------

async function handleCatalog(
  req: Request, supabase: SupabaseClient, agent: Agent, url: URL,
): Promise<Response> {
  if (!hasScope(agent, "catalog:read")) return jsonResponse({ error: "agent token lacks catalog:read scope" }, 403);

  const hqShopId = await findHqShopId(supabase, agent.company_id);
  if (!hqShopId) return jsonResponse({ products: [] }); // no HQ provisioned yet — nothing to serve

  const catalog = await loadHqCatalog(supabase, agent.company_id, hqShopId);
  const q = url.searchParams.get("q") ?? "";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? String(CATALOG_SEARCH_LIMIT)) || CATALOG_SEARCH_LIMIT, 50);
  const channelParam = url.searchParams.get("channel") ?? "WALK_IN";
  const channel: SaleChannel = channelParam === "WHOLESALE" || channelParam === "ROUTE" ? channelParam : "WALK_IN";

  const results = searchCatalog(catalog, q, limit);
  const products = results.map((r) => {
    const product = catalog.productsById.get(r.productId)!;
    return {
      productId: r.productId,
      sku: r.sku,
      name: r.name,
      units: r.units.map((u) => {
        const unit = u.unitId ? catalog.unitsById.get(u.unitId)! : null;
        return {
          unitId: u.unitId,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          unitPricePesewas: priceLine({ product, unit, channel, quantity: 1 }).unitPricePesewas,
        };
      }),
    };
  });

  void req; // method/route already validated by the caller
  return jsonResponse({ channel, products });
}

// --- GET /v1/availability -----------------------------------------------

async function handleAvailability(
  req: Request, supabase: SupabaseClient, agent: Agent, url: URL,
): Promise<Response> {
  if (!hasScope(agent, "stock:read")) return jsonResponse({ error: "agent token lacks stock:read scope" }, 403);
  void req;

  const shopId = url.searchParams.get("shopId") ?? "";
  const productId = url.searchParams.get("productId") ?? "";
  const unitId = url.searchParams.get("unitId");
  const qty = Number(url.searchParams.get("qty") ?? "1");
  if (!shopId || !productId || !Number.isInteger(qty) || qty <= 0) {
    return jsonResponse({ error: "shopId, productId, and a positive integer qty are required" }, 400);
  }

  const shopOk = await shopBelongsToCompany(supabase, agent.company_id, shopId);
  if (!shopOk) return jsonResponse({ error: `shop ${shopId} not found for this company` }, 404);

  const hqShopId = await findHqShopId(supabase, agent.company_id);
  if (!hqShopId) return jsonResponse({ error: "no catalog available for this company yet" }, 404);
  const catalog = await loadHqCatalog(supabase, agent.company_id, hqShopId);

  const product = catalog.productsById.get(productId);
  if (!product) return jsonResponse({ error: `product ${productId} not found` }, 404);
  const unit = unitId ? catalog.unitsById.get(unitId) ?? null : null;
  if (unitId && !unit) return jsonResponse({ error: `unit ${unitId} not found` }, 404);

  let priced;
  try {
    priced = priceLine({ product, unit, channel: "WALK_IN", quantity: qty });
  } catch (err) {
    if (err instanceof PricingError) return jsonResponse({ error: err.message }, 400);
    throw err;
  }

  const [{ data: onHandRow }, { data: shopRow }] = await Promise.all([
    supabase.from("central_stock_on_hand").select("on_hand")
      .eq("company_id", agent.company_id).eq("shop_id", shopId).eq("product_id", productId).maybeSingle(),
    supabase.from("shops").select("last_seen_at")
      .eq("company_id", agent.company_id).eq("shop_id", shopId).maybeSingle(),
  ]);

  const onHandCanonical = Number(onHandRow?.on_hand ?? 0);
  const buffer = bufferCanonical(product.reorderThreshold, unit?.conversionFactor ?? 1);
  const verdict = availabilityVerdict({
    onHandCanonical,
    qtyCanonical: priced.quantityCanonical,
    bufferCanonical: buffer,
    lastSeenAt: shopRow?.last_seen_at ?? null,
    now: new Date(),
    freshWindowMs: FRESH_WINDOW_MS,
  });

  return jsonResponse({
    productId, unitId: unit?.id ?? null, quantity: qty,
    verdict, onHandCanonical,
    freshAsOf: shopRow?.last_seen_at ?? null,
  });
}

// --- POST /v1/orders -------------------------------------------------------

async function handleCreateOrder(req: Request, supabase: SupabaseClient, agent: Agent): Promise<Response> {
  if (!hasScope(agent, "orders:write")) return jsonResponse({ error: "agent token lacks orders:write scope" }, 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "malformed json" }, 400);
  }

  const validated = validateCreateOrderRequest(
    body as Record<string, unknown>,
    { maxLines: MAX_LINES, maxLineQuantity: MAX_LINE_QTY },
  );
  if (!validated.ok) return jsonResponse({ error: validated.error }, 400);
  const input = validated.value;

  // Rate limit: a DB-backed count survives across cold starts, unlike an
  // in-memory counter, and this store already tracks created_at per order.
  const windowStart = new Date(Date.now() - 60_000).toISOString();
  const { count } = await supabase.from("orders")
    .select("id", { count: "exact", head: true })
    .eq("company_id", agent.company_id).eq("created_by_agent", agent.agent_id)
    .gte("created_at", windowStart);
  if ((count ?? 0) >= MAX_ORDERS_PER_MINUTE) {
    return jsonResponse({ error: "rate limit exceeded — slow down and retry shortly" }, 429);
  }

  const shopOk = await shopBelongsToCompany(supabase, agent.company_id, input.shopId);
  if (!shopOk) return jsonResponse({ error: `shop ${input.shopId} not found for this company` }, 404);

  const hqShopId = await findHqShopId(supabase, agent.company_id);
  if (!hqShopId) return jsonResponse({ error: "no catalog available for this company yet" }, 404);
  const catalog = await loadHqCatalog(supabase, agent.company_id, hqShopId);

  const pricedLines: Array<{
    product_id: string; unit_id: string | null; quantity: number;
    unit_price_pesewas: number; line_total_pesewas: number;
  }> = [];
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i]!;
    const product = catalog.productsById.get(line.productId);
    if (!product) return jsonResponse({ error: `lines[${i}]: product ${line.productId} not found` }, 400);
    const unit = line.unitId ? catalog.unitsById.get(line.unitId) ?? null : null;
    if (line.unitId && !unit) return jsonResponse({ error: `lines[${i}]: unit ${line.unitId} not found` }, 400);

    let priced;
    try {
      priced = priceLine({ product, unit, channel: input.channel, quantity: line.quantity });
    } catch (err) {
      if (err instanceof PricingError) return jsonResponse({ error: `lines[${i}]: ${err.message}` }, 400);
      throw err;
    }
    pricedLines.push({
      product_id: line.productId, unit_id: line.unitId,
      quantity: line.quantity,
      unit_price_pesewas: priced.unitPricePesewas,
      line_total_pesewas: priced.lineTotalPesewas,
    });
  }

  const quoteExpiresAt = new Date(Date.now() + QUOTE_VALIDITY_MS).toISOString();
  const { data: orderId, error } = await supabase.rpc("create_order", {
    p_company_id: agent.company_id,
    p_shop_id: input.shopId,
    p_customer_phone: input.customerPhone,
    p_customer_name: input.customerName,
    p_channel: input.channel,
    p_created_by_agent: agent.agent_id,
    p_quote_expires_at: quoteExpiresAt,
    p_lines: pricedLines,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) return jsonResponse({ error: error.message }, 500);

  return await handleGetOrder(supabase, agent, orderId as string, 201);
}

// --- GET /v1/orders/:id ------------------------------------------------

async function handleGetOrder(
  supabase: SupabaseClient, agent: Agent, orderId: string, status = 200,
): Promise<Response> {
  const order = await loadOrderForAgent(supabase, agent, orderId);
  if (!order) return jsonResponse({ error: `order ${orderId} not found` }, 404);
  return jsonResponse(order, status);
}

// --- POST /v1/orders/:id/confirm ----------------------------------------

async function handleConfirmOrder(supabase: SupabaseClient, agent: Agent, orderId: string): Promise<Response> {
  if (!hasScope(agent, "orders:write")) return jsonResponse({ error: "agent token lacks orders:write scope" }, 403);

  // Atomic in SQL (confirm_order locks the row) — a check-then-update here in
  // TS would race two concurrent confirm calls for the same order, and the
  // seq assignment that makes the order visible to orders-feed must happen
  // exactly once, under the same lock as the status transition.
  const { data: result, error } = await supabase.rpc("confirm_order", {
    p_company_id: agent.company_id, p_order_id: orderId,
  });
  if (error) return jsonResponse({ error: error.message }, 500);
  if (result === "NOT_FOUND") return jsonResponse({ error: `order ${orderId} not found` }, 404);
  if (result !== "CONFIRMED") return jsonResponse({ error: `order is ${result}, cannot confirm` }, 409);

  return await handleGetOrder(supabase, agent, orderId);
}

// --- POST /v1/orders/:id/cancel -----------------------------------------

async function handleCancelOrder(supabase: SupabaseClient, agent: Agent, orderId: string): Promise<Response> {
  if (!hasScope(agent, "orders:write")) return jsonResponse({ error: "agent token lacks orders:write scope" }, 403);

  const { data: row, error } = await supabase.from("orders")
    .select("id, status")
    .eq("company_id", agent.company_id).eq("id", orderId).maybeSingle();
  if (error || !row) return jsonResponse({ error: `order ${orderId} not found` }, 404);
  if (row.status === "FULFILLED" || row.status === "CANCELLED") {
    return jsonResponse({ error: `order is ${row.status}, cannot cancel` }, 409);
  }

  // Optimistic concurrency: only cancel from the status we just read. If a
  // concurrent confirm won the race in between, this WHERE matches zero rows
  // instead of silently cancelling an order the customer already confirmed.
  const { data: updated, error: updateErr } = await supabase.from("orders")
    .update({ status: "CANCELLED", updated_at: new Date().toISOString() })
    .eq("company_id", agent.company_id).eq("id", orderId).eq("status", row.status)
    .select("id");
  if (updateErr) return jsonResponse({ error: updateErr.message }, 500);
  if (!updated || updated.length === 0) {
    return jsonResponse({ error: "order changed concurrently — reload and retry" }, 409);
  }

  return await handleGetOrder(supabase, agent, orderId);
}

// --- shared helpers ----------------------------------------------------

async function shopBelongsToCompany(supabase: SupabaseClient, companyId: string, shopId: string): Promise<boolean> {
  const { data } = await supabase.from("shops").select("shop_id")
    .eq("company_id", companyId).eq("shop_id", shopId).maybeSingle();
  return !!data;
}

async function loadOrderForAgent(
  supabase: SupabaseClient, agent: Agent, orderId: string,
): Promise<Record<string, unknown> | null> {
  const { data: order } = await supabase.from("orders")
    .select("id, shop_id, status, customer_phone, customer_name, channel, subtotal_pesewas, total_pesewas, quote_expires_at, confirmed_at, fulfilled_at, fulfilled_sale_id, created_at")
    .eq("company_id", agent.company_id).eq("id", orderId).maybeSingle();
  if (!order) return null;

  const { data: lines } = await supabase.from("order_lines")
    .select("product_id, unit_id, quantity, unit_price_pesewas, line_total_pesewas")
    .eq("order_id", orderId);

  return {
    ...order,
    status: effectiveStatus(order.status, order.quote_expires_at, new Date()),
    lines: lines ?? [],
  };
}
