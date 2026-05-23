// scripts/test-votic-flow.ts
//
// End-to-end exercise of the multi-unit product / sale / void / reports
// pipeline using the actual service-layer functions (no SQL shortcuts).
//
// Resets the DB, creates a Votic Big-style product with three units
// (PCS canonical, PACK ×6, CASE ×24), records opening stock, makes three
// WALK_IN sales (one per unit), prints the reports snapshot, then voids
// all three sales and reprints the snapshot.
//
// Run with:  npx tsx scripts/test-votic-flow.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { connect, defaultMigrationsDir } from '../src/main/db/connection.js';
import { runMigrations } from '../src/main/db/migrations.js';
import { runSeed } from '../src/main/db/seed.js';

import { receiveStock } from '../src/main/services/stockReceipts.js';
import { completeSale } from '../src/main/services/sales.js';
import { voidSale } from '../src/main/services/voids.js';
import { openShift } from '../src/main/services/shifts.js';
import {
  getReportsOverview,
  getInventoryReport,
  getMarginReport,
} from '../src/main/services/reports.js';
import { unitsOnHand } from '../src/main/services/stockMovements.js';
import { formatMoney } from '../src/shared/lib/money.js';

import { _setPrinter } from '../src/main/printer/printer.js';

// Silence the receipt printer.
_setPrinter({
  async print() { return { ok: true }; },
});

function devUserDataDir(): string {
  const home = os.homedir();
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Counter');
    case 'win32':
      return path.join(process.env['APPDATA'] ?? home, 'Counter');
    default:
      return path.join(home, '.config', 'Counter');
  }
}

const userData = process.env['COUNTER_USER_DATA'] ?? devUserDataDir();
if (!fs.existsSync(userData)) fs.mkdirSync(userData, { recursive: true });
const dbPath = path.join(userData, 'counter.db');

// Wipe.
for (const ext of ['', '-wal', '-shm']) {
  const p = dbPath + ext;
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

async function main() {
const db = connect({ filePath: dbPath, verbose: false });
runMigrations(db, defaultMigrationsDir());
runSeed(db, { includeDevFixtures: true });

const LOC = 'loc-main-counter';
const DEVICE = 'test-script';
const COUNTER_WORKER = 'dev-counter-1';
const SUPERVISOR = 'dev-supervisor-1';

// db:reset doesn't make an OWNER (the first-run wizard normally does). We add
// one inline so the reports actor + product owner exists for our queries.
const OWNER_ID = 'dev-owner-1';
const bcrypt = (await import('bcryptjs')).default;
db.prepare(
  `INSERT INTO workers (
    id, full_name, phone, role, pin_hash,
    base_salary_pesewas, consumption_allowance_units, active,
    hired_at, created_by, updated_by, device_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  OWNER_ID, 'Dev Owner', '+233555000003', 'OWNER',
  bcrypt.hashSync('0000', 4),
  0, 0, 1,
  '2026-01-01',
  'sys-system', 'sys-system', DEVICE,
);

const supplierId = (db
  .prepare("SELECT id FROM suppliers WHERE active = 1 LIMIT 1")
  .get() as { id: string }).id;

// ---------------------------------------------------------------------------
//  Create Votic Big with three units: PCS / PACK ×6 / CASE ×24
// ---------------------------------------------------------------------------

const productId = `prod-${randomUUID()}`;
// Initial cost is just a placeholder; receiveStock will replace it with the
// weighted-average from the opening-stock receipt below.
db.prepare(
  `INSERT INTO products (
    id, sku, name, category, brand, pack_size_units, unit_volume_ml,
    is_returnable, bottle_deposit_pesewas,
    cost_price_pesewas, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
    reorder_threshold, reorder_quantity, primary_supplier_id,
    primary_purchase_unit_id, primary_sale_unit_id,
    created_by, updated_by, device_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).run(
  productId,
  'VOTIC-BIG',
  'Votic Big',
  'WATER',
  'Voltic',
  24, 1500,
  0, 0,
  // Walk-in: 7.00 / PCS, Wholesale and Route slightly lower per piece.
  500,         // placeholder cost; recomputed on receive
  700,         // walk_in / pcs
  650,         // wholesale / pcs
  620,         // route / pcs
  24, 48,
  supplierId,
  null, null,  // primary unit IDs set below once units exist
  OWNER_ID, OWNER_ID, DEVICE,
);

interface UnitSpec { name: string; factor: number; price: number; purchase: boolean; primarySale?: boolean; primaryPurchase?: boolean }
const unitSpecs: UnitSpec[] = [
  // PCS: canonical, the default sale unit at the till.
  { name: 'PCS',  factor: 1,  price: 700,  purchase: false, primarySale: true },
  // PACK: 6 PCS, sold at 33.00, purchased at 29.00.
  { name: 'PACK', factor: 6,  price: 3300, purchase: true,  primaryPurchase: true },
  // CASE: 24 PCS, sold at 125.00 (~5.21/PCS — bulk discount).
  { name: 'CASE', factor: 24, price: 12500, purchase: true },
];

const unitIds: Record<string, string> = {};
let primaryPurchase: string | null = null;
let primarySale: string | null = null;

for (const [i, u] of unitSpecs.entries()) {
  const id = `pu-${randomUUID()}`;
  unitIds[u.name] = id;
  db.prepare(
    `INSERT INTO product_units (
      id, product_id, unit_name, conversion_factor, price_pesewas,
      is_purchase_unit, is_sale_unit, display_order,
      created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, productId, u.name, u.factor, u.price,
    u.purchase ? 1 : 0, 1, i,
    OWNER_ID, OWNER_ID, DEVICE,
  );
  if (u.primaryPurchase) primaryPurchase = id;
  if (u.primarySale) primarySale = id;
}

db.prepare(
  `UPDATE products SET primary_purchase_unit_id = ?, primary_sale_unit_id = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_by = ?
   WHERE id = ?`,
).run(primaryPurchase, primarySale, OWNER_ID, productId);

console.log(`\n== PRODUCT CREATED ==`);
console.log(`  id:    ${productId}`);
console.log(`  sku:   VOTIC-BIG`);
console.log(`  units: ${unitSpecs.map((u) => `${u.name}×${u.factor}@${formatMoney(u.price)}`).join('  ')}`);
console.log(`  primary purchase unit: PACK`);
console.log(`  primary sale unit:     PCS`);

// ---------------------------------------------------------------------------
//  Opening stock: 5 CASES (= 120 PCS canonical) at 29.00 / PACK
//  We'll receive it as PACKs (more realistic) — 20 packs at 29.00 each.
// ---------------------------------------------------------------------------

const openingResult = receiveStock(db, {
  supplierId: null,
  isOpeningStock: true,
  locationId: LOC,
  workerId: OWNER_ID,
  supervisorApprovalId: OWNER_ID,
  lines: [{
    productId,
    quantity: 20,
    unitId: unitIds['PACK'],
    unitCostPesewas: 2900,
  }],
  notes: 'opening stock for test',
  deviceId: DEVICE,
});

const initialOnHand = unitsOnHand(db, productId, LOC);
const productAfterReceive = db
  .prepare('SELECT cost_price_pesewas FROM products WHERE id = ?')
  .get(productId) as { cost_price_pesewas: number };

console.log(`\n== OPENING STOCK ==`);
console.log(`  received: 20 PACK @ 29.00  (canonical: ${20 * 6} PCS)`);
console.log(`  movements: ${openingResult.movementIds.length}`);
console.log(`  total value: ${formatMoney(openingResult.totalValuePesewas)}`);
console.log(`  on hand:   ${initialOnHand} PCS`);
console.log(`  product.cost_price_pesewas (per PCS): ${productAfterReceive.cost_price_pesewas}  (= ${formatMoney(productAfterReceive.cost_price_pesewas)} per PCS)`);
console.log(`  expected:                              483  (= floor 2900/6) or 484 (round)`);

// ---------------------------------------------------------------------------
//  Open a shift so sales can attach to it
// ---------------------------------------------------------------------------

const shift = openShift(db, {
  workerId: COUNTER_WORKER,
  locationId: LOC,
  openingCashPesewas: 50000,
  deviceId: DEVICE,
  shiftType: 'COUNTER',
});

console.log(`\n== SHIFT OPENED ==  ${shift.shiftId}`);

// ---------------------------------------------------------------------------
//  Three sales, one per unit
// ---------------------------------------------------------------------------

async function makeSale(label: string, unitName: 'PCS' | 'PACK' | 'CASE', qty: number, perUnitPrice: number) {
  const r = await completeSale(db, {
    shiftId: shift.shiftId,
    workerId: COUNTER_WORKER,
    workerName: 'Dev Counter',
    locationId: LOC,
    channel: 'WALK_IN',
    lines: [{
      productId,
      quantity: qty,
      unitId: unitIds[unitName],
      unitPricePesewas: perUnitPrice,
    }],
    paymentMethod: 'CASH',
    cashGivenPesewas: qty * perUnitPrice,
    deviceId: DEVICE,
    shopName: 'TEST SHOP',
  });
  console.log(`\n  ${label}: ${qty} ${unitName} @ ${formatMoney(perUnitPrice)}`);
  console.log(`    sale id:       ${r.saleId}`);
  console.log(`    total:         ${formatMoney(r.totalPesewas)}`);
  const lines = db
    .prepare(
      `SELECT quantity, unit_price_pesewas AS up, unit_cost_pesewas AS uc,
              line_total_pesewas AS lt, margin_pesewas AS m
         FROM sale_lines WHERE sale_id = ?`,
    )
    .all(r.saleId) as Array<{ quantity: number; up: number; uc: number; lt: number; m: number }>;
  for (const l of lines) {
    console.log(`    sale_line:     qty=${l.quantity}  unit_price=${l.up}  unit_cost=${l.uc}  line_total=${l.lt}  margin=${l.m}`);
  }
  console.log(`    on hand now:   ${unitsOnHand(db, productId, LOC)} PCS`);
  return r.saleId;
}

console.log(`\n== SALES ==`);
const saleA = await makeSale('Sale A — 1 CASE', 'CASE', 1, 12500);
const saleB = await makeSale('Sale B — 2 PACK', 'PACK', 2, 3300);
const saleC = await makeSale('Sale C — 5 PCS',  'PCS',  5, 700);

const afterSalesOnHand = unitsOnHand(db, productId, LOC);
console.log(`\n  on hand after sales: ${afterSalesOnHand} PCS  (expected ${initialOnHand - 24 - 12 - 5} = ${initialOnHand} - 24 - 12 - 5)`);

// ---------------------------------------------------------------------------
//  Reports snapshot — BEFORE voids
// ---------------------------------------------------------------------------

function snapshot(label: string) {
  console.log(`\n== REPORTS SNAPSHOT (${label}) ==`);

  const overview = getReportsOverview(db, { actorWorkerId: OWNER_ID, locationId: LOC });
  console.log(`  revenue.todayPesewas:       ${overview.revenue.todayPesewas}  (= ${formatMoney(overview.revenue.todayPesewas)})`);
  console.log(`  revenue.numSalesToday:      ${overview.revenue.numSalesToday}`);
  console.log(`  margin.revenuePesewas:      ${overview.margin.revenuePesewas}  (= ${formatMoney(overview.margin.revenuePesewas)})`);
  console.log(`  margin.cogsPesewas:         ${overview.margin.cogsPesewas}     (= ${formatMoney(overview.margin.cogsPesewas)})`);
  console.log(`  margin.grossMarginPesewas:  ${overview.margin.grossMarginPesewas} (= ${formatMoney(overview.margin.grossMarginPesewas)})`);
  console.log(`  margin.grossMarginBps:      ${overview.margin.grossMarginBps} bps (${(overview.margin.grossMarginBps / 100).toFixed(2)}%)`);
  console.log(`  inventory.totalAtCostPesewas:   ${overview.inventory.totalAtCostPesewas}  (= ${formatMoney(overview.inventory.totalAtCostPesewas)})`);
  console.log(`  inventory.totalAtRetailPesewas: ${overview.inventory.totalAtRetailPesewas}  (= ${formatMoney(overview.inventory.totalAtRetailPesewas)})`);
  console.log(`  inventory.activeSkuCount:       ${overview.inventory.activeSkuCount}`);

  const inv = getInventoryReport(db, { actorWorkerId: OWNER_ID, locationId: LOC });
  const row = inv.rows.find((p) => p.productId === productId);
  if (row) {
    console.log(`  inventory row for VOTIC-BIG:`);
    console.log(`    onHand=${row.unitsOnHand}  costPerUnit=${row.costPerUnitPesewas}  ` +
                `atCost=${row.totalAtCostPesewas} (${formatMoney(row.totalAtCostPesewas)})  ` +
                `atRetail=${row.totalAtRetailPesewas} (${formatMoney(row.totalAtRetailPesewas)})`);
  }

  // today-only margin window — getMarginReport
  const today = new Date().toISOString().slice(0, 10);
  const margin = getMarginReport(db, {
    actorWorkerId: OWNER_ID,
    fromDate: today,
    toDate: today,
  });
  console.log(`  marginReport.totalRevenue:     ${margin.totalRevenuePesewas}  (= ${formatMoney(margin.totalRevenuePesewas)})`);
  console.log(`  marginReport.totalCogs:        ${margin.totalCogsPesewas}     (= ${formatMoney(margin.totalCogsPesewas)})`);
  console.log(`  marginReport.totalMargin:      ${margin.totalMarginPesewas}   (= ${formatMoney(margin.totalMarginPesewas)})`);
}

snapshot('after sales, before voids');

// ---------------------------------------------------------------------------
//  Void all three sales
// ---------------------------------------------------------------------------

console.log(`\n== VOIDS ==`);
for (const [label, id] of [['Sale A', saleA], ['Sale B', saleB], ['Sale C', saleC]] as const) {
  const r = voidSale(db, {
    saleId: id,
    reason: `test void of ${label}`,
    supervisorWorkerId: SUPERVISOR,
    supervisorPin: '9999',
    workerId: COUNTER_WORKER,
    deviceId: DEVICE,
  });
  console.log(`  ${label}: voided  reversalMovements=${r.reversalMovementCount}  onHand=${unitsOnHand(db, productId, LOC)}`);
}

const finalOnHand = unitsOnHand(db, productId, LOC);
console.log(`\n  on hand after voids: ${finalOnHand} PCS  (expected ${initialOnHand})`);
console.log(`  MATCH: ${finalOnHand === initialOnHand ? 'YES' : 'NO'}`);

snapshot('after voids');

db.close();
console.log(`\nDone.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
