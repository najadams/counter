// Stock movement history per product. Forensic surface — answers
// "where did the 40 missing bottles of Star go?"
//
// Returns signed quantities with running balance and a friendly worker
// name. SUPERVISOR/OWNER/FOUNDER only.

import type { Database as DB } from 'better-sqlite3';

const VIEWER_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

function requireViewer(db: DB, actorId: string): void {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor worker not found or inactive');
  }
  if (!VIEWER_ROLES.has(w.role)) {
    throw new Error(`stock history is SUPERVISOR/OWNER/FOUNDER only — your role is ${w.role}`);
  }
}

export interface StockHistoryRow {
  movementId: string;
  createdAt: string;
  signedQuantity: number;
  reasonCode: string;
  reasonCategory: 'inflow' | 'outflow' | 'neutral';
  workerId: string;
  workerName: string;
  workerRole: string;
  supervisorApprovalId: string | null;
  supervisorName: string | null;
  unitCostPesewas: number;
  totalValuePesewas: number;
  notes: string | null;
  saleId: string | null;
  breakageLogId: string | null;
  /** Running on-hand AFTER this movement, in canonical units. */
  runningBalance: number;
}

export function listStockHistoryForProduct(
  db: DB,
  actorId: string,
  productId: string,
  limit = 100,
): { rows: StockHistoryRow[]; currentOnHand: number } {
  requireViewer(db, actorId);

  // Latest N rows newest-first; running balance is the on-hand AFTER the row,
  // which equals total on-hand minus the sum of subsequent movements.
  const rows = db.prepare(
    `WITH ranked AS (
       SELECT sm.id AS movementId, sm.created_at AS createdAt,
              sm.quantity AS signedQuantity,
              sm.reason_code AS reasonCode, rc.category AS reasonCategory,
              sm.worker_id AS workerId,
              w.full_name AS workerName, w.role AS workerRole,
              sm.supervisor_approval_id AS supervisorApprovalId,
              sw.full_name AS supervisorName,
              sm.unit_cost_pesewas AS unitCostPesewas,
              sm.total_value_pesewas AS totalValuePesewas,
              sm.notes, sm.sale_id AS saleId, sm.breakage_log_id AS breakageLogId
         FROM stock_movements sm
         JOIN reason_codes rc ON rc.code = sm.reason_code
         JOIN workers w ON w.id = sm.worker_id
         LEFT JOIN workers sw ON sw.id = sm.supervisor_approval_id
        WHERE sm.product_id = ?
        ORDER BY sm.created_at DESC, sm.id DESC
        LIMIT ?
     )
     SELECT * FROM ranked`,
  ).all(productId, Math.max(1, Math.min(limit, 500))) as Array<Omit<StockHistoryRow, 'runningBalance'>>;

  const total = db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_movements WHERE product_id = ?`,
  ).get(productId) as { qty: number };

  // Compute running balance after each row by walking newest -> oldest.
  // After row[0] (newest), balance = total. After row[1], balance = total - row[0].quantity. etc.
  let balance = total.qty;
  const withBalance: StockHistoryRow[] = rows.map((r) => {
    const afterThis = balance;
    balance -= r.signedQuantity; // step backward in time
    return { ...r, runningBalance: afterThis };
  });

  return { rows: withBalance, currentOnHand: total.qty };
}
