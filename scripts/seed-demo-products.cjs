#!/usr/bin/env node
// scripts/seed-demo-products.cjs — populate the DB with realistic demo
// products so the units / pricing / stock UI has something to look at.
//
// Each product:
//   - has 2 active units (canonical + bigger purchase unit)
//   - has primary_purchase_unit_id and primary_sale_unit_id set
//   - has cost_price_pesewas set as if a receipt of the bigger unit was logged
//   - has 500 canonical units of opening stock (via stock_movements row)
//
// Idempotent: if a SKU starting with DEMO_ already exists we skip it.
//
// Usage:
//   node scripts/seed-demo-products.cjs
//   node scripts/seed-demo-products.cjs --db /path/to/counter.db
//   node scripts/seed-demo-products.cjs --reset       # delete prior DEMO_* first

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
let dbPath = null;
let resetFirst = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--db') dbPath = argv[++i];
  else if (argv[i] === '--reset') resetFirst = true;
}

function defaultDbPath() {
  // Match what the app picks for userData on each OS.
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'counter', 'counter.db');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', 'counter', 'counter.db');
  }
  return path.join(os.homedir(), '.config', 'counter', 'counter.db');
}

dbPath ||= defaultDbPath();
if (!fs.existsSync(dbPath)) {
  console.error(`DB not found at ${dbPath}. Pass --db /path/to/counter.db`);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// --- Required references ------------------------------------------------

const owner = db
  .prepare(`SELECT id, full_name FROM workers
              WHERE role = 'OWNER' AND deleted_at IS NULL AND active = 1
              ORDER BY created_at ASC LIMIT 1`)
  .get();
if (!owner) {
  console.error('No active OWNER worker — finish first-run setup first.');
  process.exit(1);
}

const supplier = db
  .prepare(`SELECT id, name FROM suppliers
              WHERE active = 1 AND deleted_at IS NULL
              ORDER BY created_at ASC LIMIT 1`)
  .get();
if (!supplier) {
  console.error('No active supplier — add one under Settings → Suppliers first.');
  process.exit(1);
}

const locationId = db.prepare('SELECT id FROM locations LIMIT 1').get()?.id
                || 'loc-main-counter';
const deviceRow = db.prepare("SELECT value FROM device_config WHERE key = 'device_id'").get();
const deviceId = deviceRow?.value || 'seed-script';

console.log(`Seeding into: ${dbPath}`);
console.log(`Owner:    ${owner.full_name} (${owner.id})`);
console.log(`Supplier: ${supplier.name} (${supplier.id})`);
console.log(`Location: ${locationId}`);
console.log('');

// --- Demo products ------------------------------------------------------

const DEMO_PRODUCTS = [
  {
    sku: 'DEMO_COKE_350',
    name: 'Coca-Cola 350ml',
    category: 'SOFT_DRINK',
    brand: 'Coca-Cola',
    packSizeUnits: 24,
    unitVolumeMl: 350,
    isReturnable: true,
    bottleDepositPesewas: 200,   // ₵2.00 / bottle
    // Per-canonical-unit prices (BOTTLE is canonical).
    costPricePesewas: 500,       // ₵5.00 / bottle = ₵120/crate ÷ 24, exact
    walkInPricePesewas: 800,     // ₵8.00 / bottle
    wholesalePricePesewas: 750,  // ₵7.50 / bottle  (≈ ₵180/crate)
    routePricePesewas: 708,      // ₵7.08 / bottle  (≈ ₵170/crate)
    reorderThreshold: 48,        // reorder at <= 2 crates
    reorderQuantity: 120,        // ~5 crates
    shelfLifeDays: 270,
    units: [
      // First entry is canonical (factor 1) and is the default sale unit.
      { name: 'BOTTLE', factor: 1,  pricePesewas: 800,   isSale: true,  isPurchase: false, isPrimarySale: true },
      // CRATE is the default purchase unit — price here is the per-crate sale price.
      { name: 'CRATE',  factor: 24, pricePesewas: 18000, isSale: true,  isPurchase: true,  isPrimaryPurchase: true },
    ],
  },
  {
    sku: 'DEMO_STAR_625',
    name: 'Star Beer 625ml',
    category: 'BEER',
    brand: 'Star',
    packSizeUnits: 12,
    unitVolumeMl: 625,
    isReturnable: true,
    bottleDepositPesewas: 300,    // ₵3 / bottle
    costPricePesewas: 1500,       // ₵15 / bottle = ₵180/crate ÷ 12, exact
    walkInPricePesewas: 2200,     // ₵22 / bottle
    wholesalePricePesewas: 2083,  // ≈ ₵250/crate
    routePricePesewas: 2000,      // = ₵240/crate
    reorderThreshold: 24,
    reorderQuantity: 96,
    shelfLifeDays: 180,
    units: [
      { name: 'BOTTLE', factor: 1,  pricePesewas: 2200,  isSale: true, isPurchase: false, isPrimarySale: true },
      { name: 'CRATE',  factor: 12, pricePesewas: 25000, isSale: true, isPurchase: true,  isPrimaryPurchase: true },
    ],
  },
  {
    sku: 'DEMO_BELAQUA_500',
    name: 'Bel-Aqua water sachet 500ml',
    category: 'WATER',
    brand: 'Bel-Aqua',
    packSizeUnits: 30,
    unitVolumeMl: 500,
    isReturnable: false,
    bottleDepositPesewas: 0,
    costPricePesewas: 40,         // ₵0.40 / sachet = ₵12/bag ÷ 30
    walkInPricePesewas: 100,      // ₵1.00 / sachet
    wholesalePricePesewas: 60,    // ≈ ₵18/bag
    routePricePesewas: 56,        // ≈ ₵16.80/bag
    reorderThreshold: 60,         // reorder at <= 2 bags
    reorderQuantity: 300,         // 10 bags
    shelfLifeDays: 365,
    units: [
      { name: 'SACHET', factor: 1,  pricePesewas: 100,  isSale: true, isPurchase: false, isPrimarySale: true },
      { name: 'BAG',    factor: 30, pricePesewas: 1800, isSale: true, isPurchase: true,  isPrimaryPurchase: true },
    ],
  },
  {
    sku: 'DEMO_SMIRN_275',
    name: 'Smirnoff Ice 275ml',
    category: 'SPIRITS',
    brand: 'Smirnoff',
    packSizeUnits: 24,
    unitVolumeMl: 275,
    isReturnable: false,
    bottleDepositPesewas: 0,
    costPricePesewas: 1000,       // ₵10 / bottle = ₵240/case ÷ 24
    walkInPricePesewas: 1500,     // ₵15 / bottle
    wholesalePricePesewas: 1334,  // ≈ ₵320/case
    routePricePesewas: 1292,      // ≈ ₵310/case
    reorderThreshold: 24,
    reorderQuantity: 72,
    shelfLifeDays: 540,
    units: [
      { name: 'BOTTLE', factor: 1,  pricePesewas: 1500,  isSale: true, isPurchase: false, isPrimarySale: true },
      { name: 'CASE',   factor: 24, pricePesewas: 32000, isSale: true, isPurchase: true,  isPrimaryPurchase: true },
    ],
  },
  {
    sku: 'DEMO_RICE_50KG',
    name: 'Long-grain rice (sold by cup)',
    category: 'NON_BEVERAGE',
    brand: null,
    packSizeUnits: 200,           // 1 bag = ~200 cups (informational)
    unitVolumeMl: null,
    isReturnable: false,
    bottleDepositPesewas: 0,
    costPricePesewas: 210,        // ₵2.10 / cup = ₵420/bag ÷ 200
    walkInPricePesewas: 300,      // ₵3.00 / cup
    wholesalePricePesewas: 240,   // ≈ ₵480/bag
    routePricePesewas: 230,       // ≈ ₵460/bag
    reorderThreshold: 100,        // reorder at <= 0.5 bag
    reorderQuantity: 400,         // 2 bags
    shelfLifeDays: 730,
    units: [
      { name: 'CUP',      factor: 1,   pricePesewas: 300,   isSale: true, isPurchase: false, isPrimarySale: true },
      { name: 'BAG_50KG', factor: 200, pricePesewas: 48000, isSale: true, isPurchase: true,  isPrimaryPurchase: true },
    ],
  },
];

// --- Helpers ------------------------------------------------------------

const uuid = () => crypto.randomUUID();

// --- Optional reset ------------------------------------------------------

if (resetFirst) {
  const existing = db
    .prepare("SELECT id, sku FROM products WHERE sku LIKE 'DEMO_%' AND deleted_at IS NULL")
    .all();
  if (existing.length) {
    console.log(`--reset: clearing ${existing.length} previously-seeded DEMO_* products...`);
    const tx = db.transaction(() => {
      for (const p of existing) {
        // Hard-clean: remove stock_movements, product_units, then the product row.
        db.prepare('DELETE FROM stock_movements WHERE product_id = ?').run(p.id);
        db.prepare('DELETE FROM product_units WHERE product_id = ?').run(p.id);
        db.prepare('DELETE FROM products WHERE id = ?').run(p.id);
      }
    });
    tx();
  }
}

// --- Seed ---------------------------------------------------------------

const OPENING_QTY = 500;

let created = 0;
let skipped = 0;

const insertProduct = db.prepare(`
  INSERT INTO products (
    id, sku, barcode, name, category, brand,
    pack_size_units, unit_volume_ml,
    is_returnable, bottle_deposit_pesewas,
    cost_price_pesewas, walk_in_price_pesewas,
    wholesale_price_pesewas, route_price_pesewas,
    reorder_threshold, reorder_quantity,
    primary_supplier_id, default_lead_time_days, shelf_life_days,
    primary_purchase_unit_id, primary_sale_unit_id,
    created_by, updated_by, device_id
  ) VALUES (
    @id, @sku, NULL, @name, @category, @brand,
    @packSizeUnits, @unitVolumeMl,
    @isReturnable, @bottleDepositPesewas,
    @costPricePesewas, @walkInPricePesewas,
    @wholesalePricePesewas, @routePricePesewas,
    @reorderThreshold, @reorderQuantity,
    @primarySupplierId, @defaultLeadTimeDays, @shelfLifeDays,
    NULL, NULL,
    @actorId, @actorId, @deviceId
  )
`);

const insertUnit = db.prepare(`
  INSERT INTO product_units (
    id, product_id, unit_name, conversion_factor, price_pesewas,
    is_purchase_unit, is_sale_unit, display_order,
    created_by, updated_by, device_id
  ) VALUES (
    @id, @productId, @unitName, @conversionFactor, @pricePesewas,
    @isPurchaseUnit, @isSaleUnit, @displayOrder,
    @actorId, @actorId, @deviceId
  )
`);

const setPrimaryUnits = db.prepare(`
  UPDATE products
     SET primary_purchase_unit_id = @ppu,
         primary_sale_unit_id     = @psu,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         updated_by = @actorId
   WHERE id = @id
`);

const insertOpeningMovement = db.prepare(`
  INSERT INTO stock_movements (
    id, product_id, location_id, quantity, reason_code,
    worker_id, unit_cost_pesewas, total_value_pesewas,
    supervisor_approval_id, notes,
    created_by, updated_by, device_id
  ) VALUES (
    @id, @productId, @locationId, @quantity, 'OPENING_STOCK',
    @actorId, @unitCostPesewas, @totalValuePesewas,
    @actorId, 'Seeded by scripts/seed-demo-products.cjs',
    @actorId, @actorId, @deviceId
  )
`);

const skuExists = db.prepare(
  "SELECT id FROM products WHERE sku = ? AND deleted_at IS NULL"
);

const tx = db.transaction(() => {
  for (const p of DEMO_PRODUCTS) {
    if (skuExists.get(p.sku)) {
      console.log(`  skip  ${p.sku} (already present)`);
      skipped++;
      continue;
    }

    const productId = `prod-${uuid()}`;
    insertProduct.run({
      id: productId,
      sku: p.sku,
      name: p.name,
      category: p.category,
      brand: p.brand,
      packSizeUnits: p.packSizeUnits,
      unitVolumeMl: p.unitVolumeMl,
      isReturnable: p.isReturnable ? 1 : 0,
      bottleDepositPesewas: p.bottleDepositPesewas,
      costPricePesewas: p.costPricePesewas,
      walkInPricePesewas: p.walkInPricePesewas,
      wholesalePricePesewas: p.wholesalePricePesewas,
      routePricePesewas: p.routePricePesewas,
      reorderThreshold: p.reorderThreshold,
      reorderQuantity: p.reorderQuantity,
      primarySupplierId: supplier.id,
      defaultLeadTimeDays: 7,
      shelfLifeDays: p.shelfLifeDays,
      actorId: owner.id,
      deviceId,
    });

    // Insert units, capture canonical (factor=1) and the primary ones.
    let ppuId = null;
    let psuId = null;
    p.units.forEach((u, idx) => {
      const uId = `pu-${uuid()}`;
      insertUnit.run({
        id: uId,
        productId,
        unitName: u.name,
        conversionFactor: u.factor,
        pricePesewas: u.pricePesewas,
        isPurchaseUnit: u.isPurchase ? 1 : 0,
        isSaleUnit: u.isSale ? 1 : 0,
        displayOrder: idx,
        actorId: owner.id,
        deviceId,
      });
      if (u.isPrimaryPurchase) ppuId = uId;
      if (u.isPrimarySale) psuId = uId;
    });
    setPrimaryUnits.run({ id: productId, ppu: ppuId, psu: psuId, actorId: owner.id });

    // Opening stock: 500 canonical units. Line total = qty × per-canonical cost,
    // matching the new exact-arithmetic convention from receiveStock.
    insertOpeningMovement.run({
      id: `sm-${uuid()}`,
      productId,
      locationId,
      quantity: OPENING_QTY,
      unitCostPesewas: p.costPricePesewas,
      totalValuePesewas: OPENING_QTY * p.costPricePesewas,
      actorId: owner.id,
      deviceId,
    });

    console.log(`  add   ${p.sku.padEnd(20)} ${p.units.map((u) => `${u.name}×${u.factor}`).join(' / ')}  → 500 canonical`);
    created++;
  }
});

tx();

console.log('');
console.log(`Done. ${created} created, ${skipped} skipped.`);
console.log('Reload Settings → Products in the app to see them.');
