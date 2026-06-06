// Phase 3c: HQ-gated master capture + shop-side pull/apply of catalog.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { pullOnce, applyCatalog } from '../src/main/sync/pull';
import { getState } from '../src/main/sync/state';
import type { PullTransport, PullRow } from '../src/shared/sync';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true }); // seeds suppliers/products via SYSTEM
});
afterEach(() => db.close());

const setRole = (role: string) =>
  db.prepare("INSERT OR REPLACE INTO device_config (key, value) VALUES ('sync_role', ?)").run(role);
const outboxFor = (t: string) =>
  (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox WHERE table_name = ?').get(t) as { c: number }).c;

function insertSupplier(id: string): void {
  db.prepare(
    `INSERT INTO suppliers (id, name, payment_terms_days, current_balance_pesewas, active,
       created_by, updated_by, device_id)
     VALUES (?, ?, 0, 0, 1, 'sys-system', 'sys-system', 'host')`,
  ).run(id, 'Supplier ' + id);
}

describe('master capture is HQ-gated (migration 0033)', () => {
  it('does NOT enqueue catalog edits on a shop (sync_role unset)', () => {
    insertSupplier('s-shop');
    expect(outboxFor('suppliers')).toBe(0);
  });

  it('enqueues INSERT and UPDATE on HQ (sync_role=HQ)', () => {
    setRole('HQ');
    insertSupplier('s-hq');
    db.prepare("UPDATE suppliers SET name = 'Renamed' WHERE id = 's-hq'").run();
    const ops = (db.prepare("SELECT op FROM sync_outbox WHERE table_name='suppliers' ORDER BY seq")
      .all() as Array<{ op: string }>).map((r) => r.op);
    expect(ops).toEqual(['INSERT', 'UPDATE']);
  });
});

describe('pull / applyCatalog', () => {
  function aSupplierRow(): Record<string, unknown> {
    return db.prepare('SELECT * FROM suppliers LIMIT 1').get() as Record<string, unknown>;
  }

  it('upserts an incoming catalog row (insert path) without enqueuing on a shop', () => {
    // Use a standalone supplier with no products referencing it, so the delete
    // below isn't blocked by the seed products' primary_supplier_id FK.
    insertSupplier('s-pull');
    const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get('s-pull') as Record<string, unknown>;
    db.prepare('DELETE FROM suppliers WHERE id = ?').run('s-pull');
    expect(db.prepare('SELECT COUNT(*) AS c FROM suppliers WHERE id = ?').get('s-pull')).toEqual({ c: 0 });

    applyCatalog(db, [{ cursor: 1, table: 'suppliers', data: row }]);

    expect(db.prepare('SELECT COUNT(*) AS c FROM suppliers WHERE id = ?').get('s-pull')).toEqual({ c: 1 });
    expect(outboxFor('suppliers')).toBe(0); // applying on a shop never re-enqueues
  });

  it('upserts an incoming catalog row (update path)', () => {
    const row = { ...aSupplierRow(), name: 'From HQ' };
    applyCatalog(db, [{ cursor: 2, table: 'suppliers', data: row }]);
    expect(db.prepare('SELECT name FROM suppliers WHERE id = ?').get(row.id)).toEqual({ name: 'From HQ' });
  });

  it('ignores rows for tables outside the master set', () => {
    expect(() => applyCatalog(db, [{ cursor: 1, table: 'not_a_table', data: { id: 'x' } } as PullRow])).not.toThrow();
  });

  it('pullOnce applies a page and advances the cursor', async () => {
    const row = { ...aSupplierRow(), name: 'Pulled' };
    const transport: PullTransport = {
      fetchCatalog: async (since) =>
        since < 7 ? { rows: [{ cursor: 7, table: 'suppliers', data: row }], cursor: 7 } : { rows: [], cursor: since },
    };
    const res = await pullOnce(db, transport);
    expect(res).toEqual({ applied: 1, cursor: 7 });
    expect(db.prepare('SELECT name FROM suppliers WHERE id = ?').get(row.id)).toEqual({ name: 'Pulled' });
    expect(getState(db, 'pull_cursor')).toBe('7');

    const res2 = await pullOnce(db, transport); // nothing newer
    expect(res2.applied).toBe(0);
  });
});

describe('worker roster sync (migration 0034) unblocks catalog FK', () => {
  function insertWorker(id: string, phone: string): void {
    db.prepare(
      `INSERT INTO workers (id, full_name, phone, role, pin_hash, hired_at, created_by, updated_by, device_id)
       VALUES (?, ?, ?, 'COUNTER', 'x', '2026-01-01T00:00:00Z', 'sys-system', 'sys-system', 'host')`,
    ).run(id, 'W ' + id, phone);
  }

  it('captures worker edits only on HQ', () => {
    insertWorker('w-shop', '+233200000010');
    expect((db.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE table_name='workers'").get() as { c: number }).c).toBe(0);
    db.prepare("INSERT OR REPLACE INTO device_config (key,value) VALUES ('sync_role','HQ')").run();
    insertWorker('w-hq', '+233200000011');
    expect((db.prepare("SELECT COUNT(*) AS c FROM sync_outbox WHERE table_name='workers'").get() as { c: number }).c).toBe(1);
  });

  it('a catalog row authored by an HQ worker applies once that worker is in the batch', () => {
    const sys = db.prepare("SELECT * FROM workers WHERE id='sys-system'").get() as Record<string, unknown>;
    const hqOwner = { ...sys, id: 'hq-owner-1', full_name: 'HQ Owner', phone: '+233200000099', role: 'OWNER', created_by: 'sys-system', updated_by: 'sys-system' };
    const sup = { ...(db.prepare('SELECT * FROM suppliers LIMIT 1').get() as Record<string, unknown>), id: 'sup-hq', created_by: 'hq-owner-1', updated_by: 'hq-owner-1' };

    // Supplier alone fails — its author does not exist on the shop yet.
    expect(() => applyCatalog(db, [{ cursor: 1, table: 'suppliers', data: sup }])).toThrow();

    // Worker + supplier in one batch applies (deferred FK).
    applyCatalog(db, [
      { cursor: 2, table: 'workers', data: hqOwner },
      { cursor: 3, table: 'suppliers', data: sup },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS c FROM workers WHERE id='hq-owner-1'").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM suppliers WHERE id='sup-hq'").get()).toEqual({ c: 1 });
  });
});
