// Shop-side pull: fetch CONFIRMED WhatsApp orders from the central store and
// mirror them locally as pending_orders (Phase 4 workstream C2).
//
// Runs on EVERY shop, unlike the catalog pull worker (pull.ts), which
// deliberately excludes HQ because HQ is the catalog's SOURCE. Orders have no
// such asymmetry — any shop, including the company's first branch (flagged
// HQ), can be an order's fulfilling shop, so every install runs this.

import type { Database as DB } from 'better-sqlite3';
import log from 'electron-log/main';
import type { OrdersPullTransport, OrderPullRow } from '../../shared/sync.js';
import { getState, setState } from './state.js';

export interface OrdersPullResult { applied: number; cursor: number; }

export async function pullOrdersOnce(
  db: DB, transport: OrdersPullTransport, limit = 200,
): Promise<OrdersPullResult> {
  const since = Number(getState(db, 'orders_pull_cursor') ?? '0');
  const resp = await transport.fetchOrders(since, limit);
  if (resp.rows.length === 0) return { applied: 0, cursor: since };
  applyOrders(db, resp.rows);
  setState(db, 'orders_pull_cursor', String(resp.cursor));
  setState(db, 'last_orders_pull_at', new Date().toISOString());
  return { applied: resp.rows.length, cursor: resp.cursor };
}

/** Insert a page of confirmed orders into pending_orders. ON CONFLICT DO
 *  NOTHING rather than upsert: the central feed only ever serves an order
 *  once (confirm_order() assigns its cursor exactly once), but if it were
 *  ever re-served — a retried page after a mid-batch crash, a cursor
 *  reset — this must not clobber a status the cashier may have already
 *  changed locally (accepted-and-rung, or rejected). The central store, not
 *  this apply step, is the source of truth for anything past CONFIRMED. */
export function applyOrders(db: DB, rows: OrderPullRow[], deviceId = 'sync'): void {
  const tx = db.transaction((rs: OrderPullRow[]) => {
    for (const r of rs) {
      const d = r.data;
      // The wire format's lines are snake_case (matching the central row
      // shape); pending_orders.lines_json is read back by pendingOrders.ts's
      // PendingOrderLine (camelCase, the renderer's shape) — convert here,
      // at the one place that writes lines_json, rather than leaving two
      // modules silently disagreeing on the JSON's key casing.
      const lines = d.lines.map((l) => ({
        productId: l.product_id, unitId: l.unit_id, quantity: l.quantity,
        unitPricePesewas: l.unit_price_pesewas, lineTotalPesewas: l.line_total_pesewas,
      }));
      db.prepare(
        `INSERT INTO pending_orders (
          id, status, customer_phone, customer_name, channel,
          subtotal_pesewas, total_pesewas, quote_expires_at, confirmed_at,
          lines_json, device_id
        ) VALUES (?, 'CONFIRMED', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      ).run(
        d.id, d.customer_phone, d.customer_name ?? null, d.channel,
        d.subtotal_pesewas, d.total_pesewas, d.quote_expires_at, d.confirmed_at ?? null,
        JSON.stringify(lines), deviceId,
      );
    }
  });
  tx(rows);
}

export interface OrdersPullWorkerHandle { stop(): void; }

/** Background loop mirroring startPullWorker's shape (pull.ts) — tight-drains
 *  while a page came back full, backs off to the interval once caught up,
 *  logs and retries on failure without ever blocking the shop's own sales. */
export function startOrdersPullWorker(
  db: DB, transport: OrdersPullTransport, opts?: { intervalMs?: number },
): OrdersPullWorkerHandle {
  const intervalMs = opts?.intervalMs ?? 30_000;
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      let r = await pullOrdersOnce(db, transport);
      while (!stopped && r.applied > 0) r = await pullOrdersOnce(db, transport);
    } catch (err) {
      log.warn('[sync] orders pull failed (will retry):', err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}
