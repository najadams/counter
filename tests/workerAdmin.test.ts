// Worker admin: add, deactivate, terminate, change PIN, reset PIN.
// Role gating, PIN validation, audit trail.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  addWorker, changePin, deactivateWorker, listWorkersForAdmin,
  reactivateWorker, resetPin, terminateWorker,
} from '../src/main/services/workerAdmin';
import { verifyPin } from '../src/main/services/workers';
import { PIN_BCRYPT_ROUNDS, PIN_MAX_ATTEMPTS } from '../src/shared/lib/constants';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

const COUNTER = 'dev-counter-1';
const SUP = 'dev-supervisor-1';
const D = 'test-device';

let db: ReturnType<typeof Database>;
let owner: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  // Add an OWNER for admin-permitted operations.
  owner = 'dev-owner-1';
  const hash = bcrypt.hashSync('1111', PIN_BCRYPT_ROUNDS);
  db.prepare(
    `INSERT INTO workers (id, full_name, phone, role, pin_hash,
      base_salary_pesewas, consumption_allowance_units, active,
      hired_at, created_by, updated_by, device_id)
      VALUES (?, ?, ?, 'OWNER', ?, ?, ?, 1, ?, 'sys-system', 'sys-system', 'seed')`,
  ).run(owner, 'Dev Owner', '+233555000003', hash, 500000, 8, '2026-01-01');
});
afterEach(() => { db.close(); });

describe('addWorker', () => {
  it('OWNER can add a worker', () => {
    const r = addWorker(db, {
      fullName: 'New Hire', phone: '0244555111', role: 'COUNTER', pin: '5678',
      actorWorkerId: owner, deviceId: D,
    });
    expect(r.workerId).toMatch(/^w-/);
    const auth = verifyPin(db, r.workerId, '5678', D);
    expect(auth.ok).toBe(true);
  });

  it('SUPERVISOR cannot add a worker', () => {
    expect(() => addWorker(db, {
      fullName: 'New Hire', phone: '0244555111', role: 'COUNTER', pin: '5678',
      actorWorkerId: SUP, deviceId: D,
    })).toThrow(/not permitted/);
  });

  it('COUNTER cannot add a worker', () => {
    expect(() => addWorker(db, {
      fullName: 'New Hire', phone: '0244555111', role: 'COUNTER', pin: '5678',
      actorWorkerId: COUNTER, deviceId: D,
    })).toThrow(/not permitted/);
  });

  it('rejects malformed phone', () => {
    expect(() => addWorker(db, {
      fullName: 'X', phone: '12345', role: 'COUNTER', pin: '5678',
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/invalid phone/);
  });

  it('rejects non-digit PIN', () => {
    expect(() => addWorker(db, {
      fullName: 'X', phone: '0244555111', role: 'COUNTER', pin: 'abcd',
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/4–6 digits/);
  });

  it('rejects PIN too short or too long', () => {
    expect(() => addWorker(db, {
      fullName: 'X', phone: '0244555111', role: 'COUNTER', pin: '123',
      actorWorkerId: owner, deviceId: D,
    })).toThrow();
    expect(() => addWorker(db, {
      fullName: 'X', phone: '0244555111', role: 'COUNTER', pin: '1234567',
      actorWorkerId: owner, deviceId: D,
    })).toThrow();
  });

  it('rejects duplicate phone', () => {
    addWorker(db, {
      fullName: 'A', phone: '0244555111', role: 'COUNTER', pin: '5678',
      actorWorkerId: owner, deviceId: D,
    });
    expect(() => addWorker(db, {
      fullName: 'B', phone: '0244555111', role: 'DRIVER', pin: '6789',
      actorWorkerId: owner, deviceId: D,
    })).toThrow(/already exists/);
  });

  it('writes WORKER_ADDED to audit_log', () => {
    const r = addWorker(db, {
      fullName: 'X', phone: '0244555111', role: 'COUNTER', pin: '5678',
      actorWorkerId: owner, deviceId: D,
    });
    const a = db.prepare(`SELECT action FROM audit_log WHERE entity_id = ?`).get(r.workerId) as { action: string };
    expect(a.action).toBe('WORKER_ADDED');
  });
});

describe('deactivateWorker / reactivateWorker', () => {
  it('OWNER can deactivate a worker', () => {
    deactivateWorker(db, COUNTER, owner, D);
    const r = db.prepare('SELECT active FROM workers WHERE id = ?').get(COUNTER) as { active: number };
    expect(r.active).toBe(0);
  });

  it('cannot deactivate yourself', () => {
    expect(() => deactivateWorker(db, owner, owner, D)).toThrow(/yourself/);
  });

  it('cannot deactivate SYSTEM', () => {
    expect(() => deactivateWorker(db, 'sys-system', owner, D)).toThrow(/SYSTEM/);
  });

  it('reactivate restores active=1', () => {
    deactivateWorker(db, COUNTER, owner, D);
    reactivateWorker(db, COUNTER, owner, D);
    const r = db.prepare('SELECT active FROM workers WHERE id = ?').get(COUNTER) as { active: number };
    expect(r.active).toBe(1);
  });

  it('reactivate refuses terminated workers', () => {
    terminateWorker(db, COUNTER, 'left', owner, D);
    expect(() => reactivateWorker(db, COUNTER, owner, D)).toThrow(/terminated/);
  });
});

describe('terminateWorker', () => {
  it('sets terminated_at + reason + active=0', () => {
    terminateWorker(db, COUNTER, 'resigned', owner, D);
    const r = db.prepare('SELECT terminated_at, termination_reason, active FROM workers WHERE id = ?').get(COUNTER) as { terminated_at: string; termination_reason: string; active: number };
    expect(r.terminated_at).toBeTruthy();
    expect(r.termination_reason).toBe('resigned');
    expect(r.active).toBe(0);
  });

  it('terminated worker cannot log in', () => {
    terminateWorker(db, COUNTER, 'fired', owner, D);
    const r = verifyPin(db, COUNTER, '1234', D);
    expect(r.ok).toBe(false);
  });

  it('refuses without reason', () => {
    expect(() => terminateWorker(db, COUNTER, '', owner, D)).toThrow(/reason required/);
  });
});

describe('changePin', () => {
  it('verifies old PIN', () => {
    expect(() => changePin(db, COUNTER, '0000', '5555', D)).toThrow(/old PIN does not match/);
  });

  it('changes PIN with correct old PIN', () => {
    changePin(db, COUNTER, '1234', '5555', D);
    expect(verifyPin(db, COUNTER, '1234', D).ok).toBe(false);
    expect(verifyPin(db, COUNTER, '5555', D).ok).toBe(true);
  });

  it('rejects non-digit new PIN', () => {
    expect(() => changePin(db, COUNTER, '1234', 'abcd', D)).toThrow(/4–6 digits/);
  });
});

describe('resetPin', () => {
  it('OWNER can reset', () => {
    resetPin(db, COUNTER, '7777', owner, D);
    expect(verifyPin(db, COUNTER, '7777', D).ok).toBe(true);
  });

  it('SUPERVISOR can reset', () => {
    resetPin(db, COUNTER, '7777', SUP, D);
    expect(verifyPin(db, COUNTER, '7777', D).ok).toBe(true);
  });

  it('COUNTER cannot reset', () => {
    expect(() => resetPin(db, SUP, '7777', COUNTER, D)).toThrow(/not permitted/);
  });

  it('clears active lockouts on the worker', () => {
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) verifyPin(db, COUNTER, '0000', D);
    let auth = verifyPin(db, COUNTER, '1234', D);
    expect(auth.ok).toBe(false); // locked
    resetPin(db, COUNTER, '7777', owner, D);
    auth = verifyPin(db, COUNTER, '7777', D);
    expect(auth.ok).toBe(true);
  });
});

describe('listWorkersForAdmin', () => {
  it('excludes SYSTEM and deleted', () => {
    const list = listWorkersForAdmin(db);
    expect(list.find((w) => w.id === 'sys-system')).toBeUndefined();
    expect(list.length).toBeGreaterThan(0);
  });
});
