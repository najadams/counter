// Shared auth for the central sync Edge Functions.
//
// The shop authenticates with a per-shop bearer token (NOT a Supabase JWT), so
// the functions are deployed with verify_jwt=false and do this check themselves.
// We store only sha256(token) in shops.token_hash, so a DB leak never exposes a
// usable token. Looking the shop up BY the hash also tells us which shop the
// token belongs to, which we then cross-check against the batch's shopId.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface Shop {
  shop_id: string;
  role: string;
  last_acked_seq: number;
}

/** Returns the authenticated shop, or null. Null → caller responds 401. */
export async function authenticate(req: Request, supabase: SupabaseClient): Promise<Shop | null> {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const hash = await sha256Hex(match[1].trim());
  const { data, error } = await supabase
    .from("shops")
    .select("shop_id, role, last_acked_seq")
    .eq("token_hash", hash)
    .maybeSingle();
  if (error || !data) return null;
  return data as Shop;
}
