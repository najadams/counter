// Phase 3b: the sync_outbox capture layer. Append-only event inserts must be
// enqueued (op INSERT, the row's id), with a monotonic, never-reused seq.
// Master/catalog tables must NOT be captured here (that's 3c, pull-down).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { SYNCED_EVENT_TABLES, SYNCED_MASTER_TABLES } from '../src/shared/sync';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true }); // gives us worker dev-counter-1
});
afterEach(() => db.close());

const outboxCount = () =>
  (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox').get() as { c: number }).c;

function insertAudit(id: string): void {
  db.prepare(
    `INSERT INTO audit_log (id, worker_id, action, entity_type, entity_id, device_id)
     VALUES (?, 'dev-counter-1', 'TEST', 'sales', ?, 'host')`,
  ).run(id, 'e-' + id);
}
const seqOf = (rowPk: string) =>
  (db.prepare('SELECT seq FROM sync_outbox WHERE row_pk = ?').get(rowPk) as { seq: number }).seq;

describe('sync_outbox capture', () => {
  it('enqueues an append-only event insert with op INSERT and the row id', () => {
    const before = outboxCount();
    insertAudit('aud-x');
    expect(outboxCount()).toBe(before + 1);
    const row = db.prepare(
      'SELECT table_name, row_pk, op, acked_at FROM sync_outbox ORDER BY seq DESC LIMIT 1',
    ).get();
    expect(row).toMatchObject({ table_name: 'audit_log', row_pk: 'aud-x', op: 'INSERT', acked_at: null });
  });

  it('assigns a strictly increasing seq that is never reused after a delete', () => {
    insertAudit('a');
    insertAudit('b');
    const seqB = seqOf('b');
    db.prepare('DELETE FROM sync_outbox WHERE row_pk = ?').run('b'); // simulate prune of acked rows
    insertAudit('c');
    expect(seqOf('c')).toBeGreaterThan(seqB);
  });

  it('has exactly one capture trigger per SYNCED_EVENT_TABLES entry (no drift)', () => {
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_outbox_%' ORDER BY name",
    ).all() as Array<{ name: string }>).map((r) => r.name);
    const expected = [
      ...SYNCED_EVENT_TABLES.map((t) => `trg_outbox_${t}_ins`),
      ...SYNCED_MASTER_TABLES.flatMap((t) => [`trg_outbox_${t}_mins`, `trg_outbox_${t}_mupd`]),
    ].sort();
    expect(names.sort()).toEqual(expected);
  });

  it('does NOT capture master/catalog tables (deferred to 3c pull-down)', () => {
    const t = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name = 'trg_outbox_products_ins'",
    ).get();
    expect(t).toBeUndefined();
  });
});
