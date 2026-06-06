// The shop-side push worker (Phase 3b). Drains sync_outbox to the central store
// via an injected transport, acking only what the central store confirms.
//
// Safety: re-sending is harmless — the central store upserts by (shop, id), so
// a dropped connection mid-batch just re-sends. We never ack a row the central
// store didn't confirm.

import type { Database as DB } from 'better-sqlite3';
import log from 'electron-log/main';
import type { SyncTransport } from '../../shared/sync.js';
import { collectBatch, pendingSeqs, markAcked } from './outbox.js';
import { setState } from './state.js';

export interface PushResult { pushed: number; ackedSeq: number | null; }

export async function pushOnce(
  db: DB, shopId: string, transport: SyncTransport, limit = 500,
): Promise<PushResult> {
  const seqs = pendingSeqs(db, limit);
  if (seqs.length === 0) return { pushed: 0, ackedSeq: null };

  const rows = collectBatch(db, limit);
  if (rows.length === 0) {
    // Every pending row's source is gone (shouldn't happen for append-only
    // data); clear the window so the queue isn't wedged.
    const windowMax = seqs[seqs.length - 1]!;
    markAcked(db, windowMax);
    return { pushed: 0, ackedSeq: windowMax };
  }

  const ack = await transport.send({ shopId, rows });
  markAcked(db, ack.ackedSeq);
  recordPushState(db, ack.ackedSeq);
  return { pushed: rows.length, ackedSeq: ack.ackedSeq };
}

function recordPushState(db: DB, ackedSeq: number): void {
  const now = new Date().toISOString();
  setState(db, 'push_last_acked_seq', String(ackedSeq), now);
  setState(db, 'last_push_at', now, now);
}

export interface SyncWorkerHandle { stop(): void; }

/** Start a background loop that drains the outbox on an interval, with a tight
 *  drain when there's a backlog. Failures are logged and retried next tick —
 *  the shop keeps selling regardless. */
export function startSyncWorker(
  db: DB, shopId: string, transport: SyncTransport, opts?: { intervalMs?: number },
): SyncWorkerHandle {
  const intervalMs = opts?.intervalMs ?? 15_000;
  let stopped = false;
  let running = false;

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      let res = await pushOnce(db, shopId, transport);
      while (!stopped && res.pushed > 0) res = await pushOnce(db, shopId, transport);
    } catch (err) {
      log.warn('[sync] push failed (will retry):', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick(); // kick once on start
  return { stop() { stopped = true; clearInterval(timer); } };
}
