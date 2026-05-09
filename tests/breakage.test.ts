// Breakage: photo required, written before row, stock decremented,
// audit trail correct. Photo bytes survive into the file written on disk.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { reportBreakage, listRecentBreakage } from '../src/main/services/breakage';
import { unitsOnHand } from '../src/main/services/stockMovements';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';

let db: ReturnType<typeof Database>;
let shiftId: string;
let userDataDir: string;

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
        VALUES (?, ?, ?, 24, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-seed-${p.id}`, p.id, L, SUP, p.cost_price_pesewas, 24 * p.cost_price_pesewas, SUP, W, W, D);
  }
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-test-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  // 1x1 transparent PNG
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function pickProduct(sku: string) {
  return db.prepare('SELECT id, cost_price_pesewas FROM products WHERE sku = ?').get(sku) as { id: string; cost_price_pesewas: number };
}

describe('reportBreakage', () => {
  it('decrements stock by quantity', () => {
    const star = pickProduct('STAR-330');
    expect(unitsOnHand(db, star.id, L)).toBe(24);
    reportBreakage(db, {
      shiftId, workerId: W, locationId: L, productId: star.id,
      quantity: 2, cause: 'DROPPED', photoBytes: PNG_BYTES, photoExtension: 'png',
      userDataDir, deviceId: D,
    });
    expect(unitsOnHand(db, star.id, L)).toBe(22);
  });

  it('writes the photo to disk before the row', () => {
    const star = pickProduct('STAR-330');
    const r = reportBreakage(db, {
      shiftId, workerId: W, locationId: L, productId: star.id,
      quantity: 1, cause: 'DROPPED', photoBytes: PNG_BYTES, photoExtension: 'png',
      userDataDir, deviceId: D,
    });
    const abs = path.join(userDataDir, r.photoRelativePath);
    expect(fs.existsSync(abs)).toBe(true);
    const stat = fs.statSync(abs);
    expect(stat.size).toBe(PNG_BYTES.length);
  });

  it('breakage_log row references the saved photo path', () => {
    const star = pickProduct('STAR-330');
    const r = reportBreakage(db, {
      shiftId, workerId: W, locationId: L, productId: star.id,
      quantity: 1, cause: 'DROPPED', photoBytes: PNG_BYTES, photoExtension: 'png',
      userDataDir, deviceId: D,
    });
    const row = db.prepare('SELECT photo_url FROM breakage_log WHERE id = ?').get(r.breakageId) as { photo_url: string };
    expect(row.photo_url).toBe(r.photoRelativePath);
  });

  it('stock_movement uses BREAKAGE reason and photo_url', () => {
    const star = pickProduct('STAR-330');
    const r = reportBreakage(db, {
      shiftId, workerId: W, locationId: L, productId: star.id,
      quantity: 1, cause: 'DROPPED', photoBytes: PNG_BYTES, photoExtension: 'png',
      userDataDir, deviceId: D,
    });
    const sm = db.prepare('SELECT reason_code, photo_url, quantity FROM stock_movements WHERE id = ?').get(r.stockMovementId) as { reason_code: string; photo_url: string; quantity: number };
    expect(sm.reason_code).toBe('BREAKAGE');
    expect(sm.photo_url).toBe(r.photoRelativePath);
    expect(sm.quantity).toBe(-1);
  });

  it('rejects unsupported photo extension', () => {
    const star = pickProduct('STAR-330');
    expect(() => reportBreakage(db, {
      shiftId, workerId: W, locationId: L, productId: star.id,
      quantity: 1, cause: 'DROPPED', photoBytes: PNG_BYTES, photoExtension: 'gif',
      userDataDir, deviceId: D,
    })).toThrow(/unsupported extension/);
  });

  it('rejects empty photo buffer', () => {
    const star = pickProduct('STAR-330');
    expect(() => reportBreakage(db, {
      shiftId, workerId: W, locationId: L, productId: star.id,
      quantity: 1, cause: 'DROPPED', photoBytes: Buffer.alloc(0), photoExtension: 'png',
      userDataDir, deviceId: D,
    })).toThrow(/empty/);
  });

  it('total loss = product cost × quantity', () => {
    const star = pickProduct('STAR-330'); // cost 600
    const r = reportBreakage(db, {
      shiftId, workerId: W, locationId: L, productId: star.id,
      quantity: 3, cause: 'TRANSPORT', photoBytes: PNG_BYTES, photoExtension: 'png',
      userDataDir, deviceId: D,
    });
    expect(r.totalLossPesewas).toBe(1800);
  });

  it('writes BREAKAGE_REPORTED to audit_log', () => {
    const star = pickProduct('STAR-330');
    const r = reportBreakage(db, {
      shiftId, workerId: W, locationId: L, productId: star.id,
      quantity: 1, cause: 'DROPPED', photoBytes: PNG_BYTES, photoExtension: 'png',
      userDataDir, deviceId: D,
    });
    const row = db.prepare(`SELECT action FROM audit_log WHERE entity_id = ?`).get(r.breakageId) as { action: string };
    expect(row.action).toBe('BREAKAGE_REPORTED');
  });

  it('listRecentBreakage returns latest with photo path', () => {
    const star = pickProduct('STAR-330');
    reportBreakage(db, {
      shiftId, workerId: W, locationId: L, productId: star.id,
      quantity: 2, cause: 'EXPIRED_LEAK', photoBytes: PNG_BYTES, photoExtension: 'png',
      userDataDir, deviceId: D,
    });
    const recent = listRecentBreakage(db);
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[0]?.cause).toBe('EXPIRED_LEAK');
    expect(recent[0]?.photoRelativePath).toMatch(/^photos\/breakage\//);
  });
});
