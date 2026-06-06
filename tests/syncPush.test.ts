// Phase 3b: the shop-side push worker. Drains sync_outbox to an injected
// transport, acking only what the (fake) central store confirms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { pushOnce } from '../src/main/sync/push';
import { collectBatch } from '../src/main/sync/outbox';
import type { SyncTransport, PushBatch } from '../src/shared/sync';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
});
afterEach(() => db.close());

function insertAudit(id: string): void {
  db.prepare(
    `INSERT INTO audit_log (id, worker_id, action, entity_type, entity_id, device_id)
     VALUES (?, 'dev-counter-1', 'TEST', 'sales', ?, 'host')`,
  ).run(id, 'e-' + id);
}
const unacked = () =>
  (db.prepare('SELECT COUNT(*) AS c FROM sync_outbox WHERE acked_at IS NULL').get() as { c: number }).c;

/** A fake central store: idempotent upsert by (shop, table, id); acks the max
 *  seq it has ever seen. Records the batches it received. */
function fakeCentral() {
  const seen = new Map<string, Set<string>>();
  const batches: PushBatch[] = [];
  let maxSeq = 0;
  const transport: SyncTransport = {
    async send(batch) {
      batches.push(batch);
      let s = seen.get(batch.shopId);
      if (!s) { s = new Set(); seen.set(batch.shopId, s); }
      for (const r of batch.rows) {
        s.add(`${r.table}:${String((r.data as { id: string }).id)}`);
        if (r.seq > maxSeq) maxSeq = r.seq;
      }
      return { ackedSeq: maxSeq };
    },
  };
  return { transport, batches, seen };
}

describe('push worker', () => {
  it('hydrates outbox rows with the full source record', () => {
    insertAudit('a');
    const rows = collectBatch(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ table: 'audit_log', op: 'INSERT' });
    expect((rows[0]!.data as { id: string }).id).toBe('a');
  });

  it('pushes pending rows, acks them, and is a no-op when caught up', async () => {
    insertAudit('a'); insertAudit('b'); insertAudit('c');
    const central = fakeCentral();
    const r1 = await pushOnce(db, 'shop-osu', central.transport);
    expect(r1.pushed).toBe(3);
    expect(unacked()).toBe(0);
    expect(central.seen.get('shop-osu')?.size).toBe(3);

    const r2 = await pushOnce(db, 'shop-osu', central.transport);
    expect(r2).toEqual({ pushed: 0, ackedSeq: null });
    expect(central.batches).toHaveLength(1); // nothing sent the second time
  });

  it('does not ack when the transport fails; a later run drains', async () => {
    insertAudit('a'); insertAudit('b');
    const failing: SyncTransport = { send: () => Promise.reject(new Error('offline')) };
    await expect(pushOnce(db, 's', failing)).rejects.toThrow('offline');
    expect(unacked()).toBe(2); // still pending

    const central = fakeCentral();
    await pushOnce(db, 's', central.transport);
    expect(unacked()).toBe(0);
  });

  it('records push state for the health banner', async () => {
    insertAudit('a');
    const central = fakeCentral();
    await pushOnce(db, 's', central.transport);
    const acked = db.prepare("SELECT value FROM sync_state WHERE key='push_last_acked_seq'").get() as { value: string } | undefined;
    expect(Number(acked?.value)).toBeGreaterThan(0);
    expect(db.prepare("SELECT value FROM sync_state WHERE key='last_push_at'").get()).toBeDefined();
  });

  it('re-sending a batch is idempotent on the central side', async () => {
    insertAudit('a');
    const central = fakeCentral();
    const batch: PushBatch = { shopId: 's', rows: collectBatch(db) };
    await central.transport.send(batch);
    await central.transport.send(batch); // duplicate delivery
    expect(central.seen.get('s')?.size).toBe(1); // no double-count
  });

  it('clears the queue when a pending row has no source (no wedge)', async () => {
    // A phantom outbox entry whose source row does not exist.
    db.prepare("INSERT INTO sync_outbox (table_name, row_pk, op) VALUES ('audit_log','ghost','INSERT')").run();
    const transport: SyncTransport = { send: vi.fn(() => Promise.resolve({ ackedSeq: 0 })) };
    const res = await pushOnce(db, 's', transport);
    expect(res.pushed).toBe(0);
    expect(unacked()).toBe(0);            // phantom acked, queue not wedged
    expect(transport.send).not.toHaveBeenCalled();
  });
});
