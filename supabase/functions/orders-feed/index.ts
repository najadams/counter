// GET /functions/v1/orders-feed?since=<n>&limit=<n> — WhatsApp orders DOWN to
// the fulfilling shop (Phase 4 workstream A5/C2).
//
// Wire contract (matches src/shared/sync.ts PullResponse exactly, so the
// pull worker built in workstream C reuses the same apply/cursor machinery
// pull.ts already has for catalog): reply is
//   { rows: [{ cursor, data }], cursor }
// The shop pages with since=cursor until empty, same as fetchCatalog.
//
// Shop-token authenticated (the EXISTING authenticate(), not authenticateAgent)
// — an order becomes this shop's business the moment it's CONFIRMED, and only
// the shop itself (not the agent) should be reading its own fulfilment queue.
// Only CONFIRMED orders are ever returned: QUOTED orders aren't this shop's
// concern yet, and confirm_order() is the only thing that assigns `seq`, so a
// QUOTED order has no cursor position and can never appear here regardless.
//
// Deploy with verify_jwt=false (auth is the per-shop token, checked in-body).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticate, jsonResponse } from "../_shared/auth.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const shop = await authenticate(req, supabase);
  if (!shop) return jsonResponse({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const sinceRaw = Number(url.searchParams.get("since") ?? "0");
  const since = Number.isFinite(sinceRaw) ? sinceRaw : 0;
  const limitRaw = Number(url.searchParams.get("limit") ?? "200");
  const limit = Math.min(Number.isFinite(limitRaw) ? limitRaw : 200, 500);

  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, seq, status, customer_phone, customer_name, channel, subtotal_pesewas, total_pesewas, quote_expires_at, confirmed_at, created_by_agent, created_at")
    .eq("company_id", shop.company_id)
    .eq("shop_id", shop.shop_id)
    .eq("status", "CONFIRMED")
    .gt("seq", since)
    .order("seq", { ascending: true })
    .limit(limit);
  if (error) return jsonResponse({ error: error.message }, 500);
  if (!orders || orders.length === 0) return jsonResponse({ rows: [], cursor: since });

  // One extra query for all lines of this page's orders, batched rather than
  // N+1 — order counts per page are small (<=limit), lines per order smaller
  // still, so one IN-query comfortably covers a page.
  const orderIds = orders.map((o) => o.id);
  const { data: lines, error: linesError } = await supabase
    .from("order_lines")
    .select("order_id, product_id, unit_id, quantity, unit_price_pesewas, line_total_pesewas")
    .in("order_id", orderIds);
  if (linesError) return jsonResponse({ error: linesError.message }, 500);

  const linesByOrder = new Map<string, typeof lines>();
  for (const line of lines ?? []) {
    const arr = linesByOrder.get(line.order_id) ?? [];
    arr.push(line);
    linesByOrder.set(line.order_id, arr);
  }

  const rows = orders.map((o) => ({
    cursor: o.seq as number,
    data: {
      id: o.id,
      status: o.status,
      customer_phone: o.customer_phone,
      customer_name: o.customer_name,
      channel: o.channel,
      subtotal_pesewas: o.subtotal_pesewas,
      total_pesewas: o.total_pesewas,
      quote_expires_at: o.quote_expires_at,
      confirmed_at: o.confirmed_at,
      created_by_agent: o.created_by_agent,
      created_at: o.created_at,
      lines: (linesByOrder.get(o.id) ?? []).map((l) => ({
        product_id: l.product_id, unit_id: l.unit_id,
        quantity: l.quantity, unit_price_pesewas: l.unit_price_pesewas, line_total_pesewas: l.line_total_pesewas,
      })),
    },
  }));
  const cursor = rows[rows.length - 1]!.cursor;

  return jsonResponse({ rows, cursor });
});
