// Shop-side pull: fetch HQ catalog from the central store and apply it locally
// (Phase 3c). Runs only on shops (sync_role != 'HQ'); HQ is the source.
//
// Applying upserts by id. On a shop the master capture triggers (migration
// 0033) are HQ-gated off, so applying never re-enqueues — no feedback loop.

import type { Database as DB } from 'better-sqlite3';
import log from 'electron-log/main';
import { SYNCED_MASTER_TABLES, type PullTransport, type PullRow } from '../../shared/sync.js';
import { getState, setState } from './state.js';

const MASTER = new Set<string>(SYNCED_MASTER_TABLES);

export interface PullResult { applied: number; cursor: number; }

export async function pullOnce(db: DB, transport: PullTransport, limit = 500): Promise<PullResult> {
  const since = Number(getState(db, 'pull_cursor') ?? '0');
  const resp = await transport.fetchCatalog(since, limit);
  if (resp.rows.length === 0) return { applied: 0, cursor: since };
  applyCatalog(db, resp.rows);
  setState(db, 'pull_cursor', String(resp.cursor));
  setState(db, 'last_pull_at', new Date().toISOString());
  return { applied: resp.rows.length, cursor: resp.cursor };
}

/** Upsert a page of catalog rows in one transaction. defer_foreign_keys lets
 *  rows arrive in any order within the batch (e.g. product_units before their
 *  product); FK is still enforced at commit. */
export function applyCatalog(db: DB, rows: PullRow[]): void {
  db.pragma('defer_foreign_keys = ON');
  const tx = db.transaction((rs: PullRow[]) => {
    for (const r of rs) applyMasterRow(db, r.table, r.data);
  });
  tx(rows);
}

function applyMasterRow(db: DB, table: string, data: Record<string, unknown>): void {
  if (!MASTER.has(table)) return;            // ignore non-catalog tables
  const cols = Object.keys(data);
  if (!cols.includes('id')) return;
  const placeholders = cols.map(() => '?').join(', ');
  const updates = cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})
               ON CONFLICT(id) DO UPDATE SET ${updates}`;
  db.prepare(sql).run(...(cols.map((c) => data[c]) as unknown[]));
}

export interface PullWorkerHandle { stop(): void; }

export function startPullWorker(db: DB, transport: PullTransport, opts?: { intervalMs?: number }): PullWorkerHandle {
  const intervalMs = opts?.intervalMs ?? 30_000;
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      let r = await pullOnce(db, transport);
      while (!stopped && r.applied > 0) r = await pullOnce(db, transport);
    } catch (err) {
      log.warn('[sync] pull failed (will retry):', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}
