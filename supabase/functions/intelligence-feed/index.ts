// GET /functions/v1/intelligence-feed — tenant-scoped company advice for HQ.
// The bearer token alone determines company_id. No company identifier is
// accepted from the caller, and SHOP tokens are rejected.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { authenticate, jsonResponse } from "../_shared/auth.ts";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
type Category = "CONTROL" | "INVENTORY" | "CREDIT" | "PRICING" | "CASH" | "CUSTOMER" | "CONCENTRATION";

interface FeedItem {
  fingerprint: string;
  sourceShopId: string;
  sourceShopName: string;
  modelKey: string;
  modelVersion: string;
  category: Category;
  audience: "OWNER";
  severity: Severity;
  controlOverride: boolean;
  title: string;
  recommendation: string;
  cediImpactPesewas: number | null;
  confidenceBps: number;
  dueAt: string | null;
  validUntil: string | null;
  sourceDataThrough: string;
  evidence: Array<{ label: string; value: string; detail?: string | null }>;
  rationale: Record<string, unknown>;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
}

const ACTIVE = new Set(["OPEN", "ACKNOWLEDGED", "ASSIGNED", "SNOOZED"]);
const CATEGORIES = new Set<Category>(["CONTROL", "INVENTORY", "CREDIT", "PRICING", "CASH", "CUSTOMER", "CONCENTRATION"]);
const SEVERITIES = new Set<Severity>(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

function numberValue(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function safeArray(value: unknown): Array<{ label: string; value: string; detail?: string | null }> {
  return Array.isArray(value) ? value.filter((row) => row && typeof row === "object") as Array<{ label: string; value: string; detail?: string | null }> : [];
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET") return jsonResponse({ error: "method not allowed" }, 405);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const caller = await authenticate(req, supabase);
  if (!caller) return jsonResponse({ error: "unauthorized" }, 401);
  if (caller.role !== "HQ") return jsonResponse({ error: "HQ role required" }, 403);

  const generatedAt = new Date().toISOString();
  await supabase.from("shops").update({ last_seen_at: generatedAt })
    .eq("company_id", caller.company_id).eq("shop_id", caller.shop_id);

  const { data: shopRows, error: shopsError } = await supabase.from("shops")
    .select("shop_id,name,role,last_seen_at")
    .eq("company_id", caller.company_id)
    .order("shop_id", { ascending: true });
  if (shopsError) return jsonResponse({ error: shopsError.message }, 500);

  const freshCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const shops = (shopRows ?? []).map((row) => {
    const lastSeenAt = row.last_seen_at as string | null;
    const stale = !lastSeenAt || new Date(lastSeenAt).getTime() < freshCutoff;
    return {
      shopId: String(row.shop_id),
      shopName: String(row.name ?? row.shop_id),
      role: row.role === "HQ" ? "HQ" as const : "SHOP" as const,
      lastSeenAt,
      stale,
      includedInPeerBaseline: !stale,
    };
  });
  const names = new Map(shops.map((shop) => [shop.shopId, shop.shopName]));
  const freshShopIds = shops.filter((shop) => !shop.stale).map((shop) => shop.shopId);

  const { data: sourceRows, error: itemsError } = await supabase
    .from("intelligence_items_central")
    .select("*")
    .eq("company_id", caller.company_id);
  if (itemsError) return jsonResponse({ error: itemsError.message }, 500);

  const items: FeedItem[] = [];
  for (const row of sourceRows ?? []) {
    if (!ACTIVE.has(String(row.status)) || String(row.scope) !== "LOCAL") continue;
    const shopId = String(row.shop_id);
    const category = String(row.category) as Category;
    const severity = String(row.severity) as Severity;
    if (!CATEGORIES.has(category) || !SEVERITIES.has(severity)) continue;
    const shopName = names.get(shopId) ?? shopId;
    items.push({
      fingerprint: `company:branch:${shopId}:${String(row.fingerprint)}`,
      sourceShopId: shopId,
      sourceShopName: shopName,
      modelKey: `branch/${String(row.model_key)}`,
      modelVersion: String(row.model_version ?? "unknown"),
      category,
      audience: "OWNER",
      severity,
      controlOverride: Boolean(row.control_override),
      title: `${shopName}: ${String(row.title)}`,
      recommendation: String(row.recommendation),
      cediImpactPesewas: row.cedi_impact_pesewas == null ? null : Math.max(0, numberValue(row.cedi_impact_pesewas)),
      confidenceBps: Math.min(10000, Math.max(0, numberValue(row.confidence_bps))),
      dueAt: row.due_at as string | null,
      validUntil: row.valid_until as string | null,
      sourceDataThrough: String(row.source_data_through ?? row.ingested_at ?? generatedAt),
      evidence: [{ label: "Shop", value: shopName }, ...safeArray(row.evidence)],
      rationale: { ...safeObject(row.rationale), centralIngestedAt: row.ingested_at },
      sourceEntityType: row.source_entity_type as string | null,
      sourceEntityId: row.source_entity_id as string | null,
    });
  }

  // Missing data is itself an operational risk; absent shops never count as
  // healthy and are excluded from every peer baseline.
  for (const shop of shops.filter((value) => value.stale)) {
    items.push({
      fingerprint: `company:sync-stale:${shop.shopId}`,
      sourceShopId: shop.shopId,
      sourceShopName: shop.shopName,
      modelKey: "company-sync-freshness",
      modelVersion: "1.0.0",
      category: "CONTROL",
      audience: "OWNER",
      severity: shop.lastSeenAt ? "HIGH" : "CRITICAL",
      controlOverride: true,
      title: `${shop.shopName}: company data is missing or stale`,
      recommendation: "Check power, internet, and sync health at this shop before relying on company comparisons.",
      cediImpactPesewas: null,
      confidenceBps: 10000,
      dueAt: generatedAt,
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      sourceDataThrough: shop.lastSeenAt ?? generatedAt,
      evidence: [
        { label: "Last seen", value: shop.lastSeenAt ?? "Never" },
        { label: "Peer baseline", value: "Excluded until fresh" },
      ],
      rationale: { staleAfterHours: 24, missingData: true },
      sourceEntityType: "shops",
      sourceEntityId: shop.shopId,
    });
  }

  let sourceDataThrough: string | null = null;
  if (freshShopIds.length >= 3) {
    const since = new Date(Date.now() - 28 * 86_400_000).toISOString().slice(0, 10);
    const { data: summaries, error: summaryError } = await supabase
      .from("daily_summaries_central")
      .select("shop_id,summary_date,total_revenue_pesewas,cash_count_variance_pesewas,stocktake_shrinkage_value_pesewas,generated_at")
      .eq("company_id", caller.company_id)
      .in("shop_id", freshShopIds)
      .gte("summary_date", since);
    if (summaryError) return jsonResponse({ error: summaryError.message }, 500);

    const totals = new Map<string, { revenue: number; cashVariance: number; shrinkage: number; through: string }>();
    for (const row of summaries ?? []) {
      const shopId = String(row.shop_id);
      const current = totals.get(shopId) ?? { revenue: 0, cashVariance: 0, shrinkage: 0, through: since };
      current.revenue += Math.max(0, numberValue(row.total_revenue_pesewas));
      current.cashVariance += Math.abs(numberValue(row.cash_count_variance_pesewas));
      current.shrinkage += Math.max(0, numberValue(row.stocktake_shrinkage_value_pesewas));
      current.through = String(row.generated_at ?? row.summary_date ?? current.through);
      totals.set(shopId, current);
      if (!sourceDataThrough || current.through > sourceDataThrough) sourceDataThrough = current.through;
    }

    const qualified = [...totals.entries()].filter(([, value]) => value.revenue > 0);
    if (qualified.length >= 3) {
      addPeerOutliers(items, qualified, names, "cashVariance", "cash-variance", generatedAt);
      addPeerOutliers(items, qualified, names, "shrinkage", "stock-shrinkage", generatedAt);
    }
  }

  if (!sourceDataThrough) {
    sourceDataThrough = items.reduce<string | null>((latest, item) =>
      !latest || item.sourceDataThrough > latest ? item.sourceDataThrough : latest, null);
  }
  return jsonResponse({
    generatedAt,
    sourceDataThrough,
    freshShopCount: freshShopIds.length,
    shops,
    items,
  });
});

function addPeerOutliers(
  items: FeedItem[],
  shops: Array<[string, { revenue: number; cashVariance: number; shrinkage: number; through: string }]>,
  names: Map<string, string>,
  metric: "cashVariance" | "shrinkage",
  modelKey: string,
  now: string,
): void {
  const rows = shops.map(([shopId, value]) => ({
    shopId,
    value,
    rateBps: Math.round(value[metric] * 10000 / value.revenue),
  }));
  const peerMedian = median(rows.map((row) => row.rateBps));
  const mad = median(rows.map((row) => Math.abs(row.rateBps - peerMedian)));
  // A small exact floor prevents a zero-MAD baseline from flagging immaterial
  // rounding differences. The robust MAD threshold still drives comparison.
  const threshold = peerMedian + Math.max(50, 3 * mad);
  for (const row of rows.filter((value) => value.rateBps > threshold && value.value[metric] >= 10000)) {
    const shopName = names.get(row.shopId) ?? row.shopId;
    const label = metric === "cashVariance" ? "cash variance" : "stock shrinkage";
    items.push({
      fingerprint: `company:peer:${modelKey}:${row.shopId}`,
      sourceShopId: row.shopId,
      sourceShopName: shopName,
      modelKey: `company-peer-${modelKey}`,
      modelVersion: "1.0.0",
      category: "CONTROL",
      audience: "OWNER",
      severity: row.rateBps >= Math.max(200, threshold * 2) ? "HIGH" : "MEDIUM",
      controlOverride: true,
      title: `${shopName}: unusual ${label} pattern requires review`,
      recommendation: `Review the shop's source summaries and reconciliation evidence. This comparison does not establish wrongdoing.`,
      cediImpactPesewas: row.value[metric],
      confidenceBps: Math.min(9500, 7500 + shops.length * 250),
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      validUntil: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      sourceDataThrough: row.value.through || now,
      evidence: [
        { label: "Shop rate", value: `${(row.rateBps / 100).toFixed(2)}% of revenue` },
        { label: "Fresh-shop median", value: `${(peerMedian / 100).toFixed(2)}%` },
        { label: "Review threshold", value: `${(threshold / 100).toFixed(2)}%` },
        { label: "Fresh shops compared", value: String(shops.length) },
      ],
      rationale: { windowDays: 28, normalization: "amount / revenue", peerMedianBps: peerMedian, madBps: mad, thresholdBps: threshold },
      sourceEntityType: "shops",
      sourceEntityId: row.shopId,
    });
  }
}
