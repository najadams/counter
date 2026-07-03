// POST /functions/v1/bootstrap-company — create a brand-new CLIENT COMPANY and
// its first shop. Operator-only: gated by a shared secret (PROVISION_ADMIN_SECRET,
// set via `supabase secrets set`), never exposed in the Counter app itself. This
// is deliberately NOT self-service — anyone with a copy of the app could otherwise
// spin up unlimited companies against this project for free. Adding a BRANCH to a
// company that already exists is self-service; see add-shop/index.ts instead.
//
// Deploy with verify_jwt=false (auth is the admin secret header, checked in-body).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/auth.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const adminSecret = Deno.env.get("PROVISION_ADMIN_SECRET");
  const provided = req.headers.get("x-admin-secret") ?? "";
  if (!adminSecret || provided !== adminSecret) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body: { companyCode?: string; companyName?: string; shopId?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "malformed json" }, 400);
  }

  const companyCode = (body.companyCode ?? "").trim();
  const companyName = (body.companyName ?? "").trim();
  const shopId = (body.shopId ?? "").trim();
  const role = body.role === "SHOP" ? "SHOP" : "HQ"; // first shop defaults HQ
  if (!companyCode || !companyName || !shopId) {
    return jsonResponse({ error: "companyCode, companyName, and shopId are required" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: token, error } = await supabase.rpc("provision_shop", {
    p_company_code: companyCode,
    p_company_name: companyName,
    p_shop_id: shopId,
    p_role: role,
  });
  if (error) return jsonResponse({ error: error.message }, 500);

  return jsonResponse({ companyCode, shopId, role, token });
});
