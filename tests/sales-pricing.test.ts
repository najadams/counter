// Sale flow with tiers + discount supervisor gate.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { addTier } from '../src/main/services/pricingTiers';
import {
  DISCOUNT_ABS_THRESHOLD_PESEWAS, DISCOUNT_PERCENT_THRESHOLD_BPS,
  PIN_BCRYPT_ROUNDS,
} from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;
let shiftId: string;
let owner: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  for (const p of db.prepare('SELECT id, cost_price_pesewas FROM products').all() as Array<{ id: string; cost_price_pesewas: number }>) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
        worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
        created_by, updated_by, device_id)
        VALUES (?, ?, ?, 48, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 48 * p.cost_price_pesewas, SUP, W, W, D);
  }
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
  owner = 'dev-owner-1';
  db.prepare(
    `INSERT INTO workers (id, full_name, phone, role, pin_hash,
      base_salary_pesewas, consumption_allowance_units, active,
      hired_at, created_by, updated_by, device_id)
      VALUES (?, ?, ?, 'OWNER', ?, ?, ?, 1, '2026-01-01', 'sys-system', 'sys-system', 'seed')`,
  ).run(owner, 'Dev Owner', '+233555000003', bcrypt.hashSync('1111', PIN_BCRYPT_ROUNDS), 500000, 8);
  _setPrinter({ async print() { return { ok: true } as const; } });
});
afterEach(() => { _resetPrinter(); db.close(); });

function star() { return db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }; }

describe('volume tier auto-applies in completeSale', () => {
  it('applies tier price when quantity meets threshold', async () => {
    const p = star();
    addTier(db, { productId: p.id, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 12, unitPricePesewas: 800 }], // worker passes the channel base price
      paymentMethod: 'CASH', cashGivenPesewas: 9000, deviceId: D, shopName: 'T',
    });
    expect(r.totalPesewas).toBe(12 * 750); // tier wins
    const row = db.prepare('SELECT unit_price_pesewas, applied_tier_id FROM sale_lines WHERE sale_id = ?').get(r.saleId) as { unit_price_pesewas: number; applied_tier_id: string | null };
    expect(row.unit_price_pesewas).toBe(750);
    expect(row.applied_tier_id).toBeTruthy();
  });

  it('does NOT apply tier when quantity below threshold', async () => {
    const p = star();
    addTier(db, { productId: p.id, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 6, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 4800, deviceId: D, shopName: 'T',
    });
    expect(r.totalPesewas).toBe(6 * 800);
    const row = db.prepare('SELECT applied_tier_id FROM sale_lines WHERE sale_id = ?').get(r.saleId) as { applied_tier_id: string | null };
    expect(row.applied_tier_id).toBeNull();
  });

  it('respects channel — wholesale tier skipped on walk-in sale', async () => {
    const p = star();
    addTier(db, { productId: p.id, channel: 'WHOLESALE', minQuantity: 12, unitPricePesewas: 700, actorWorkerId: owner, deviceId: D });
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 12, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 9600, deviceId: D, shopName: 'T',
    });
    expect(r.totalPesewas).toBe(12 * 800);
  });

  it("ALL channel tier applies regardless of sale channel", async () => {
    const p = star();
    addTier(db, { productId: p.id, channel: 'ALL', minQuantity: 12, unitPricePesewas: 720, actorWorkerId: owner, deviceId: D });
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 12, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 8640, deviceId: D, shopName: 'T',
    });
    expect(r.totalPesewas).toBe(12 * 720);
  });

  it('does NOT increase price (worker selling below tier price stays below)', async () => {
    const p = star();
    addTier(db, { productId: p.id, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 12, unitPricePesewas: 700 }], // worker quoted 700 (lower than tier)
      paymentMethod: 'CASH', cashGivenPesewas: 8400, deviceId: D, shopName: 'T',
    });
    expect(r.totalPesewas).toBe(12 * 700);
    const row = db.prepare('SELECT applied_tier_id FROM sale_lines WHERE sale_id = ?').get(r.saleId) as { applied_tier_id: string | null };
    expect(row.applied_tier_id).toBeNull(); // tier did NOT apply because worker price was already lower
  });

  it("audit's appliedTierCount counts tiers applied", async () => {
    const p = star();
    addTier(db, { productId: p.id, channel: 'WALK_IN', minQuantity: 12, unitPricePesewas: 750, actorWorkerId: owner, deviceId: D });
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 12, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 9000, deviceId: D, shopName: 'T',
    });
    const audit = db.prepare(`SELECT after_value FROM audit_log WHERE entity_id = ? AND action = 'SALE_COMPLETED'`).get(r.saleId) as { after_value: string };
    const after = JSON.parse(audit.after_value);
    expect(after.appliedTierCount).toBe(1);
  });
});

describe('discount supervisor gate', () => {
  it('small discount (under threshold) accepted by counter alone', async () => {
    const p = star();
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
      discountPesewas: 50, discountReason: 'regular',
      paymentMethod: 'CASH', cashGivenPesewas: 750, deviceId: D, shopName: 'T',
    });
    expect(r.totalPesewas).toBe(750);
  });

  it('discount above absolute threshold WITHOUT supervisor → rejected', async () => {
    const p = star();
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
      discountPesewas: 300, discountReason: 'big customer',
      paymentMethod: 'CASH', cashGivenPesewas: 500, deviceId: D, shopName: 'T',
    })).rejects.toThrow(/requires supervisor approval/);
  });

  it('discount above percent threshold on big subtotal WITHOUT supervisor → rejected', async () => {
    const p = star();
    // subtotal = 12 * 800 = 9600. 5% = 480. Discount 600 > 480.
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 12, unitPricePesewas: 800 }],
      discountPesewas: 600, discountReason: 'whole crate',
      paymentMethod: 'CASH', cashGivenPesewas: 9000, deviceId: D, shopName: 'T',
    })).rejects.toThrow(/requires supervisor approval/);
  });

  it('discount above threshold WITH valid supervisor → accepted', async () => {
    const p = star();
    const r = await completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
      discountPesewas: 300, discountReason: 'big customer',
      supervisorWorkerId: SUP, supervisorPin: '9999',
      paymentMethod: 'CASH', cashGivenPesewas: 500, deviceId: D, shopName: 'T',
    });
    expect(r.totalPesewas).toBe(500);
    const audit = db.prepare(`SELECT after_value FROM audit_log WHERE entity_id = ? AND action = 'DISCOUNT_APPLIED'`).get(r.saleId) as { after_value: string };
    const after = JSON.parse(audit.after_value);
    expect(after.discountPesewas).toBe(300);
    expect(after.supervisorWorkerId).toBe(SUP);
  });

  it('discount with WRONG supervisor PIN → rejected', async () => {
    const p = star();
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
      discountPesewas: 300, discountReason: 'big customer',
      supervisorWorkerId: SUP, supervisorPin: '0000',
      paymentMethod: 'CASH', cashGivenPesewas: 500, deviceId: D, shopName: 'T',
    })).rejects.toThrow(/PIN check failed/);
  });

  it('discount with non-supervisor "approver" → rejected', async () => {
    const p = star();
    await expect(completeSale(db, {
      shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
      lines: [{ productId: p.id, quantity: 1, unitPricePesewas: 800 }],
      discountPesewas: 300, discountReason: 'big customer',
      supervisorWorkerId: W, supervisorPin: '1234',
      paymentMethod: 'CASH', cashGivenPesewas: 500, deviceId: D, shopName: 'T',
    })).rejects.toThrow(/COUNTER cannot approve/);
  });

  it('threshold math sanity', () => {
    expect(DISCOUNT_PERCENT_THRESHOLD_BPS).toBe(500);
    expect(DISCOUNT_ABS_THRESHOLD_PESEWAS).toBe(200);
  });
});
