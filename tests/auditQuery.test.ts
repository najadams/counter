// Audit log read API: entity-ID → name resolution. The viewer is forensic
// (OWNER/FOUNDER reading "who voided that sale" hours/days later), so raw
// UUIDs are useless in the UI. listAuditEntries enriches the result with
// entityName + a global idNames map.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { logAudit } from '../src/main/db/audit';
import { listAuditEntries } from '../src/main/services/auditQuery';
import { PIN_BCRYPT_ROUNDS } from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const W = 'dev-counter-1';
const DEVICE = 'test-device';

let db: ReturnType<typeof Database>;
let ownerId: string;
let customerId: string;
let starId: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });

  // Need an OWNER to call listAuditEntries (only OWNER/FOUNDER allowed).
  ownerId = 'dev-owner-1';
  db.prepare(
    `INSERT INTO workers (id, full_name, phone, role, pin_hash,
      base_salary_pesewas, consumption_allowance_units, active,
      hired_at, created_by, updated_by, device_id)
      VALUES (?, ?, ?, 'OWNER', ?, 0, 0, 1, '2026-01-01', 'sys-system', 'sys-system', 'seed')`,
  ).run(ownerId, 'Aba Owner', '+233555000300', bcrypt.hashSync('1111', PIN_BCRYPT_ROUNDS));

  customerId = 'cu-test-1';
  db.prepare(
    `INSERT INTO customers (id, display_name, phone, customer_type,
      current_balance_pesewas, credit_limit_pesewas, blocked,
      empties_owed_count, created_by, updated_by, device_id)
      VALUES (?, ?, ?, 'WALK_IN_REGULAR', 0, 100000, 0, 0, ?, ?, ?)`,
  ).run(customerId, 'Yaa Customer', '+233555000301', W, W, DEVICE);

  starId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
});

afterEach(() => { db.close(); });

describe('listAuditEntries — name resolution', () => {
  it('attaches entityName for customers / workers / products / suppliers', () => {
    // Log one entry per supported entity type.
    logAudit(db, {
      workerId: W, action: 'CUSTOMER_CREATED',
      entityType: 'customers', entityId: customerId,
      afterValue: { displayName: 'Yaa Customer' },
      deviceId: DEVICE,
    });
    logAudit(db, {
      workerId: W, action: 'WORKER_UPDATED',
      entityType: 'workers', entityId: W,
      afterValue: {},
      deviceId: DEVICE,
    });
    logAudit(db, {
      workerId: W, action: 'PRODUCT_UPDATED',
      entityType: 'products', entityId: starId,
      afterValue: {},
      deviceId: DEVICE,
    });

    const r = listAuditEntries(db, ownerId, {});
    const cust = r.entries.find((e) => e.entityType === 'customers');
    const worker = r.entries.find((e) => e.entityType === 'workers');
    const prod = r.entries.find((e) => e.entityType === 'products');

    expect(cust?.entityName).toBe('Yaa Customer');
    expect(worker?.entityName).toBe('Dev Counter');
    expect(prod?.entityName).toBe('Star Beer 330ml');
  });

  it('returns idNames covering IDs embedded in JSON values (customerId, workerId)', () => {
    // Mirror what completeSale-credit / customerCredit.recordCustomerPayment
    // actually write: an after_value JSON with `customerId` and `workerId`
    // fields pointing at UUIDs the renderer can't read at a glance.
    logAudit(db, {
      workerId: W, action: 'CUSTOMER_PAYMENT_RECORDED',
      entityType: 'customer_payments', entityId: 'cp-abc',
      afterValue: {
        customerId,
        workerId: W,
        supervisorWorkerId: ownerId,
        amountPesewas: 5000,
      },
      deviceId: DEVICE,
    });

    const r = listAuditEntries(db, ownerId, {});
    expect(r.idNames[customerId]).toBe('Yaa Customer');
    expect(r.idNames[W]).toBe('Dev Counter');
    expect(r.idNames[ownerId]).toBe('Aba Owner');
    // entity_type 'customer_payments' isn't a resolvable kind → entityName null
    expect(r.entries[0]!.entityName).toBeNull();
  });

  it('returns empty idNames map when no resolvable IDs are in entityId or JSON', () => {
    // entity_type 'shifts' isn't a resolvable kind, after_value has only
    // a number, and the audit row's a.worker_id is resolved separately as
    // workerName (not in idNames). Net: idNames should be empty.
    logAudit(db, {
      workerId: W, action: 'SHIFT_OPENED',
      entityType: 'shifts', entityId: 'sh-xyz',
      afterValue: { openingCashPesewas: 5000 },
      deviceId: DEVICE,
    });
    const r = listAuditEntries(db, ownerId, {});
    expect(r.idNames).toEqual({});
    // workerName still resolved on the row itself.
    expect(r.entries[0]!.workerName).toBe('Dev Counter');
  });

  it('blocks non-OWNER readers', () => {
    expect(() => listAuditEntries(db, W, {})).toThrow(/OWNER\/FOUNDER only/);
  });
});
