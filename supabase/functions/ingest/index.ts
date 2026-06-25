// POST /functions/v1/ingest — receive a shop's PushBatch, store it, ack.
//
// Wire contract (src/shared/sync.ts): body is
//   { shopId, rows: [{ seq, table, op, data }] }
// reply is { ackedSeq }. The shop marks its outbox acked up to ackedSeq, so we
// MUST only ack what we durably stored. Idempotent: upsert on
// (shop_id, table_name, row_id), so a re-sent batch is a no-op.
//
// Deploy with verify_jwt=false (we authenticate the per-shop token in-body).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticate, jsonResponse } from "../_shared/auth.ts";

interface PushRow { seq: number; table: string; op: string; data: Record<string, unknown>; }

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const shop = await authenticate(req, supabase);
  if (!shop) return jsonResponse({ error: "unauthorized" }, 401);

  let batch: { shopId?: string; rows?: PushRow[] };
  try {
    batch = await req.json();
  } catch {
    return jsonResponse({ error: "malformed json" }, 400);
  }

  // The token's shop must match the batch's claimed shopId — a token can only
  // ever write its own shop's data.
  if (batch.shopId !== shop.shop_id || !Array.isArray(batch.rows)) {
    return jsonResponse({ error: "shop mismatch or malformed batch" }, 403);
  }
  if (batch.rows.length === 0) return jsonResponse({ ackedSeq: shop.last_acked_seq });

  const records = [];
  for (const r of batch.rows) {
    const id = r?.data?.id;
    if (id == null || typeof r.seq !== "number" || typeof r.table !== "string"
      || (r.op !== "INSERT" && r.op !== "UPDATE")) {
      return jsonResponse({ error: "malformed row" }, 400);
    }
    records.push({
      shop_id: shop.shop_id,
      table_name: r.table,
      row_id: String(id),
      seq: r.seq,
      op: r.op,
      data: r.data,
    });
  }

  const { error } = await supabase
    .from("shop_events")
    .upsert(records, { onConflict: "shop_id,table_name,row_id" });
  if (error) return jsonResponse({ error: error.message }, 500);

  // High-water ack: never regress if an older batch is re-sent.
  const batchMax = records.reduce((m, x) => (x.seq > m ? x.seq : m), 0);
  const ackedSeq = Math.max(batchMax, shop.last_acked_seq);
  await supabase
    .from("shops")
    .update({ last_acked_seq: ackedSeq, last_seen_at: new Date().toISOString() })
    .eq("shop_id", shop.shop_id);

  return jsonResponse({ ackedSeq });
});
