// POST /functions/v1/register-agent — mint a bearer token for a WhatsApp order
// agent under an EXISTING client company. Operator-only: gated by the same
// shared secret as bootstrap-company (PROVISION_ADMIN_SECRET), kept as its
// OWN function rather than a route inside agent/index.ts — admin-secret auth
// and agent-bearer-token auth are different trust boundaries, and this repo's
// convention (bootstrap-company vs add-shop) is to give each its own function
// and deploy surface rather than branch on auth type inside one handler.
//
// The company must already exist (bootstrap-company runs first); this never
// creates a company, only adds an agent identity under one that's already
// there — same relationship add-shop has to bootstrap-company, one level down.
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

  let body: { companyCode?: string; agentId?: string; scopes?: string[] };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "malformed json" }, 400);
  }

  const companyCode = (body.companyCode ?? "").trim();
  const agentId = (body.agentId ?? "").trim();
  if (!companyCode || !agentId) {
    return jsonResponse({ error: "companyCode and agentId are required" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const rpcArgs: Record<string, unknown> = { p_company_code: companyCode, p_agent_id: agentId };
  if (Array.isArray(body.scopes) && body.scopes.length > 0) rpcArgs.p_scopes = body.scopes;

  const { data: token, error } = await supabase.rpc("register_agent", rpcArgs);
  if (error) return jsonResponse({ error: error.message }, 500);

  return jsonResponse({ companyCode, agentId, token });
});
