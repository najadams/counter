// Reading and acking the sync_outbox (Phase 3b). Pure DB operations, no
// network — the push worker composes these with a transport.

import type { Database as DB } from 'better-sqlite3';
import { SYNCED_EVENT_TABLES, SYNCED_MASTER_TABLES, type PushRow } from '../../shared/sync.js';

// Whitelist so a table_name (which we control via triggers, but defense in
// depth) is never interpolated into SQL unless it's a known capture table.
// Both event tables (always captured) and HQ master tables (captured on HQ).
const TABLE_SET = new Set<string>([...SYNCED_EVENT_TABLES, ...SYNCED_MASTER_TABLES]);

/** The next unacked seqs in order (the batch window). Used to advance acks even
 *  past rows whose source record is gone. */
export function pendingSeqs(db: DB, limit = 500): number[] {
  return (db.prepare(
    'SELECT seq FROM sync_outbox WHERE acked_at IS NULL ORDER BY seq LIMIT ?',
  ).all(limit) as Array<{ seq: number }>).map((r) => r.seq);
}

/** Read the next unacked outbox rows in seq order and hydrate each from its
 *  source table. Rows whose source is missing (shouldn't happen for
 *  append-only data) are skipped; pushOnce() advances their ack separately so
 *  they can't wedge the queue. */
export function collectBatch(db: DB, limit = 500): PushRow[] {
  const pending = db.prepare(
    'SELECT seq, table_name, row_pk, op FROM sync_outbox WHERE acked_at IS NULL ORDER BY seq LIMIT ?',
  ).all(limit) as Array<{ seq: number; table_name: string; row_pk: string; op: 'INSERT' | 'UPDATE' }>;

  const out: PushRow[] = [];
  for (const p of pending) {
    if (!TABLE_SET.has(p.table_name)) continue;
    const data = db.prepare(`SELECT * FROM ${p.table_name} WHERE id = ?`)
      .get(p.row_pk) as Record<string, unknown> | undefined;
    if (!data) continue;
    out.push({ seq: p.seq, table: p.table_name, op: p.op, data });
  }
  return out;
}

/** Mark every unacked outbox row up to and including uptoSeq as acked. */
export function markAcked(db: DB, uptoSeq: number, at: string = new Date().toISOString()): void {
  db.prepare('UPDATE sync_outbox SET acked_at = ? WHERE acked_at IS NULL AND seq <= ?').run(at, uptoSeq);
}
