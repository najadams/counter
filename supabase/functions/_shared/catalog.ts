// I/O helpers for reading the HQ catalog mirror — shop_events rows where
// table_name IN ('products','product_units') for a company's HQ shop, the
// same source the `catalog` function serves DOWN to shops (see its header
// comment). This module maps those raw jsonb rows into the plain objects
// pricing.ts's pure functions operate on; kept separate from pricing.ts so
// that module stays dependency-free and unit-testable without a live DB.
//
// shop_events is keyed by (company_id, shop_id, table_name, row_id) with
// upsert-on-conflict — so there is exactly one row per catalog entity here,
// always the latest version. No "pick the newest" logic needed.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { CatalogProduct, CatalogUnit } from "./pricing.ts";

export function mapProduct(data: Record<string, unknown>): CatalogProduct {
  return {
    id: String(data.id),
    sku: String(data.sku),
    name: String(data.name),
    active: !!data.active,
    deletedAt: (data.deleted_at as string | null) ?? null,
    walkInPricePesewas: Number(data.walk_in_price_pesewas ?? 0),
    wholesalePricePesewas: Number(data.wholesale_price_pesewas ?? 0),
    routePricePesewas: Number(data.route_price_pesewas ?? 0),
    reorderThreshold: Number(data.reorder_threshold ?? 0),
  };
}

export function mapUnit(data: Record<string, unknown>): CatalogUnit {
  return {
    id: String(data.id),
    productId: String(data.product_id),
    unitName: String(data.unit_name),
    conversionFactor: Number(data.conversion_factor ?? 1),
    pricePesewas: Number(data.price_pesewas ?? 0),
    isSaleUnit: !!data.is_sale_unit,
    active: !!data.active,
  };
}

/** This company's HQ shop_id — the source of its catalog. Null if the
 *  company has no HQ shop provisioned yet. */
export async function findHqShopId(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("shops").select("shop_id")
    .eq("company_id", companyId).eq("role", "HQ")
    .limit(1).maybeSingle();
  if (error || !data) return null;
  return data.shop_id as string;
}

export interface HqCatalog {
  productsById: Map<string, CatalogProduct>;
  unitsById: Map<string, CatalogUnit>;
  unitsByProduct: Map<string, CatalogUnit[]>;
}

/** Loads the WHOLE HQ catalog (products + product_units) in two queries.
 *  Fine at beverage-shop scale (dozens to low hundreds of SKUs); if a
 *  catalog ever grows large enough for this to matter, push the filtering
 *  into Postgres jsonb operators instead of loading everything — this
 *  function is the one place that would change. */
export async function loadHqCatalog(
  supabase: SupabaseClient, companyId: string, hqShopId: string,
): Promise<HqCatalog> {
  const [productsRes, unitsRes] = await Promise.all([
    supabase.from("shop_events").select("data")
      .eq("company_id", companyId).eq("shop_id", hqShopId).eq("table_name", "products"),
    supabase.from("shop_events").select("data")
      .eq("company_id", companyId).eq("shop_id", hqShopId).eq("table_name", "product_units"),
  ]);

  const productsById = new Map<string, CatalogProduct>();
  for (const row of productsRes.data ?? []) {
    const p = mapProduct(row.data as Record<string, unknown>);
    productsById.set(p.id, p);
  }

  const unitsById = new Map<string, CatalogUnit>();
  const unitsByProduct = new Map<string, CatalogUnit[]>();
  for (const row of unitsRes.data ?? []) {
    const u = mapUnit(row.data as Record<string, unknown>);
    unitsById.set(u.id, u);
    const arr = unitsByProduct.get(u.productId) ?? [];
    arr.push(u);
    unitsByProduct.set(u.productId, arr);
  }

  return { productsById, unitsById, unitsByProduct };
}

export interface CatalogSearchResult {
  productId: string;
  sku: string;
  name: string;
  units: Array<{
    unitId: string | null;   // null = canonical
    unitName: string;
    conversionFactor: number;
    isSaleUnit: boolean;
  }>;
}

/** Active, non-deleted products matching a text query (sku/name substring,
 *  case-insensitive), each with its active sale units. Empty query returns
 *  everything up to `limit`. */
export function searchCatalog(catalog: HqCatalog, query: string, limit: number): CatalogSearchResult[] {
  const trimmed = query.trim().toLowerCase();
  const out: CatalogSearchResult[] = [];
  for (const p of catalog.productsById.values()) {
    if (!p.active || p.deletedAt) continue;
    if (trimmed !== "" && !p.sku.toLowerCase().includes(trimmed) && !p.name.toLowerCase().includes(trimmed)) continue;
    const units = (catalog.unitsByProduct.get(p.id) ?? [])
      .filter((u) => u.active && u.isSaleUnit)
      .map((u) => ({ unitId: u.id, unitName: u.unitName, conversionFactor: u.conversionFactor, isSaleUnit: u.isSaleUnit }));
    out.push({ productId: p.id, sku: p.sku, name: p.name, units });
    if (out.length >= limit) break;
  }
  return out;
}
