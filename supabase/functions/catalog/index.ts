// GET /functions/v1/catalog?since=<n>&limit=<n> — catalog distribution (DOWN).
//
// Wire contract (src/shared/sync.ts): reply is
//   { rows: [{ cursor, table, data }], cursor }
//
// PUSH-ONLY FIRST SLICE: catalog-down (HQ master tables -> shops) is NOT
// implemented yet. We return an empty page so the shop's pull worker no-ops and
// safely persists its cursor. Implementing this is the next slice: serve the
// HQ-owned SYNCED_MASTER_TABLES (products, product_units, pricing_tiers,
// promotions, suppliers, workers) from an HQ-role shop's ingested rows, ordered
// by a central monotonic cursor.

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

  const since = Number(new URL(req.url).searchParams.get("since") ?? "0");
  return jsonResponse({ rows: [], cursor: Number.isFinite(since) ? since : 0 });
});
