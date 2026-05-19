#!/usr/bin/env node
// scripts/reset-and-seed.cjs — wipe the DB's business data and replant it
// with a realistic set of suppliers, customers, products, units, and
// opening stock. Useful when you want a clean slate to test workflows.
//
// What we KEEP (so first-run wizard doesn't fire again):
//   - workers              (your OWNER + SYSTEM account)
//   - locations            (loc-main-counter)
//   - payment_methods, reason_codes, deletion_reasons  (lookup tables)
//   - schema_migrations    (don't re-migrate)
//   - device_config        (device_id stays stable)
//
// What we WIPE:
//   - sales, sale_lines, sale_payments
//   - customer_payments + allocations, customer_returns + lines
//   - customer_price_overrides
//   - customers
//   - suppliers, supplier_payments + allocations
//   - purchase_orders + lines
//   - products, product_units, pricing_tiers
//   - stock_movements, stocktake_events + lines
//   - shifts, cash_counts, petty_cash_expenses
//   - breakage_log, worker_consumption_log, container_movements
//   - audit_log, pending_receipt_reprints, daily_summaries, period_closes
//   - promotions, pending_orders + lines, routes + stops + runs + delivery_attempts
//   - worker_monthly_performance, pin_attempts
//
// Usage:
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
//     scripts/reset-and-seed.cjs
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
//     scripts/reset-and-seed.cjs --no-wipe       # only seed, don't wipe

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
let dbPath = null;
let wipe = true;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--db') dbPath = argv[++i];
  else if (argv[i] === '--no-wipe') wipe = false;
}

function defaultDbPath() {
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
db.pragma('foreign_keys = OFF'); // temporary, so we can wipe FK-laden tables in any order
db.pragma('journal_mode = WAL');

// --- Find OWNER (we keep them) ------------------------------------------

const owner = db
  .prepare(`SELECT id, full_name FROM workers
              WHERE role = 'OWNER' AND deleted_at IS NULL AND active = 1
              ORDER BY created_at ASC LIMIT 1`)
  .get();
if (!owner) {
  console.error('No active OWNER worker — finish first-run setup first.');
  process.exit(1);
}
const locationId = db.prepare('SELECT id FROM locations LIMIT 1').get()?.id || 'loc-main-counter';
const deviceId = db.prepare("SELECT value FROM device_config WHERE key = 'device_id'").get()?.value
              || 'seed-script';

console.log(`DB:       ${dbPath}`);
console.log(`Owner:    ${owner.full_name} (${owner.id})`);
console.log(`Location: ${locationId}`);
console.log('');

// --- Wipe business data --------------------------------------------------

const WIPE_TABLES = [
  // child rows first (FK-safe even with FKs off, just less brittle)
  'sale_payments',
  'sale_lines',
  'customer_payment_allocations',
  'customer_payments',
  'customer_return_lines',
  'customer_returns',
  'customer_price_overrides',
  'supplier_payment_allocations',
  'supplier_payments',
  'purchase_order_lines',
  'purchase_orders',
  'sales',
  'stocktake_lines',
  'stocktake_events',
  'cash_counts',
  'petty_cash_expenses',
  'breakage_log',
  'worker_consumption_log',
  'container_movements',
  'pending_order_lines',
  'pending_orders',
  'delivery_attempts',
  'route_stops',
  'route_runs',
  'route_customer_links',
  'routes',
  'pending_receipt_reprints',
  'period_closes',
  'daily_summaries',
  'worker_monthly_performance',
  'promotions',
  'pin_attempts',
  'audit_log',
  // now reset shifts (referenced by many of the above)
  'shifts',
  'stock_movements',
  // master rows last
  'pricing_tiers',
  'product_units',
  'products',
  'customers',
  'suppliers',
];

if (wipe) {
  console.log('Wiping business data...');
  const stats = {};
  for (const t of WIPE_TABLES) {
    try {
      const before = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      db.prepare(`DELETE FROM ${t}`).run();
      stats[t] = before;
    } catch (e) {
      // Skip tables that don't exist on this DB (older schemas).
      if (!String(e.message).includes('no such table')) throw e;
    }
  }
  const cleared = Object.entries(stats).filter(([, n]) => n > 0);
  if (cleared.length === 0) console.log('  (already empty)');
  else for (const [t, n] of cleared) console.log(`  ${t.padEnd(36)} ${n} rows`);
  console.log('');
}

db.pragma('foreign_keys = ON'); // re-enable for the seed phase

// --- Helpers -------------------------------------------------------------

const uuid = () => crypto.randomUUID();

// --- Seed: suppliers -----------------------------------------------------

const SUPPLIERS = [
  { name: 'Equatorial Coca-Cola Bottling Co', contact: 'Mr. Mensah', phone: '+233244100100', email: 'orders@ecbc.gh', terms: 14 },
  { name: 'Accra Brewery Ltd',                contact: 'Ms. Owusu',  phone: '+233244200200', email: 'sales@abl.com.gh', terms: 7  },
  { name: 'Bel-Aqua Mineral Water',           contact: 'Mr. Adjei',  phone: '+233244300300', email: 'depot@belaqua.gh', terms: 7  },
  { name: 'Voltic Ghana Ltd',                 contact: null,         phone: '+233244400400', email: null, terms: 14 },
  { name: 'Kasapreko Company Ltd',            contact: 'Aunty Akua', phone: '+233244500500', email: null, terms: 30 },
];

const insSupplier = db.prepare(`
  INSERT INTO suppliers (
    id, name, contact_person, phone, email,
    payment_terms_days, current_balance_pesewas, active,
    created_by, updated_by, device_id
  ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
`);
const supplierIds = {};
for (const s of SUPPLIERS) {
  const id = `sup-${uuid()}`;
  insSupplier.run(
    id, s.name, s.contact, s.phone, s.email,
    s.terms, owner.id, owner.id, deviceId,
  );
  supplierIds[s.name] = id;
}
console.log(`Seeded ${SUPPLIERS.length} suppliers.`);

// --- Seed: customers -----------------------------------------------------

const CUSTOMERS = [
  { name: 'Nana Mensah',           phone: '+233244111111', type: 'WALK_IN_REGULAR', limit: 0,        notes: 'Regular morning customer' },
  { name: 'Kwame Asante',          phone: '+233244222222', type: 'WALK_IN_REGULAR', limit: 50000,    notes: 'Pays end of week' },
  { name: 'Adwoa Boateng',         phone: '+233244333333', type: 'WALK_IN_REGULAR', limit: 30000,    notes: null },
  { name: "Kojo's Bar & Grill",    phone: '+233244444444', type: 'WHOLESALE',       limit: 500000,   notes: 'Bulk every Friday', business: "Kojo's Bar & Grill" },
  { name: 'Akosua Beverages',      phone: '+233244555555', type: 'WHOLESALE',       limit: 1000000,  notes: 'Reseller', business: 'Akosua Beverages Enterprise' },
  { name: 'Star Restaurant',       phone: '+233244666666', type: 'WHOLESALE',       limit: 300000,   notes: null, business: 'Star Restaurant Ltd' },
  { name: 'Auntie Ama (route #1)', phone: '+233244777777', type: 'ROUTE',           limit: 200000,   notes: 'Kaneshie stop' },
  { name: 'Yaw (staff family)',    phone: '+233244888888', type: 'STAFF_FAMILY',    limit: 50000,    notes: "Naj's brother" },
];

const insCustomer = db.prepare(`
  INSERT INTO customers (
    id, display_name, phone, customer_type, business_name,
    credit_limit_pesewas, credit_terms_days, current_balance_pesewas, blocked, notes,
    created_by, updated_by, device_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
`);
const customerIds = {};
for (const c of CUSTOMERS) {
  const id = `cus-${uuid()}`;
  insCustomer.run(
    id, c.name, c.phone, c.type, c.business || null,
    c.limit, c.limit > 0 ? 14 : 0, c.notes,
    owner.id, owner.id, deviceId,
  );
  customerIds[c.name] = id;
}
console.log(`Seeded ${CUSTOMERS.length} customers.`);

// --- Seed: products ------------------------------------------------------
//
// 10 products covering beer / soft drink / water / spirits / mixer /
// non-beverage. Each lists every unit they trade in; canonical (factor 1)
// is the smallest sellable piece. Prices are per CANONICAL unit at the
// top, then per UNIT on each unit row (which is what shows in the till
// when that unit is picked).

const PRODUCTS = [
  {
    sku: 'COKE_350', name: 'Coca-Cola 350ml glass', category: 'SOFT_DRINK', brand: 'Coca-Cola',
    primarySupplier: 'Equatorial Coca-Cola Bottling Co',
    packSize: 24, volumeMl: 350, returnable: true, depositPesewas: 200,
    costPesewas: 500, walkInPesewas: 800, wholesalePesewas: 750, routePesewas: 708,
    reorderThreshold: 48, reorderQty: 120, shelfLifeDays: 270,
    units: [
      { name: 'BOTTLE', factor: 1,  price: 800,   sale: true, purchase: false, primarySale: true },
      { name: 'CRATE',  factor: 24, price: 18000, sale: true, purchase: true,  primaryPurchase: true },
    ],
  },
  {
    sku: 'COKE_PET_500', name: 'Coca-Cola 500ml PET', category: 'SOFT_DRINK', brand: 'Coca-Cola',
    primarySupplier: 'Equatorial Coca-Cola Bottling Co',
    packSize: 12, volumeMl: 500, returnable: false, depositPesewas: 0,
    costPesewas: 700, walkInPesewas: 1000, wholesalePesewas: 900, routePesewas: 875,
    reorderThreshold: 24, reorderQty: 48, shelfLifeDays: 180,
    units: [
      { name: 'BOTTLE', factor: 1,  price: 1000,  sale: true, purchase: false, primarySale: true },
      { name: 'PACK',   factor: 12, price: 11000, sale: true, purchase: true,  primaryPurchase: true },
    ],
  },
  {
    sku: 'STAR_625', name: 'Star Beer 625ml', category: 'BEER', brand: 'Star',
    primarySupplier: 'Accra Brewery Ltd',
    packSize: 12, volumeMl: 625, returnable: true, depositPesewas: 300,
    costPesewas: 1500, walkInPesewas: 2200, wholesalePesewas: 2083, routePesewas: 2000,
    reorderThreshold: 24, reorderQty: 96, shelfLifeDays: 180,
    units: [
      { name: 'BOTTLE', factor: 1,  price: 2200,  sale: true, purchase: false, primarySale: true },
      { name: 'CRATE',  factor: 12, price: 25000, sale: true, purchase: true,  primaryPurchase: true },
    ],
  },
  {
    sku: 'CLUB_625', name: 'Club Lager 625ml', category: 'BEER', brand: 'Club',
    primarySupplier: 'Accra Brewery Ltd',
    packSize: 12, volumeMl: 625, returnable: true, depositPesewas: 300,
    costPesewas: 1400, walkInPesewas: 2100, wholesalePesewas: 1958, routePesewas: 1900,
    reorderThreshold: 24, reorderQty: 96, shelfLifeDays: 180,
    units: [
      { name: 'BOTTLE', factor: 1,  price: 2100,  sale: true, purchase: false, primarySale: true },
      { name: 'CRATE',  factor: 12, price: 23500, sale: true, purchase: true,  primaryPurchase: true },
    ],
  },
  {
    sku: 'MALTA_GUI_330', name: 'Malta Guinness 330ml', category: 'NON_BEVERAGE', brand: 'Guinness',
    primarySupplier: 'Accra Brewery Ltd',
    packSize: 24, volumeMl: 330, returnable: false, depositPesewas: 0,
    costPesewas: 600, walkInPesewas: 900, wholesalePesewas: 800, routePesewas: 770,
    reorderThreshold: 48, reorderQty: 96, shelfLifeDays: 365,
    units: [
      { name: 'BOTTLE', factor: 1,  price: 900,   sale: true, purchase: false, primarySale: true },
      { name: 'CASE',   factor: 24, price: 19000, sale: true, purchase: true,  primaryPurchase: true },
    ],
  },
  {
    sku: 'BELAQUA_500', name: 'Bel-Aqua water sachet 500ml', category: 'WATER', brand: 'Bel-Aqua',
    primarySupplier: 'Bel-Aqua Mineral Water',
    packSize: 30, volumeMl: 500, returnable: false, depositPesewas: 0,
    costPesewas: 40, walkInPesewas: 100, wholesalePesewas: 60, routePesewas: 56,
    reorderThreshold: 60, reorderQty: 300, shelfLifeDays: 365,
    units: [
      { name: 'SACHET', factor: 1,  price: 100,  sale: true, purchase: false, primarySale: true },
      { name: 'BAG',    factor: 30, price: 1800, sale: true, purchase: true,  primaryPurchase: true },
    ],
  },
  {
    sku: 'VOLTIC_1500', name: 'Voltic 1.5L water', category: 'WATER', brand: 'Voltic',
    primarySupplier: 'Voltic Ghana Ltd',
    packSize: 12, volumeMl: 1500, returnable: false, depositPesewas: 0,
    costPesewas: 350, walkInPesewas: 500, wholesalePesewas: 450, routePesewas: 425,
    reorderThreshold: 24, reorderQty: 48, shelfLifeDays: 365,
    units: [
      { name: 'BOTTLE', factor: 1,  price: 500,  sale: true, purchase: false, primarySale: true },
      { name: 'PACK',   factor: 12, price: 5500, sale: true, purchase: true,  primaryPurchase: true },
    ],
  },
  {
    sku: 'SMIRN_275', name: 'Smirnoff Ice 275ml', category: 'SPIRITS', brand: 'Smirnoff',
    primarySupplier: 'Accra Brewery Ltd',
    packSize: 24, volumeMl: 275, returnable: false, depositPesewas: 0,
    costPesewas: 1000, walkInPesewas: 1500, wholesalePesewas: 1334, routePesewas: 1292,
    reorderThreshold: 24, reorderQty: 72, shelfLifeDays: 540,
    units: [
      { name: 'BOTTLE', factor: 1,  price: 1500,  sale: true, purchase: false, primarySale: true },
      { name: 'CASE',   factor: 24, price: 32000, sale: true, purchase: true,  primaryPurchase: true },
    ],
  },
  {
    sku: 'ALOMO_750', name: 'Kasapreko Alomo Bitters 750ml', category: 'SPIRITS', brand: 'Kasapreko',
    primarySupplier: 'Kasapreko Company Ltd',
    packSize: 12, volumeMl: 750, returnable: false, depositPesewas: 0,
    costPesewas: 4500, walkInPesewas: 6000, wholesalePesewas: 5500, routePesewas: 5333,
    reorderThreshold: 12, reorderQty: 24, shelfLifeDays: 730,
    units: [
      { name: 'BOTTLE', factor: 1,  price: 6000,  sale: true, purchase: false, primarySale: true },
      { name: 'CASE',   factor: 12, price: 64000, sale: true, purchase: true,  primaryPurchase: true },
    ],
  },
  {
    sku: 'FAN_MAX_12', name: 'Fan Max ice cream', category: 'NON_BEVERAGE', brand: 'Fan Milk',
    primarySupplier: 'Bel-Aqua Mineral Water', // closest non-beverage supplier in the set
    packSize: 12, volumeMl: 300, returnable: false, depositPesewas: 0,
    // canonical = HALF (1 pack of 6); PACK = 2 halves = 12 ice creams.
    costPesewas: 4900, walkInPesewas: 5200, wholesalePesewas: 5150, routePesewas: 5150,
    reorderThreshold: 6, reorderQty: 20, shelfLifeDays: 120,
    units: [
      { name: 'HALF', factor: 1, price: 5200,  sale: true, purchase: false, primarySale: true },
      { name: 'PACK', factor: 2, price: 10300, sale: true, purchase: true,  primaryPurchase: true },
    ],
  },
];

const insProduct = db.prepare(`
  INSERT INTO products (
    id, sku, barcode, name, category, brand,
    pack_size_units, unit_volume_ml,
    is_returnable, bottle_deposit_pesewas,
    cost_price_pesewas, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
    reorder_threshold, reorder_quantity,
    primary_supplier_id, default_lead_time_days, shelf_life_days,
    primary_purchase_unit_id, primary_sale_unit_id,
    created_by, updated_by, device_id
  ) VALUES (
    @id, @sku, NULL, @name, @category, @brand,
    @packSizeUnits, @unitVolumeMl,
    @isReturnable, @bottleDepositPesewas,
    @costPesewas, @walkInPesewas, @wholesalePesewas, @routePesewas,
    @reorderThreshold, @reorderQty,
    @primarySupplierId, 7, @shelfLifeDays,
    NULL, NULL,
    @actorId, @actorId, @deviceId
  )
`);

const insUnit = db.prepare(`
  INSERT INTO product_units (
    id, product_id, unit_name, conversion_factor, price_pesewas,
    is_purchase_unit, is_sale_unit, display_order,
    created_by, updated_by, device_id
  ) VALUES (
    @id, @productId, @name, @factor, @price,
    @purchase, @sale, @order,
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

const insMovement = db.prepare(`
  INSERT INTO stock_movements (
    id, product_id, location_id, quantity, reason_code,
    worker_id, unit_cost_pesewas, total_value_pesewas,
    supervisor_approval_id, notes,
    created_by, updated_by, device_id
  ) VALUES (
    @id, @productId, @locationId, @quantity, 'OPENING_STOCK',
    @actorId, @unitCost, @totalValue,
    @actorId, 'Seeded by scripts/reset-and-seed.cjs',
    @actorId, @actorId, @deviceId
  )
`);

const OPENING_QTY = 500;

console.log(`Seeding ${PRODUCTS.length} products + units + ${OPENING_QTY}-unit opening stock each...`);

for (const p of PRODUCTS) {
  const productId = `prod-${uuid()}`;
  insProduct.run({
    id: productId,
    sku: p.sku, name: p.name, category: p.category, brand: p.brand,
    packSizeUnits: p.packSize, unitVolumeMl: p.volumeMl,
    isReturnable: p.returnable ? 1 : 0, bottleDepositPesewas: p.depositPesewas,
    costPesewas: p.costPesewas, walkInPesewas: p.walkInPesewas,
    wholesalePesewas: p.wholesalePesewas, routePesewas: p.routePesewas,
    reorderThreshold: p.reorderThreshold, reorderQty: p.reorderQty,
    primarySupplierId: supplierIds[p.primarySupplier] || null,
    shelfLifeDays: p.shelfLifeDays,
    actorId: owner.id, deviceId,
  });

  let ppu = null, psu = null;
  p.units.forEach((u, idx) => {
    const uid = `pu-${uuid()}`;
    insUnit.run({
      id: uid, productId, name: u.name, factor: u.factor, price: u.price,
      purchase: u.purchase ? 1 : 0, sale: u.sale ? 1 : 0, order: idx,
      actorId: owner.id, deviceId,
    });
    if (u.primaryPurchase) ppu = uid;
    if (u.primarySale) psu = uid;
  });
  setPrimaryUnits.run({ id: productId, ppu, psu, actorId: owner.id });

  // Opening stock movement (500 canonical units). total_value uses the
  // exact-arithmetic convention from receiveStock: qty × per-canonical cost.
  insMovement.run({
    id: `sm-${uuid()}`,
    productId, locationId,
    quantity: OPENING_QTY,
    unitCost: p.costPesewas,
    totalValue: OPENING_QTY * p.costPesewas,
    actorId: owner.id, deviceId,
  });

  console.log(`  ${p.sku.padEnd(16)} ${p.units.map((u) => `${u.name}×${u.factor}`).join(' / ')}`);
}

// --- Summary -------------------------------------------------------------

const tot = (q) => db.prepare(q).get().n;
console.log('');
console.log('Summary:');
console.log(`  suppliers:        ${tot('SELECT COUNT(*) AS n FROM suppliers')}`);
console.log(`  customers:        ${tot('SELECT COUNT(*) AS n FROM customers')}`);
console.log(`  products:         ${tot('SELECT COUNT(*) AS n FROM products')}`);
console.log(`  product_units:    ${tot('SELECT COUNT(*) AS n FROM product_units')}`);
console.log(`  stock_movements:  ${tot('SELECT COUNT(*) AS n FROM stock_movements')}`);
const invValue = db.prepare(`
  SELECT COALESCE(SUM(sm.onhand * p.cost_price_pesewas), 0) AS v
  FROM (SELECT product_id, SUM(quantity) AS onhand FROM stock_movements GROUP BY product_id) sm
  JOIN products p ON p.id = sm.product_id
`).get().v;
console.log(`  inventory at cost: ₵${(invValue / 100).toFixed(2)}`);
console.log('');
console.log('Done. Restart `npm run dev` (or hit Cmd+R in the app) to see fresh data.');
