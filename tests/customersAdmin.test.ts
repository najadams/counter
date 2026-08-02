// Customers admin: any worker can create, phone normalization, dedup,
// supervisor required for block.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  blockCustomer, createCustomer, unblockCustomer, updateCustomer,
} from '../src/main/services/customersAdmin';
import { searchCustomers } from '../src/main/services/customers';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const COUNTER = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const D = 'test-device';

let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
});
afterEach(() => { db.close(); });

describe('createCustomer', () => {
  it('counter staff can create', () => {
    const r = createCustomer(db, {
      displayName: 'Yaw Boateng', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    expect(r.customerId).toMatch(/^cust-/);
    expect(r.alreadyExisted).toBe(false);
  });

  it('normalizes phone before storing', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    const row = db.prepare('SELECT phone FROM customers WHERE id = ?').get(r.customerId) as { phone: string };
    expect(row.phone).toBe('+233244999000');
  });

  it('rejects malformed phone', () => {
    expect(() => createCustomer(db, {
      displayName: 'Y', phone: '12345',
      actorWorkerId: COUNTER, deviceId: D,
    })).toThrow(/invalid phone/);
  });

  it('rejects empty display name', () => {
    expect(() => createCustomer(db, {
      displayName: '   ', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    })).toThrow(/displayName required/);
  });

  it('returns existing customer on duplicate phone (alreadyExisted=true)', () => {
    const a = createCustomer(db, {
      displayName: 'Yaw', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    const b = createCustomer(db, {
      displayName: 'Different name same phone', phone: '+233244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    expect(b.customerId).toBe(a.customerId);
    expect(b.alreadyExisted).toBe(true);
  });

  it('rejects negative credit limit', () => {
    expect(() => createCustomer(db, {
      displayName: 'Y', phone: '0244999000', creditLimitPesewas: -1,
      actorWorkerId: COUNTER, deviceId: D,
    })).toThrow(/non-negative integer/);
  });

  it('audits CUSTOMER_CREATED', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    const a = db.prepare(`SELECT action FROM audit_log WHERE entity_id = ?`).get(r.customerId) as { action: string };
    expect(a.action).toBe('CUSTOMER_CREATED');
  });

  it('immediately findable via searchCustomers', () => {
    createCustomer(db, {
      displayName: 'Yaw Boateng', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    const hits = searchCustomers(db, 'yaw', 5);
    expect(hits.find((h) => h.displayName === 'Yaw Boateng')).toBeDefined();
  });

  it('is searchable by business/company name for the till', () => {
    const created = createCustomer(db, {
      displayName: 'Kwame Mensah', phone: '0244999000', businessName: 'Adams Cold Store',
      actorWorkerId: COUNTER, deviceId: D,
    });
    const hits = searchCustomers(db, 'cold store', 5);
    expect(hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: created.customerId, displayName: 'Kwame Mensah', businessName: 'Adams Cold Store' }),
    ]));
    expect(searchCustomers(db, 'ADAMS', 5)[0]).toMatchObject({ id: created.customerId, businessName: 'Adams Cold Store' });
  });
});

describe('updateCustomer', () => {
  it('updates fields with audit diff', () => {
    const r = createCustomer(db, {
      displayName: 'Yaw', phone: '0244999000',
      creditLimitPesewas: 5000,
      actorWorkerId: COUNTER, deviceId: D,
    });
    updateCustomer(db, {
      customerId: r.customerId,
      fields: { displayName: 'Yaw Boateng', creditLimitPesewas: 10000 },
      actorWorkerId: SUP, deviceId: D,
    });
    const row = db.prepare('SELECT display_name, credit_limit_pesewas FROM customers WHERE id = ?').get(r.customerId) as { display_name: string; credit_limit_pesewas: number };
    expect(row.display_name).toBe('Yaw Boateng');
    expect(row.credit_limit_pesewas).toBe(10000);
    const audit = db.prepare(`SELECT before_value, after_value FROM audit_log WHERE entity_id = ? AND action = 'CUSTOMER_UPDATED'`).get(r.customerId) as { before_value: string; after_value: string };
    const before = JSON.parse(audit.before_value);
    const after = JSON.parse(audit.after_value);
    expect(before.creditLimitPesewas).toBe(5000);
    expect(after.creditLimitPesewas).toBe(10000);
  });

  it('rejects invalid customerType', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    expect(() => updateCustomer(db, {
      customerId: r.customerId,
      fields: { customerType: 'NOPE' as 'WHOLESALE' },
      actorWorkerId: SUP, deviceId: D,
    })).toThrow(/invalid customerType/);
  });

  it('normalizes alternate phone on update', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    updateCustomer(db, {
      customerId: r.customerId,
      fields: { alternatePhone: '0555111222' },
      actorWorkerId: COUNTER, deviceId: D,
    });
    const row = db.prepare('SELECT alternate_phone FROM customers WHERE id = ?').get(r.customerId) as { alternate_phone: string };
    expect(row.alternate_phone).toBe('+233555111222');
  });

  it('allows counter staff to edit basic contact and operating notes', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    updateCustomer(db, {
      customerId: r.customerId,
      fields: {
        displayName: 'Yaw Boateng', businessName: 'Yaw Ventures',
        locationDescription: 'Behind the market', preferredChannel: 'WHOLESALE', notes: 'Call before delivery',
      },
      actorWorkerId: COUNTER, deviceId: D,
    });
    expect(db.prepare(`SELECT display_name, business_name, location_description,
      preferred_channel, notes FROM customers WHERE id = ?`).get(r.customerId)).toEqual({
      display_name: 'Yaw Boateng', business_name: 'Yaw Ventures', location_description: 'Behind the market',
      preferred_channel: 'WHOLESALE', notes: 'Call before delivery',
    });
  });

  it('requires supervisor or above for primary phone and credit-policy changes', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    for (const fields of [
      { phone: '0555000111' },
      { customerType: 'WHOLESALE' as const },
      { creditLimitPesewas: 20_000 },
      { creditTermsDays: 30 },
      { cashOnly: true },
    ]) {
      expect(() => updateCustomer(db, {
        customerId: r.customerId, fields, actorWorkerId: COUNTER, deviceId: D,
      })).toThrow(/requires SUPERVISOR/);
    }
  });

  it('normalizes a supervisor-edited primary phone and rejects duplicates', () => {
    const first = createCustomer(db, {
      displayName: 'First', phone: '0244999000', actorWorkerId: COUNTER, deviceId: D,
    });
    const second = createCustomer(db, {
      displayName: 'Second', phone: '0202000111', actorWorkerId: COUNTER, deviceId: D,
    });
    updateCustomer(db, {
      customerId: first.customerId, fields: { phone: '0555000111' }, actorWorkerId: SUP, deviceId: D,
    });
    expect(db.prepare('SELECT phone FROM customers WHERE id = ?').get(first.customerId)).toEqual({ phone: '+233555000111' });
    expect(() => updateCustomer(db, {
      customerId: first.customerId, fields: { phone: '0202000111' }, actorWorkerId: SUP, deviceId: D,
    })).toThrow(/already uses this phone/);
    expect(db.prepare('SELECT phone FROM customers WHERE id = ?').get(second.customerId)).toEqual({ phone: '+233202000111' });
  });

  it('rejects an empty edited display name', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000', actorWorkerId: COUNTER, deviceId: D,
    });
    expect(() => updateCustomer(db, {
      customerId: r.customerId, fields: { displayName: '   ' }, actorWorkerId: COUNTER, deviceId: D,
    })).toThrow(/displayName required/);
  });
});

describe('block / unblock', () => {
  it('SUPERVISOR can block', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    blockCustomer(db, r.customerId, 'over limit', SUP, D);
    const row = db.prepare('SELECT blocked, blocked_reason FROM customers WHERE id = ?').get(r.customerId) as { blocked: number; blocked_reason: string };
    expect(row.blocked).toBe(1);
    expect(row.blocked_reason).toBe('over limit');
  });

  it('COUNTER cannot block', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    expect(() => blockCustomer(db, r.customerId, 'over limit', COUNTER, D)).toThrow(/not permitted/);
  });

  it('block requires reason', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    expect(() => blockCustomer(db, r.customerId, '   ', SUP, D)).toThrow(/reason required/);
  });

  it('refuses double-block', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    blockCustomer(db, r.customerId, 'r', SUP, D);
    expect(() => blockCustomer(db, r.customerId, 'r', SUP, D)).toThrow(/already blocked/);
  });

  it('unblock clears flag + reason', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    blockCustomer(db, r.customerId, 'r', SUP, D);
    unblockCustomer(db, r.customerId, SUP, D);
    const row = db.prepare('SELECT blocked, blocked_reason FROM customers WHERE id = ?').get(r.customerId) as { blocked: number; blocked_reason: string | null };
    expect(row.blocked).toBe(0);
    expect(row.blocked_reason).toBeNull();
  });

  it('audits BLOCK + UNBLOCK', () => {
    const r = createCustomer(db, {
      displayName: 'Y', phone: '0244999000',
      actorWorkerId: COUNTER, deviceId: D,
    });
    blockCustomer(db, r.customerId, 'r', SUP, D);
    unblockCustomer(db, r.customerId, SUP, D);
    const actions = (db.prepare(`SELECT action FROM audit_log WHERE entity_id = ?`).all(r.customerId) as Array<{ action: string }>).map((a) => a.action);
    expect(actions).toContain('CUSTOMER_BLOCKED');
    expect(actions).toContain('CUSTOMER_UNBLOCKED');
  });
});
