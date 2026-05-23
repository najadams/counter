// Stock receipts: stock incremented, products.cost_price_pesewas updated,
// supervisor required, atomic for multi-line receipts.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { listActiveSuppliers, receiveStock } from '../src/main/services/stockReceipts';
import { unitsOnHand } from '../src/main/services/stockMovements';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
});
afterEach(() => { db.close(); });

function star() { return db.prepare("SELECT id, cost_price_pesewas FROM products WHERE sku = 'STAR-330'").get() as { id: string; cost_price_pesewas: number }; }
function supplierId() { return (db.prepare("SELECT id FROM suppliers LIMIT 1").get() as { id: string }).id; }

describe('listActiveSuppliers', () => {
  it('returns active non-deleted', () => {
    const sups = listActiveSuppliers(db);
    expect(sups.length).toBeGreaterThan(0);
  });
});

describe('receiveStock', () => {
  it('increments stock by quantity', () => {
    const p = star();
    expect(unitsOnHand(db, p.id, L)).toBe(0);
    receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: p.id, quantity: 24, unitCostPesewas: 600 }],
      deviceId: D,
    });
    expect(unitsOnHand(db, p.id, L)).toBe(24);
  });

  it('updates products.cost_price_pesewas to latest received cost', () => {
    const p = star();
    expect(p.cost_price_pesewas).toBe(600);
    receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: p.id, quantity: 24, unitCostPesewas: 650 }], deviceId: D,
    });
    const updated = db.prepare('SELECT cost_price_pesewas FROM products WHERE id = ?').get(p.id) as { cost_price_pesewas: number };
    expect(updated.cost_price_pesewas).toBe(650);
  });

  it('latest-receipt-wins: new receipt at higher price overrides existing cost, ignoring prior inflows', () => {
    // STAR-330 starts seeded with cost_price_pesewas = 600. Pre-seed a
    // bulk opening-stock receipt at the old cost so there's real history
    // for the old weighted-avg model to anchor on. Then a fresh receipt
    // at a higher per-canonical cost should win cleanly, not be diluted.
    const p = star();
    db.prepare(
      `INSERT INTO stock_movements (
        id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id
      ) VALUES (?, ?, ?, 240, 'OPENING_STOCK', ?, 600, 144000, ?, ?, ?, ?)`,
    ).run('sm-history', p.id, L, SUP, SUP, W, W, D);

    receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: p.id, quantity: 24, unitCostPesewas: 800 }],
      deviceId: D,
    });
    const updated = (db.prepare('SELECT cost_price_pesewas FROM products WHERE id = ?').get(p.id) as { cost_price_pesewas: number }).cost_price_pesewas;
    // Old model would have computed (240*600 + 24*800) / (240+24) ≈ 618.
    // New model: cost = THIS receipt's per-canonical = 19200/24 = 800.
    expect(updated).toBe(800);
  });

  it('latest-receipt-wins: receipt in a purchase unit sets cost by larger-unit price ÷ factor', async () => {
    // User receives 10 PACKs at 36.00 (= 3600 pesewas) each; PACK has
    // factor 6. New per-canonical cost should be 3600 / 6 = 600 pesewas,
    // regardless of any prior stock at a different price.
    const owner = 'dev-owner-receipt-test';
    db.prepare(
      `INSERT INTO workers (id, full_name, phone, role, pin_hash,
        base_salary_pesewas, consumption_allowance_units, active,
        hired_at, created_by, updated_by, device_id)
        VALUES (?, ?, ?, 'OWNER', '$2a$04$placeholder', 0, 0, 1,
                '2026-01-01', 'sys-system', 'sys-system', 'seed')`,
    ).run(owner, 'Receipt Test Owner', '+233555000077');

    const voltic = db
      .prepare("SELECT id FROM products WHERE sku = 'VOLTIC-1L'")
      .get() as { id: string };
    // Pre-seed some old-price inflow so weighted-avg would give a different answer.
    db.prepare(
      `INSERT INTO stock_movements (
        id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id
      ) VALUES (?, ?, ?, 120, 'OPENING_STOCK', ?, 483, 57960, ?, ?, ?, ?)`,
    ).run('sm-voltic-old', voltic.id, L, SUP, SUP, W, W, D);

    const { addUnit } = await import('../src/main/services/productUnits');
    const packId = addUnit(db, {
      productId: voltic.id, unitName: 'PACK', conversionFactor: 6,
      pricePesewas: 3300, isPurchaseUnit: true, isSaleUnit: true,
      actorWorkerId: owner, deviceId: D,
    }).unitId;

    receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: voltic.id, quantity: 10, unitId: packId, unitCostPesewas: 3600 }],
      deviceId: D,
    });
    const updated = (db.prepare('SELECT cost_price_pesewas FROM products WHERE id = ?').get(voltic.id) as { cost_price_pesewas: number }).cost_price_pesewas;
    expect(updated).toBe(600);
  });

  it('multi-line same-product receipt uses weighted avg of just THIS receipt', async () => {
    // 10 packs @ 3600 + 5 packs @ 3800 = (36000 + 19000) / (60 + 30) = 611.11 → 611.
    const owner = 'dev-owner-multiline';
    db.prepare(
      `INSERT INTO workers (id, full_name, phone, role, pin_hash,
        base_salary_pesewas, consumption_allowance_units, active,
        hired_at, created_by, updated_by, device_id)
        VALUES (?, ?, ?, 'OWNER', '$2a$04$placeholder', 0, 0, 1,
                '2026-01-01', 'sys-system', 'sys-system', 'seed')`,
    ).run(owner, 'Multiline Test Owner', '+233555000078');

    const voltic = db
      .prepare("SELECT id FROM products WHERE sku = 'VOLTIC-1L'")
      .get() as { id: string };
    const { addUnit } = await import('../src/main/services/productUnits');
    const packId = addUnit(db, {
      productId: voltic.id, unitName: 'PACK', conversionFactor: 6,
      pricePesewas: 3300, isPurchaseUnit: true, isSaleUnit: true,
      actorWorkerId: owner, deviceId: D,
    }).unitId;

    receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [
        { productId: voltic.id, quantity: 10, unitId: packId, unitCostPesewas: 3600 },
        { productId: voltic.id, quantity: 5,  unitId: packId, unitCostPesewas: 3800 },
      ],
      deviceId: D,
    });
    const updated = (db.prepare('SELECT cost_price_pesewas FROM products WHERE id = ?').get(voltic.id) as { cost_price_pesewas: number }).cost_price_pesewas;
    expect(updated).toBe(Math.round((36000 + 19000) / (60 + 30))); // 611
  });

  it('does NOT update cost when same as current', () => {
    const p = star();
    const r = receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: p.id, quantity: 24, unitCostPesewas: 600 }], deviceId: D,
    });
    expect(r.productsUpdated).toBe(0);
  });

  it('multi-line receipt is atomic', () => {
    const p = star();
    const club = db.prepare("SELECT id FROM products WHERE sku = 'CLUB-330'").get() as { id: string };
    const before = (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n;
    expect(() => receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [
        { productId: p.id, quantity: 24, unitCostPesewas: 600 },
        { productId: 'nope', quantity: 12, unitCostPesewas: 100 },
        { productId: club.id, quantity: 24, unitCostPesewas: 650 },
      ],
      deviceId: D,
    })).toThrow();
    const after = (db.prepare('SELECT COUNT(*) AS n FROM stock_movements').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('refuses without supervisor approval', () => {
    // The service requires supervisorApprovalId set; the IPC handler verifies
    // the PIN. Here we exercise the service-level check via the inactive-supplier
    // path and confirm a missing supervisor on a normally-mandatory reason fails.
    const p = star();
    expect(() => receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W,
      supervisorApprovalId: '' as unknown as string,
      lines: [{ productId: p.id, quantity: 24, unitCostPesewas: 600 }],
      deviceId: D,
    })).toThrow(/requires supervisor approval/);
  });

  it('refuses inactive supplier', () => {
    const p = star();
    db.prepare('UPDATE suppliers SET active = 0').run();
    expect(() => receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: p.id, quantity: 24, unitCostPesewas: 600 }], deviceId: D,
    })).toThrow(/inactive|not found/);
  });

  it('writes STOCK_RECEIVED to audit_log', () => {
    const p = star();
    receiveStock(db, {
      supplierId: supplierId(), locationId: L, workerId: W, supervisorApprovalId: SUP,
      lines: [{ productId: p.id, quantity: 24, unitCostPesewas: 600 }], deviceId: D,
    });
    const a = db.prepare(`SELECT action FROM audit_log WHERE action = 'STOCK_RECEIVED'`).get();
    expect(a).toBeDefined();
  });
});
