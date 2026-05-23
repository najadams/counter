// catalogImport — apply a CatalogExportPayload to this database.
//
// Two modes:
//   - dryRun: analyse the payload, count what would change, but DON'T write
//   - apply:  do the work inside a single transaction; aborts on any error
//
// Conflict policy:
//   - default ("merge"): rows that match by natural key are LEFT ALONE
//   - updateExisting=true: matching rows have non-key fields overwritten
//   - inserts always happen for rows whose natural key is unseen
//
// FK resolution: products refer to suppliers by name, units refer to
// products by SKU, tiers and customer-price-overrides refer to units by
// (productSku, unitName). When a referenced row isn't in the file AND
// isn't already in the DB, the dependent row is SKIPPED with a warning —
// the import does not silently break referential integrity.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { normalizePhone } from '../../shared/lib/phone.js';
import { logAudit } from '../db/audit.js';
import type {
  CatalogCustomer, CatalogCustomerPriceOverride, CatalogExportPayload,
  CatalogImportTableReport, CatalogPricingTier, CatalogProduct,
  CatalogProductUnit, CatalogSupplier, CatalogTable,
} from '../../shared/types/ipc.js';

const VALID_CATEGORIES = new Set([
  'BEER', 'WINE', 'SPIRITS', 'SOFT_DRINK', 'WATER', 'JUICE',
  'ENERGY_DRINK', 'MIXER', 'NON_BEVERAGE', 'OTHER',
]);
const VALID_CUSTOMER_TYPES = new Set(['WALK_IN_REGULAR', 'WHOLESALE', 'ROUTE', 'STAFF_FAMILY']);
const VALID_CHANNELS = new Set(['WALK_IN', 'WHOLESALE', 'ROUTE']);
const VALID_TIER_CHANNELS = new Set(['WALK_IN', 'WHOLESALE', 'ROUTE', 'ALL']);
const VALID_COUNT_CLASSES = new Set(['A', 'B', 'C']);

const MAX_WARNINGS_PER_TABLE = 20;

export interface ImportOptions {
  dryRun: boolean;
  updateExisting: boolean;
  tables?: CatalogTable[];
  actorWorkerId: string;
  deviceId: string;
}

export interface ImportResult {
  report: CatalogImportTableReport[];
}

export function applyCatalogImport(
  db: DB, payload: CatalogExportPayload, opts: ImportOptions,
): ImportResult {
  if (payload.schemaVersion !== 1) {
    throw new Error(`Unsupported export schema version ${payload.schemaVersion}. Update Counter to read this file.`);
  }

  const requested = new Set(opts.tables && opts.tables.length > 0
    ? opts.tables
    : (Object.keys(payload.tables) as CatalogTable[]));

  // Each step returns a report row. Order matters: suppliers and customers
  // first (no inter-catalog FKs), then products, units, then everything
  // that depends on units.
  const reports: CatalogImportTableReport[] = [];

  const runOne = (fn: () => CatalogImportTableReport) => { reports.push(fn()); };

  const tx = db.transaction(() => {
    if (requested.has('suppliers') && payload.tables.suppliers) {
      runOne(() => importSuppliers(db, payload.tables.suppliers!, opts));
    }
    if (requested.has('customers') && payload.tables.customers) {
      runOne(() => importCustomers(db, payload.tables.customers!, opts));
    }
    if (requested.has('products') && payload.tables.products) {
      runOne(() => importProducts(db, payload.tables.products!, opts));
    }
    if (requested.has('productUnits') && payload.tables.productUnits) {
      runOne(() => importProductUnits(db, payload.tables.productUnits!, opts));
    }
    // Resolve product primary unit FKs in a second pass — products may have
    // been inserted before their units existed.
    if (requested.has('products') && payload.tables.products) {
      resolvePrimaryUnits(db, payload.tables.products, opts);
    }
    if (requested.has('pricingTiers') && payload.tables.pricingTiers) {
      runOne(() => importPricingTiers(db, payload.tables.pricingTiers!, opts));
    }
    if (requested.has('customerPriceOverrides') && payload.tables.customerPriceOverrides) {
      runOne(() => importCustomerPriceOverrides(db, payload.tables.customerPriceOverrides!, opts));
    }

    if (!opts.dryRun) {
      logAudit(db, {
        workerId: opts.actorWorkerId,
        action: 'CATALOG_IMPORTED',
        entityType: 'catalog',
        entityId: 'import',
        afterValue: {
          source: payload.source,
          exportedAt: payload.exportedAt,
          updateExisting: opts.updateExisting,
          tables: reports.map((r) => ({
            table: r.table, inserted: r.toInsert, updated: r.toUpdate, skipped: r.skipped,
          })),
        },
        deviceId: opts.deviceId,
      });
    }

    if (opts.dryRun) {
      // Roll the transaction back. better-sqlite3 transactions commit
      // automatically when the wrapped function returns; the conventional
      // way to abort is to throw a sentinel.
      throw DRY_RUN_ROLLBACK;
    }
  });

  try {
    tx();
  } catch (err) {
    if (err !== DRY_RUN_ROLLBACK) throw err;
  }

  return { report: reports };
}

const DRY_RUN_ROLLBACK = Symbol('dry-run-rollback');

// ---------- suppliers ----------

function importSuppliers(
  db: DB, rows: CatalogSupplier[], opts: ImportOptions,
): CatalogImportTableReport {
  const r = newReport('suppliers', rows.length);
  const findByName = db.prepare(
    `SELECT id, contact_person AS contactPerson, phone, email,
            payment_terms_days AS paymentTermsDays, notes, active
       FROM suppliers WHERE name = ? AND deleted_at IS NULL`,
  );
  const insert = db.prepare(
    `INSERT INTO suppliers (
       id, name, contact_person, phone, email, payment_terms_days,
       current_balance_pesewas, notes, active,
       created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE suppliers
        SET contact_person = ?, phone = ?, email = ?, payment_terms_days = ?,
            notes = ?, active = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_by = ?, device_id = ?
      WHERE id = ?`,
  );

  for (const row of rows) {
    const name = (row.name ?? '').trim();
    if (!name) { skip(r, 'supplier missing name'); continue; }

    let phone: string | null = null;
    if (row.phone) {
      const norm = normalizePhone(row.phone);
      if (!norm) { skip(r, `supplier '${name}': invalid phone '${row.phone}'`); continue; }
      phone = norm;
    }

    const existing = findByName.get(name) as
      | { id: string; contactPerson: string | null; phone: string | null; email: string | null;
          paymentTermsDays: number; notes: string | null; active: number }
      | undefined;

    if (existing) {
      r.matched += 1;
      if (opts.updateExisting) {
        r.toUpdate += 1;
        {
          update.run(
            row.contactPerson ?? null,
            phone,
            row.email ?? null,
            row.paymentTermsDays,
            row.notes ?? null,
            row.active ? 1 : 0,
            opts.actorWorkerId, opts.deviceId, existing.id,
          );
        }
      }
    } else {
      r.toInsert += 1;
      insert.run(
        `sup-${uuidv4()}`, name,
        row.contactPerson ?? null, phone, row.email ?? null,
        row.paymentTermsDays, row.notes ?? null,
        row.active ? 1 : 0,
        opts.actorWorkerId, opts.actorWorkerId, opts.deviceId,
      );
    }
  }
  return r;
}

// ---------- customers ----------

function importCustomers(
  db: DB, rows: CatalogCustomer[], opts: ImportOptions,
): CatalogImportTableReport {
  const r = newReport('customers', rows.length);
  const findByPhone = db.prepare(
    `SELECT id FROM customers WHERE phone = ? AND deleted_at IS NULL`,
  );
  const insert = db.prepare(
    `INSERT INTO customers (
       id, display_name, phone, alternate_phone, customer_type,
       business_name, location_description, geo_lat, geo_lng,
       credit_limit_pesewas, credit_terms_days, preferred_channel,
       current_balance_pesewas, blocked, blocked_reason, notes,
       created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE customers
        SET display_name = ?, alternate_phone = ?, customer_type = ?,
            business_name = ?, location_description = ?,
            geo_lat = ?, geo_lng = ?,
            credit_limit_pesewas = ?, credit_terms_days = ?,
            preferred_channel = ?,
            blocked = ?, blocked_reason = ?, notes = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_by = ?, device_id = ?
      WHERE id = ?`,
  );

  for (const row of rows) {
    const name = (row.displayName ?? '').trim();
    if (!name) { skip(r, 'customer missing displayName'); continue; }
    const phone = normalizePhone(row.phone);
    if (!phone) { skip(r, `customer '${name}': invalid phone '${row.phone}'`); continue; }

    let altPhone: string | null = null;
    if (row.alternatePhone) {
      altPhone = normalizePhone(row.alternatePhone);
      if (!altPhone) { skip(r, `customer '${name}': invalid alternatePhone '${row.alternatePhone}'`); continue; }
    }
    if (!VALID_CUSTOMER_TYPES.has(row.customerType)) {
      skip(r, `customer '${name}': invalid customerType '${row.customerType}'`); continue;
    }
    if (row.preferredChannel && !VALID_CHANNELS.has(row.preferredChannel)) {
      skip(r, `customer '${name}': invalid preferredChannel '${row.preferredChannel}'`); continue;
    }
    if (row.blocked && !row.blockedReason) {
      skip(r, `customer '${name}': blocked=true requires blockedReason`); continue;
    }

    const existing = findByPhone.get(phone) as { id: string } | undefined;
    if (existing) {
      r.matched += 1;
      if (opts.updateExisting) {
        r.toUpdate += 1;
        {
          update.run(
            name, altPhone, row.customerType,
            row.businessName ?? null, row.locationDescription ?? null,
            row.geoLat, row.geoLng,
            row.creditLimitPesewas, row.creditTermsDays,
            row.preferredChannel ?? null,
            row.blocked ? 1 : 0, row.blockedReason ?? null, row.notes ?? null,
            opts.actorWorkerId, opts.deviceId, existing.id,
          );
        }
      }
    } else {
      r.toInsert += 1;
      insert.run(
        `cust-${uuidv4()}`, name, phone, altPhone, row.customerType,
        row.businessName ?? null, row.locationDescription ?? null,
        row.geoLat, row.geoLng,
        row.creditLimitPesewas, row.creditTermsDays,
        row.preferredChannel ?? null,
        row.blocked ? 1 : 0, row.blockedReason ?? null, row.notes ?? null,
        opts.actorWorkerId, opts.actorWorkerId, opts.deviceId,
      );
    }
  }
  return r;
}

// ---------- products ----------

function importProducts(
  db: DB, rows: CatalogProduct[], opts: ImportOptions,
): CatalogImportTableReport {
  const r = newReport('products', rows.length);
  const findBySku = db.prepare(
    `SELECT id, primary_supplier_id AS primarySupplierId
       FROM products WHERE sku = ? AND deleted_at IS NULL`,
  );
  // products.sku has a table-level UNIQUE constraint, so a soft-deleted
  // row still locks the SKU. Detect that and skip rather than crashing
  // the whole transaction with a UNIQUE-constraint error.
  const findSoftDeletedBySku = db.prepare(
    `SELECT id FROM products WHERE sku = ? AND deleted_at IS NOT NULL`,
  );
  const findSupplierByName = db.prepare(
    `SELECT id FROM suppliers WHERE name = ? AND deleted_at IS NULL`,
  );
  const findByBarcode = db.prepare(
    `SELECT id FROM products WHERE barcode = ? AND deleted_at IS NULL`,
  );
  const insert = db.prepare(
    `INSERT INTO products (
       id, sku, barcode, name, category, brand, pack_size_units, unit_volume_ml,
       is_returnable, bottle_deposit_pesewas,
       cost_price_pesewas, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
       reorder_threshold, reorder_quantity, primary_supplier_id,
       default_lead_time_days, shelf_life_days, canonical_unit, count_class, active,
       created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE products SET
        barcode = ?, name = ?, category = ?, brand = ?,
        pack_size_units = ?, unit_volume_ml = ?,
        is_returnable = ?, bottle_deposit_pesewas = ?,
        cost_price_pesewas = ?, walk_in_price_pesewas = ?,
        wholesale_price_pesewas = ?, route_price_pesewas = ?,
        reorder_threshold = ?, reorder_quantity = ?,
        primary_supplier_id = ?, default_lead_time_days = ?,
        shelf_life_days = ?, canonical_unit = ?, count_class = ?, active = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_by = ?, device_id = ?
      WHERE id = ?`,
  );

  for (const row of rows) {
    const sku = (row.sku ?? '').trim();
    if (!sku) { skip(r, 'product missing sku'); continue; }
    if (!VALID_CATEGORIES.has(row.category)) {
      skip(r, `product '${sku}': invalid category '${row.category}'`); continue;
    }
    if (row.countClass !== null && !VALID_COUNT_CLASSES.has(row.countClass)) {
      skip(r, `product '${sku}': invalid countClass '${row.countClass}'`); continue;
    }
    let priceBad = false;
    for (const f of ['costPricePesewas', 'walkInPricePesewas', 'wholesalePricePesewas', 'routePricePesewas', 'bottleDepositPesewas'] as const) {
      const v = row[f];
      if (!Number.isInteger(v) || v < 0) {
        skip(r, `product '${sku}': ${f} must be a non-negative integer (got ${v})`);
        priceBad = true;
        break;
      }
    }
    if (priceBad) continue;

    let supplierId: string | null = null;
    if (row.primarySupplierName) {
      const sup = findSupplierByName.get(row.primarySupplierName) as { id: string } | undefined;
      if (!sup) {
        warn(r, `product '${sku}': primarySupplierName '${row.primarySupplierName}' not found — inserted with no supplier link`);
      } else {
        supplierId = sup.id;
      }
    }

    // Barcode collisions: if the product has a barcode and another product
    // already has it, skip (the DB has a UNIQUE constraint).
    if (row.barcode) {
      const clash = findByBarcode.get(row.barcode) as { id: string } | undefined;
      const existingBySku = findBySku.get(sku) as { id: string } | undefined;
      if (clash && (!existingBySku || clash.id !== existingBySku.id)) {
        skip(r, `product '${sku}': barcode '${row.barcode}' already used by another product`);
        continue;
      }
    }

    const existing = findBySku.get(sku) as { id: string } | undefined;
    if (!existing) {
      const tombstone = findSoftDeletedBySku.get(sku) as { id: string } | undefined;
      if (tombstone) {
        skip(r, `product '${sku}': a soft-deleted product holds this SKU — restore it from the Products tab first`);
        continue;
      }
    }
    if (existing) {
      r.matched += 1;
      if (opts.updateExisting) {
        r.toUpdate += 1;
        {
          update.run(
            row.barcode ?? null, row.name, row.category, row.brand ?? null,
            row.packSizeUnits, row.unitVolumeMl,
            row.isReturnable ? 1 : 0, row.bottleDepositPesewas,
            row.costPricePesewas, row.walkInPricePesewas,
            row.wholesalePricePesewas, row.routePricePesewas,
            row.reorderThreshold, row.reorderQuantity,
            supplierId, row.defaultLeadTimeDays,
            row.shelfLifeDays, row.canonicalUnit ?? 'UNIT', row.countClass,
            row.active ? 1 : 0,
            opts.actorWorkerId, opts.deviceId, existing.id,
          );
        }
      }
    } else {
      r.toInsert += 1;
      insert.run(
        `prod-${uuidv4()}`, sku, row.barcode ?? null, row.name, row.category,
        row.brand ?? null, row.packSizeUnits, row.unitVolumeMl,
        row.isReturnable ? 1 : 0, row.bottleDepositPesewas,
        row.costPricePesewas, row.walkInPricePesewas,
        row.wholesalePricePesewas, row.routePricePesewas,
        row.reorderThreshold, row.reorderQuantity,
        supplierId, row.defaultLeadTimeDays,
        row.shelfLifeDays, row.canonicalUnit ?? 'UNIT', row.countClass,
        row.active ? 1 : 0,
        opts.actorWorkerId, opts.actorWorkerId, opts.deviceId,
      );
    }
  }
  return r;
}

// ---------- product_units ----------

function importProductUnits(
  db: DB, rows: CatalogProductUnit[], opts: ImportOptions,
): CatalogImportTableReport {
  const r = newReport('productUnits', rows.length);
  const findProductBySku = db.prepare(
    `SELECT id FROM products WHERE sku = ? AND deleted_at IS NULL`,
  );
  const findByKey = db.prepare(
    `SELECT id FROM product_units WHERE product_id = ? AND unit_name = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO product_units (
       id, product_id, unit_name, conversion_factor, price_pesewas,
       is_purchase_unit, is_sale_unit, display_order, active, notes,
       created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE product_units SET
        conversion_factor = ?, price_pesewas = ?,
        is_purchase_unit = ?, is_sale_unit = ?, display_order = ?,
        active = ?, notes = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_by = ?, device_id = ?
      WHERE id = ?`,
  );

  for (const row of rows) {
    const unitName = (row.unitName ?? '').trim().toUpperCase();
    if (!unitName) { skip(r, 'productUnit missing unitName'); continue; }
    if (!Number.isInteger(row.conversionFactor) || row.conversionFactor <= 0) {
      skip(r, `unit '${row.productSku}/${unitName}': conversionFactor must be a positive integer`); continue;
    }
    if (!Number.isInteger(row.pricePesewas) || row.pricePesewas < 0) {
      skip(r, `unit '${row.productSku}/${unitName}': pricePesewas must be a non-negative integer`); continue;
    }
    if (!row.isPurchaseUnit && !row.isSaleUnit) {
      skip(r, `unit '${row.productSku}/${unitName}': must be sellable, purchasable, or both`); continue;
    }
    const prod = findProductBySku.get(row.productSku) as { id: string } | undefined;
    if (!prod) { skip(r, `unit '${row.productSku}/${unitName}': product SKU not found`); continue; }

    const existing = findByKey.get(prod.id, unitName) as { id: string } | undefined;
    if (existing) {
      r.matched += 1;
      if (opts.updateExisting) {
        r.toUpdate += 1;
        {
          update.run(
            row.conversionFactor, row.pricePesewas,
            row.isPurchaseUnit ? 1 : 0, row.isSaleUnit ? 1 : 0,
            row.displayOrder, row.active ? 1 : 0, row.notes ?? null,
            opts.actorWorkerId, opts.deviceId, existing.id,
          );
        }
      }
    } else {
      r.toInsert += 1;
      insert.run(
        `pu-${uuidv4()}`, prod.id, unitName, row.conversionFactor, row.pricePesewas,
        row.isPurchaseUnit ? 1 : 0, row.isSaleUnit ? 1 : 0,
        row.displayOrder, row.active ? 1 : 0, row.notes ?? null,
        opts.actorWorkerId, opts.actorWorkerId, opts.deviceId,
      );
    }
  }
  return r;
}

// ---------- second pass: products.primary_purchase/sale_unit_id ----------
//
// Products were inserted with NULL primary unit FKs (their referenced units
// may not have existed yet). Now that product_units is populated, resolve
// the unit_name references back to ids and stamp them onto the products.
// Best-effort: missing references just stay NULL.

function resolvePrimaryUnits(db: DB, products: CatalogProduct[], opts: ImportOptions): void {
  const findProd = db.prepare(
    `SELECT id, primary_purchase_unit_id AS primaryPurchaseUnitId,
            primary_sale_unit_id AS primarySaleUnitId
       FROM products WHERE sku = ? AND deleted_at IS NULL`,
  );
  const findUnit = db.prepare(
    `SELECT id FROM product_units WHERE product_id = ? AND unit_name = ?`,
  );
  const setPrim = db.prepare(
    `UPDATE products
        SET primary_purchase_unit_id = ?, primary_sale_unit_id = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_by = ?, device_id = ?
      WHERE id = ?`,
  );

  for (const row of products) {
    const prod = findProd.get(row.sku) as
      | { id: string; primaryPurchaseUnitId: string | null; primarySaleUnitId: string | null }
      | undefined;
    if (!prod) continue;

    let purchase = prod.primaryPurchaseUnitId;
    let sale = prod.primarySaleUnitId;
    let dirty = false;

    if (row.primaryPurchaseUnitName) {
      const u = findUnit.get(prod.id, row.primaryPurchaseUnitName.toUpperCase()) as { id: string } | undefined;
      if (u && u.id !== prod.primaryPurchaseUnitId) { purchase = u.id; dirty = true; }
    }
    if (row.primarySaleUnitName) {
      const u = findUnit.get(prod.id, row.primarySaleUnitName.toUpperCase()) as { id: string } | undefined;
      if (u && u.id !== prod.primarySaleUnitId) { sale = u.id; dirty = true; }
    }
    if (dirty) {
      setPrim.run(purchase, sale, opts.actorWorkerId, opts.deviceId, prod.id);
    }
  }
}

// ---------- pricing_tiers ----------

function importPricingTiers(
  db: DB, rows: CatalogPricingTier[], opts: ImportOptions,
): CatalogImportTableReport {
  const r = newReport('pricingTiers', rows.length);
  const findProductBySku = db.prepare(
    `SELECT id FROM products WHERE sku = ? AND deleted_at IS NULL`,
  );
  const findUnit = db.prepare(
    `SELECT id FROM product_units WHERE product_id = ? AND unit_name = ?`,
  );
  // Look up any row (active OR inactive) with the same natural key. The
  // table-level UNIQUE constraint applies regardless of active state, so
  // inserting a new row when an inactive one already exists would fail.
  const findExisting = db.prepare(
    `SELECT id, active FROM pricing_tiers
       WHERE product_id = ? AND channel = ? AND min_quantity = ?
         AND COALESCE(applies_to_unit_id, '') = COALESCE(?, '')`,
  );
  const insert = db.prepare(
    `INSERT INTO pricing_tiers (
       id, product_id, channel, min_quantity, unit_price_pesewas, priority,
       active, notes, applies_to_unit_id,
       created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE pricing_tiers SET
        unit_price_pesewas = ?, priority = ?, notes = ?, active = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_by = ?, device_id = ?
      WHERE id = ?`,
  );

  for (const row of rows) {
    if (!VALID_TIER_CHANNELS.has(row.channel)) {
      skip(r, `tier '${row.productSku}': invalid channel '${row.channel}'`); continue;
    }
    if (!Number.isInteger(row.minQuantity) || row.minQuantity <= 0) {
      skip(r, `tier '${row.productSku}': minQuantity must be positive`); continue;
    }
    if (!Number.isInteger(row.unitPricePesewas) || row.unitPricePesewas < 0) {
      skip(r, `tier '${row.productSku}': unitPricePesewas must be a non-negative integer`); continue;
    }

    const prod = findProductBySku.get(row.productSku) as { id: string } | undefined;
    if (!prod) { skip(r, `tier '${row.productSku}': product not found`); continue; }

    let unitId: string | null = null;
    if (row.appliesToUnitName) {
      const u = findUnit.get(prod.id, row.appliesToUnitName.toUpperCase()) as { id: string } | undefined;
      if (!u) {
        skip(r, `tier '${row.productSku}': unit '${row.appliesToUnitName}' not found`);
        continue;
      }
      unitId = u.id;
    }

    const existing = findExisting.get(prod.id, row.channel, row.minQuantity, unitId) as
      | { id: string; active: number } | undefined;
    if (existing) {
      r.matched += 1;
      // Reactivate-or-update: if the existing row is inactive, the user
      // would expect the import to bring it back. Treat that as an update
      // even when updateExisting is off, since otherwise we'd silently
      // leave the catalog in a broken state (incoming row claims active=1
      // but the DB row stays inactive — and we can't INSERT past the UNIQUE).
      const isReactivation = existing.active === 0 && row.active;
      if (opts.updateExisting || isReactivation) {
        r.toUpdate += 1;
        {
          update.run(
            row.unitPricePesewas, row.priority, row.notes ?? null,
            row.active ? 1 : 0,
            opts.actorWorkerId, opts.deviceId, existing.id,
          );
        }
      }
    } else {
      r.toInsert += 1;
      insert.run(
        `pt-${uuidv4()}`, prod.id, row.channel, row.minQuantity,
        row.unitPricePesewas, row.priority,
        row.active ? 1 : 0, row.notes ?? null, unitId,
        opts.actorWorkerId, opts.actorWorkerId, opts.deviceId,
      );
    }
  }
  return r;
}

// ---------- customer_price_overrides ----------

function importCustomerPriceOverrides(
  db: DB, rows: CatalogCustomerPriceOverride[], opts: ImportOptions,
): CatalogImportTableReport {
  const r = newReport('customerPriceOverrides', rows.length);
  const findCustByPhone = db.prepare(
    `SELECT id FROM customers WHERE phone = ? AND deleted_at IS NULL`,
  );
  const findProductBySku = db.prepare(
    `SELECT id FROM products WHERE sku = ? AND deleted_at IS NULL`,
  );
  const findUnit = db.prepare(
    `SELECT id FROM product_units WHERE product_id = ? AND unit_name = ?`,
  );
  const findExisting = db.prepare(
    `SELECT id FROM customer_price_overrides
       WHERE customer_id = ? AND product_id = ? AND applies_to_unit_id = ?
         AND COALESCE(channel, '') = COALESCE(?, '')
         AND active = 1`,
  );
  const insert = db.prepare(
    `INSERT INTO customer_price_overrides (
       id, customer_id, product_id, applies_to_unit_id, channel,
       price_pesewas, active, notes,
       created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE customer_price_overrides SET
        price_pesewas = ?, active = ?, notes = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_by = ?, device_id = ?
      WHERE id = ?`,
  );

  for (const row of rows) {
    if (row.channel && !VALID_CHANNELS.has(row.channel)) {
      skip(r, `override: invalid channel '${row.channel}'`); continue;
    }
    if (!Number.isInteger(row.pricePesewas) || row.pricePesewas <= 0) {
      skip(r, `override '${row.customerPhone}/${row.productSku}': pricePesewas must be positive`); continue;
    }
    const phone = normalizePhone(row.customerPhone);
    if (!phone) { skip(r, `override: invalid customer phone '${row.customerPhone}'`); continue; }
    const cust = findCustByPhone.get(phone) as { id: string } | undefined;
    if (!cust) { skip(r, `override: customer '${row.customerPhone}' not found`); continue; }
    const prod = findProductBySku.get(row.productSku) as { id: string } | undefined;
    if (!prod) { skip(r, `override: product '${row.productSku}' not found`); continue; }
    const unit = findUnit.get(prod.id, row.unitName.toUpperCase()) as { id: string } | undefined;
    if (!unit) { skip(r, `override: unit '${row.productSku}/${row.unitName}' not found`); continue; }

    const existing = findExisting.get(cust.id, prod.id, unit.id, row.channel) as { id: string } | undefined;
    if (existing) {
      r.matched += 1;
      if (opts.updateExisting) {
        r.toUpdate += 1;
        {
          update.run(
            row.pricePesewas, row.active ? 1 : 0, row.notes ?? null,
            opts.actorWorkerId, opts.deviceId, existing.id,
          );
        }
      }
    } else {
      r.toInsert += 1;
      insert.run(
        `cpo-${uuidv4()}`, cust.id, prod.id, unit.id, row.channel ?? null,
        row.pricePesewas, row.active ? 1 : 0, row.notes ?? null,
        opts.actorWorkerId, opts.actorWorkerId, opts.deviceId,
      );
    }
  }
  return r;
}

// ---------- helpers ----------

function newReport(table: CatalogTable, inFile: number): CatalogImportTableReport {
  return { table, inFile, toInsert: 0, matched: 0, toUpdate: 0, skipped: 0, warnings: [] };
}

function skip(r: CatalogImportTableReport, reason: string): void {
  r.skipped += 1;
  if (r.warnings.length < MAX_WARNINGS_PER_TABLE) r.warnings.push(reason);
}

// Like skip(), but for rows that ARE written (with some degraded field).
// Adds an explanation to warnings without inflating the skipped count.
function warn(r: CatalogImportTableReport, reason: string): void {
  if (r.warnings.length < MAX_WARNINGS_PER_TABLE) r.warnings.push(reason);
}
