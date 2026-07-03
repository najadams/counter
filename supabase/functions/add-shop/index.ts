// POST /functions/v1/add-shop — self-service branch onboarding.
//
// An ALREADY-PROVISIONED shop authenticates with its own bearer token (proving
// which company it belongs to — see _shared/auth.ts) and asks for a sibling
// shop to be created under that SAME company. No company name/code is taken
// from the request; the company is whatever the caller's own token resolves to,
// so a shop can never add a branch to a company it doesn't belong to.
//
// Always mints role SHOP, regardless of what the body asks for — a second HQ
// per company would make /catalog's `.limit(1)` pick arbitrarily between two
// catalog sources. Minting an HQ stays an operator-only action (bootstrap-company).
//
// Deploy with verify_jwt=false (auth is the per-shop token, checked in-body).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticate, jsonResponse } from "../_shared/auth.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const shop = await authenticate(req, supabase);
  if (!shop) return jsonResponse({ error: "unauthorized" }, 401);

  let body: { shopId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "malformed json" }, 400);
  }

  const newShopId = (body.shopId ?? "").trim();
  if (!newShopId) return jsonResponse({ error: "shopId is required" }, 400);
  if (newShopId === shop.shop_id) {
    return jsonResponse({ error: "shopId must differ from the calling shop" }, 400);
  }

  const { data: token, error } = await supabase.rpc("add_shop_to_company", {
    p_company_id: shop.company_id,
    p_shop_id: newShopId,
    p_role: "SHOP", // hardcoded — see header comment
  });
  if (error) return jsonResponse({ error: error.message }, 500);

  return jsonResponse({ shopId: newShopId, role: "SHOP", token });
});
