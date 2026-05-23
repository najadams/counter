// catalogExport — read master-data tables (suppliers, products, units,
// tiers, customers, customer price overrides) into a portable JSON payload
// keyed by natural keys (SKU, phone, supplier name, unit name) instead of
// internal UUIDs. The companion catalogImport service applies the payload
// to another instance.
//
// Scope: catalog only. Sales, stock movements, audit, workers, and shifts
// are deliberately excluded — those are operational records that should
// not transfer between instances. Use the full-DB backup for that.

import type { Database as DB } from 'better-sqlite3';
import type {
  CatalogCustomer, CatalogCustomerPriceOverride,
  CatalogExportPayload, CatalogPricingTier, CatalogProduct,
  CatalogProductUnit, CatalogSupplier, CatalogTable,
} from '../../shared/types/ipc.js';

export interface ExportCatalogOptions {
  tables?: CatalogTable[];
  includeInactive?: boolean;
  /** Source-device fingerprint to stamp into the file header. */
  deviceId: string;
  shopName: string | null;
  appVersion: string | null;
}

const ALL_TABLES: CatalogTable[] = [
  'suppliers', 'products', 'productUnits',
  'pricingTiers', 'customers', 'customerPriceOverrides',
];

export function exportCatalog(db: DB, opts: ExportCatalogOptions): CatalogExportPayload {
  const tables = new Set(opts.tables && opts.tables.length > 0 ? opts.tables : ALL_TABLES);
  const includeInactive = opts.includeInactive === true;

  const payload: CatalogExportPayload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    source: {
      deviceId: opts.deviceId,
      shopName: opts.shopName,
      appVersion: opts.appVersion,
    },
    tables: {},
  };

  if (tables.has('suppliers')) {
    payload.tables.suppliers = readSuppliers(db, includeInactive);
  }
  if (tables.has('products')) {
    payload.tables.products = readProducts(db, includeInactive);
  }
  if (tables.has('productUnits')) {
    payload.tables.productUnits = readProductUnits(db, includeInactive);
  }
  if (tables.has('pricingTiers')) {
    payload.tables.pricingTiers = readPricingTiers(db, includeInactive);
  }
  if (tables.has('customers')) {
    payload.tables.customers = readCustomers(db, includeInactive);
  }
  if (tables.has('customerPriceOverrides')) {
    payload.tables.customerPriceOverrides = readCustomerPriceOverrides(db, includeInactive);
  }

  return payload;
}

function readSuppliers(db: DB, includeInactive: boolean): CatalogSupplier[] {
  const rows = db.prepare(
    `SELECT name, contact_person AS contactPerson, phone, email,
            payment_terms_days AS paymentTermsDays,
            notes, active
       FROM suppliers
       WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND active = 1'}
       ORDER BY name ASC`,
  ).all() as Array<Omit<CatalogSupplier, 'active'> & { active: number }>;
  return rows.map((r) => ({ ...r, active: r.active === 1 }));
}

function readProducts(db: DB, includeInactive: boolean): CatalogProduct[] {
  // LEFT JOINs on supplier name + the two primary-unit rows so the file is
  // self-contained and the importer doesn't need to peek inside the same
  // file to resolve FKs that travelled with the product.
  const rows = db.prepare(
    `SELECT
        p.sku, p.barcode, p.name, p.category, p.brand,
        p.pack_size_units AS packSizeUnits,
        p.unit_volume_ml AS unitVolumeMl,
        p.is_returnable AS isReturnable,
        p.bottle_deposit_pesewas AS bottleDepositPesewas,
        p.cost_price_pesewas AS costPricePesewas,
        p.walk_in_price_pesewas AS walkInPricePesewas,
        p.wholesale_price_pesewas AS wholesalePricePesewas,
        p.route_price_pesewas AS routePricePesewas,
        p.reorder_threshold AS reorderThreshold,
        p.reorder_quantity AS reorderQuantity,
        p.default_lead_time_days AS defaultLeadTimeDays,
        p.shelf_life_days AS shelfLifeDays,
        p.canonical_unit AS canonicalUnit,
        p.count_class AS countClass,
        p.active,
        s.name AS primarySupplierName,
        ppu.unit_name AS primaryPurchaseUnitName,
        psu.unit_name AS primarySaleUnitName
       FROM products p
       LEFT JOIN suppliers s ON s.id = p.primary_supplier_id AND s.deleted_at IS NULL
       LEFT JOIN product_units ppu ON ppu.id = p.primary_purchase_unit_id
       LEFT JOIN product_units psu ON psu.id = p.primary_sale_unit_id
       WHERE p.deleted_at IS NULL ${includeInactive ? '' : 'AND p.active = 1'}
       ORDER BY p.sku ASC`,
  ).all() as Array<Omit<CatalogProduct, 'isReturnable' | 'active'> & { isReturnable: number; active: number }>;
  return rows.map((r) => ({
    ...r,
    isReturnable: r.isReturnable === 1,
    active: r.active === 1,
  }));
}

function readProductUnits(db: DB, includeInactive: boolean): CatalogProductUnit[] {
  const rows = db.prepare(
    `SELECT
        p.sku AS productSku,
        pu.unit_name AS unitName,
        pu.conversion_factor AS conversionFactor,
        pu.price_pesewas AS pricePesewas,
        pu.is_purchase_unit AS isPurchaseUnit,
        pu.is_sale_unit AS isSaleUnit,
        pu.display_order AS displayOrder,
        pu.notes, pu.active
       FROM product_units pu
       JOIN products p ON p.id = pu.product_id AND p.deleted_at IS NULL
       WHERE 1=1 ${includeInactive ? '' : 'AND pu.active = 1 AND p.active = 1'}
       ORDER BY p.sku ASC, pu.display_order ASC, pu.unit_name ASC`,
  ).all() as Array<Omit<CatalogProductUnit, 'isPurchaseUnit' | 'isSaleUnit' | 'active'> &
    { isPurchaseUnit: number; isSaleUnit: number; active: number }>;
  return rows.map((r) => ({
    ...r,
    isPurchaseUnit: r.isPurchaseUnit === 1,
    isSaleUnit: r.isSaleUnit === 1,
    active: r.active === 1,
  }));
}

function readPricingTiers(db: DB, includeInactive: boolean): CatalogPricingTier[] {
  const rows = db.prepare(
    `SELECT
        p.sku AS productSku,
        t.channel,
        t.min_quantity AS minQuantity,
        t.unit_price_pesewas AS unitPricePesewas,
        t.priority,
        pu.unit_name AS appliesToUnitName,
        t.notes, t.active
       FROM pricing_tiers t
       JOIN products p ON p.id = t.product_id AND p.deleted_at IS NULL
       LEFT JOIN product_units pu ON pu.id = t.applies_to_unit_id
       WHERE 1=1 ${includeInactive ? '' : 'AND t.active = 1 AND p.active = 1'}
       ORDER BY p.sku ASC, t.channel ASC, t.min_quantity ASC`,
  ).all() as Array<Omit<CatalogPricingTier, 'active'> & { active: number }>;
  return rows.map((r) => ({ ...r, active: r.active === 1 }));
}

function readCustomers(db: DB, includeInactive: boolean): CatalogCustomer[] {
  // 'blocked' is a soft state, not the same as inactive; we include blocked
  // customers regardless. includeInactive only governs whether soft-deleted
  // rows resurface — they never do (we filter deleted_at).
  void includeInactive;
  const rows = db.prepare(
    `SELECT
        display_name AS displayName,
        phone,
        alternate_phone AS alternatePhone,
        customer_type AS customerType,
        business_name AS businessName,
        location_description AS locationDescription,
        geo_lat AS geoLat, geo_lng AS geoLng,
        credit_limit_pesewas AS creditLimitPesewas,
        credit_terms_days AS creditTermsDays,
        preferred_channel AS preferredChannel,
        blocked, blocked_reason AS blockedReason,
        notes
       FROM customers
       WHERE deleted_at IS NULL
       ORDER BY display_name ASC`,
  ).all() as Array<Omit<CatalogCustomer, 'blocked'> & { blocked: number }>;
  return rows.map((r) => ({ ...r, blocked: r.blocked === 1 }));
}

function readCustomerPriceOverrides(db: DB, includeInactive: boolean): CatalogCustomerPriceOverride[] {
  const rows = db.prepare(
    `SELECT
        c.phone AS customerPhone,
        p.sku AS productSku,
        pu.unit_name AS unitName,
        cpo.channel,
        cpo.price_pesewas AS pricePesewas,
        cpo.notes,
        cpo.active
       FROM customer_price_overrides cpo
       JOIN customers c ON c.id = cpo.customer_id AND c.deleted_at IS NULL
       JOIN products p ON p.id = cpo.product_id AND p.deleted_at IS NULL
       JOIN product_units pu ON pu.id = cpo.applies_to_unit_id
       WHERE 1=1 ${includeInactive ? '' : 'AND cpo.active = 1'}
       ORDER BY c.phone ASC, p.sku ASC, pu.unit_name ASC`,
  ).all() as Array<Omit<CatalogCustomerPriceOverride, 'active'> & { active: number }>;
  return rows.map((r) => ({ ...r, active: r.active === 1 }));
}
