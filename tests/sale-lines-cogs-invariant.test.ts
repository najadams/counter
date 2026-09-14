// Ledger-mode sales whose exact COGS doesn't divide back into a per-unit cost.
//
// With ledger posting on, completeSaleCore replaces a line's COGS with the
// exact moving-average slice while unit_cost_pesewas keeps the rounded
// snapshot. Before 0054 the sale_lines CHECK tied margin to unit_cost, so one
// pesewa of disagreement rolled the whole sale back. These tests pin the
// cases that broke -- crates, odd bottle counts, the sale that empties stock,
// a hand-edited cost -- plus the 0054 upgrade itself and the daily summary
// reading the exact COGS.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { addUnit } from '../src/main/services/productUnits';
import { updateProduct } from '../src/main/services/productsAdmin';
import { receiveStock } from '../src/main/services/stockReceipts';
import { unitsOnHand } from '../src/main/services/stockMovements';
import { setLedgerShadowMode } from '../src/main/services/ledger';
import { generateDailySummary } from '../src/main/services/dailySummaries';
import { getIncomeStatement } from '../src/main/services/managementReports';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const VAT_ON = process.env['COUNTER_VAT'] === '1';
const W = 'dev-counter-1';
const OWNER = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';
const PIN = '9999';
const CRATE_PRICE = 18_000;
const BOTTLE_PRICE = 900;

let db: ReturnType<typeof Database>;
let shiftId: string;
let starId: string;

function openShop(dir: string): void {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, dir);
  runSeed(db, { includeDevFixtures: true });
  db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(OWNER);
  starId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
  shiftId = openShift(db, {
    workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D,
  }).shiftId;
  _setPrinter({ async print() { return { ok: true } as const; } });
}

function sell(unitId: string | null, quantity: number, unitPricePesewas: number) {
  return completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: starId, unitId, quantity, unitPricePesewas }],
    paymentMethod: 'CASH', cashGivenPesewas: quantity * unitPricePesewas, deviceId: D, shopName: 'T',
  });
}

type LineRow = { quantity: number; unitCost: number; lineTotal: number; cogs: number; margin: number };

function saleLines(): LineRow[] {
  return db.prepare(
    `SELECT quantity, unit_cost_pesewas AS unitCost, line_total_pesewas AS lineTotal,
            line_cogs_pesewas AS cogs, margin_pesewas AS margin
       FROM sale_lines ORDER BY created_at, id`,
  ).all() as LineRow[];
}

afterEach(() => { _resetPrinter(); db.close(); });

describe('ledger posting with a non-divisible crate cost', () => {
  let crateId: string;
  let bottleId: string;

  beforeEach(() => {
    openShop(migrationsDir);
    setLedgerShadowMode(db, { locationId: L, enabled: true, actorWorkerId: OWNER, pin: PIN, deviceId: D });
    crateId = addUnit(db, {
      productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: CRATE_PRICE,
      isPurchaseUnit: true, isSaleUnit: true, actorWorkerId: OWNER, deviceId: D,
    }).unitId;
    bottleId = (db.prepare(
      "SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'UNIT'",
    ).get(starId) as { id: string }).id;
    // 10 crates at GHS 100 = 100000 pesewas for 240 bottles: 416.67 per bottle,
    // stored as 417, so 417 x 24 = 10008 per crate against an exact 10000.
    const supplierId = (db.prepare('SELECT id FROM suppliers LIMIT 1').get() as { id: string }).id;
    receiveStock(db, {
      supplierId, locationId: L, workerId: W, supervisorApprovalId: OWNER,
      lines: [{ productId: starId, unitId: crateId, quantity: 10, unitCostPesewas: 10_000 }],
      allowLargeCostSwing: true, deviceId: D,
    });
  });

  it('rings crates, odd bottle counts and the sale that empties stock', async () => {
    await sell(crateId, 1, CRATE_PRICE);
    // 7, 11 and 13 bottles are the quantities where round(cogs / qty) can't
    // reconcile either -- the fix that re-derived unit_cost still failed these.
    await sell(bottleId, 7, BOTTLE_PRICE);
    await sell(bottleId, 11, BOTTLE_PRICE);
    await sell(bottleId, 13, BOTTLE_PRICE);
    await sell(crateId, 3, CRATE_PRICE);
    expect(unitsOnHand(db, starId, L)).toBe(113);
    await sell(bottleId, 113, BOTTLE_PRICE);
    expect(unitsOnHand(db, starId, L)).toBe(0);

    const rows = saleLines();
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row.margin).toBe(row.lineTotal - row.cogs);
    // The rounded snapshot really diverges from the exact slice; without this
    // the test could pass against the pre-0054 CHECK too.
    expect(rows.filter((row) => row.unitCost * row.quantity !== row.cogs).length).toBeGreaterThan(0);
    // Emptying stock flushes the valuation pool: the 10 crates cost exactly GHS 1,000.
    expect(rows.reduce((sum, row) => sum + row.cogs, 0)).toBe(100_000);
  });

  it('a hand-corrected product cost does not block the till', async () => {
    updateProduct(db, {
      productId: starId, fields: { costPricePesewas: 500 }, actorWorkerId: OWNER, deviceId: D,
    });
    await expect(sell(bottleId, 1, BOTTLE_PRICE)).resolves.toBeTruthy();
    await expect(sell(crateId, 1, CRATE_PRICE)).resolves.toBeTruthy();
    for (const row of saleLines()) expect(row.margin).toBe(row.lineTotal - row.cogs);
  });

  it.skipIf(VAT_ON)('daily summary books the exact COGS, matching the income statement', async () => {
    await sell(crateId, 1, CRATE_PRICE);
    const date = new Date().toISOString().slice(0, 10);

    const summary = generateDailySummary(db, { date, locationId: L, workerId: OWNER, deviceId: D });
    const income = getIncomeStatement(db, {
      actorWorkerId: OWNER, deviceId: D, locationId: L, fromDate: date, toDate: date,
    });

    expect(summary.totalCostOfGoodsSoldPesewas).toBe(10_000); // not the rounded 10008
    expect(summary.totalCostOfGoodsSoldPesewas).toBe(income.accrual.cogsPesewas);
    expect(summary.grossMarginPesewas).toBe(CRATE_PRICE - 10_000);
  });
});

describe('0054 upgrade on an existing database', () => {
  const upgradeMigration = '0054_sale_lines_margin_from_cogs.sql';
  let preDir: string;

  beforeEach(() => {
    preDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-pre-0054-'));
    for (const file of fs.readdirSync(migrationsDir)) {
      if (file.endsWith('.sql') && file < upgradeMigration) {
        fs.copyFileSync(path.join(migrationsDir, file), path.join(preDir, file));
      }
    }
    openShop(preDir);
    for (const p of db.prepare('SELECT id, cost_price_pesewas AS cost FROM products').all() as Array<{ id: string; cost: number }>) {
      db.prepare(
        `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
           worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
           created_by, updated_by, device_id)
         VALUES (?, ?, ?, 240, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(`sm-seed-${p.id}`, p.id, L, OWNER, p.cost, 240 * p.cost, OWNER, W, W, D);
    }
  });

  afterEach(() => { fs.rmSync(preDir, { recursive: true, force: true }); });

  it('keeps consistent rows byte-for-byte, repairs a contradictory one, and enforces the new CHECK', async () => {
    const kept = await sell(null, 3, BOTTLE_PRICE);
    const contradictory = await sell(null, 2, BOTTLE_PRICE);
    // The pre-0054 CHECK never looked at line_cogs, so this was storable.
    db.prepare('UPDATE sale_lines SET line_cogs_pesewas = 0 WHERE sale_id = ?').run(contradictory.saleId);

    const byId = (saleId: string) =>
      db.prepare('SELECT * FROM sale_lines WHERE sale_id = ?').get(saleId) as Record<string, number | string | null>;
    const keptBefore = byId(kept.saleId);
    const contradictoryBefore = byId(contradictory.saleId);
    const outboxBefore = (db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number }).n;

    expect(runMigrations(db, migrationsDir).applied).toEqual([upgradeMigration]);

    expect(byId(kept.saleId)).toEqual(keptBefore);
    const repaired = byId(contradictory.saleId);
    expect(repaired).toEqual({
      ...contradictoryBefore,
      line_cogs_pesewas: Number(contradictoryBefore['unit_cost_pesewas']) * 2,
    });
    // The rebuild must not re-queue historic lines for sync.
    expect((db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get() as { n: number }).n).toBe(outboxBefore);
    expect(db.pragma('foreign_key_check')).toEqual([]);

    const objects = (db.prepare(
      "SELECT name FROM sqlite_master WHERE tbl_name = 'sale_lines' AND type IN ('index', 'trigger')",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    expect(objects).toEqual(expect.arrayContaining([
      'idx_sale_lines_sale', 'idx_sale_lines_product', 'idx_sale_lines_tier',
      'idx_sale_lines_kind', 'trg_outbox_sale_lines_ins',
    ]));

    expect(() => db.prepare(
      'UPDATE sale_lines SET margin_pesewas = margin_pesewas + 1 WHERE sale_id = ?',
    ).run(kept.saleId)).toThrow(/CHECK constraint failed/);

    // New sales still insert and still queue for sync.
    await sell(null, 1, BOTTLE_PRICE);
    const queued = db.prepare(
      "SELECT COUNT(*) AS n FROM sync_outbox WHERE table_name = 'sale_lines'",
    ).get() as { n: number };
    expect(queued.n).toBe(3);
  });
});
