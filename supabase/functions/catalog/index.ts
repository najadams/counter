// GET /functions/v1/catalog?since=<n>&limit=<n> — catalog distribution (DOWN).
//
// Wire contract (src/shared/sync.ts): reply is
//   { rows: [{ cursor, table, data }], cursor }
// The shop applies rows by upsert-on-id and pages with since=cursor until empty
// (src/main/sync/pull.ts).
//
// The HQ shop (shops.role = 'HQ') is the single source of master/catalog data:
// HQ captures its master tables into its outbox (migration 0033) and pushes them
// UP through /ingest like any event, landing in shop_events keyed by
// (HQ shop_id, table_name, row_id) — upsert, so the latest version wins. Here we
// serve those master rows DOWN to any authenticated shop, ordered by the HQ
// outbox seq used as the central cursor.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticate, jsonResponse } from "../_shared/auth.ts";

// Mirrors SYNCED_MASTER_TABLES in src/shared/sync.ts.
const MASTER_TABLES = [
  "products", "product_units", "pricing_tiers", "promotions", "suppliers", "workers",
];

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
  const limitRaw = Number(url.searchParams.get("limit") ?? "500");
  const limit = Math.min(Number.isFinite(limitRaw) ? limitRaw : 500, 1000);

  // The HQ shop is the source of catalog data. No HQ provisioned yet → nothing
  // to serve; the shop's pull worker no-ops and keeps its cursor.
  const { data: hq, error: hqErr } = await supabase
    .from("shops").select("shop_id").eq("role", "HQ").limit(1).maybeSingle();
  if (hqErr) return jsonResponse({ error: hqErr.message }, 500);
  if (!hq) return jsonResponse({ rows: [], cursor: since });

  const { data: rows, error } = await supabase
    .from("shop_events")
    .select("seq, table_name, data")
    .eq("shop_id", hq.shop_id)
    .in("table_name", MASTER_TABLES)
    .gt("seq", since)
    .order("seq", { ascending: true })
    .limit(limit);
  if (error) return jsonResponse({ error: error.message }, 500);

  const out = (rows ?? []).map((r) => ({ cursor: r.seq, table: r.table_name, data: r.data }));
  const cursor = out.length > 0 ? out[out.length - 1].cursor : since;
  return jsonResponse({ rows: out, cursor });
});
