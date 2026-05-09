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
