// Cash that moved through one till drawer (one shift) because of sales.
//
// Every place that says what a drawer should hold (shift close, cash drops,
// the Overview's "Cash in tills", the position report) adds these the same
// way, or the numbers disagree with each other.
//
// A sale's cash belongs to the drawer that took it. Voiding the sale takes
// that cash back out only when no money changed hands (it was rung by
// mistake). When the customer was paid back, the sale's cash stays counted
// in the drawer that took it, and the refund comes out of the drawer that
// paid it (cash_refunds.shift_id): the same shift, a later one, or another
// till. Customer-return cash refunds are cash_refunds rows too.

import type { Database as DB } from 'better-sqlite3';

/** Cash tenders this shift's drawer took in from sales, optionally only
 *  those rung before `beforeISO`. */
export function cashFromSales(db: DB, shiftId: string, beforeISO?: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(sp.amount_pesewas), 0) AS total
       FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
      WHERE s.shift_id = ? AND sp.payment_method = 'CASH'
        AND (s.voided = 0 OR EXISTS (
              SELECT 1 FROM cash_refunds cr
               WHERE cr.sale_id = s.id AND cr.source_type = 'SALE_VOID'))
        ${beforeISO ? 'AND s.created_at < ?' : ''}`,
  ).get(...(beforeISO ? [shiftId, beforeISO] : [shiftId])) as { total: number };
  return row.total;
}

/** Cash paid back to customers out of this shift's drawer, optionally only
 *  refunds made before `beforeISO`. */
export function cashRefunded(db: DB, shiftId: string, beforeISO?: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
       FROM cash_refunds
      WHERE shift_id = ? ${beforeISO ? 'AND created_at < ?' : ''}`,
  ).get(...(beforeISO ? [shiftId, beforeISO] : [shiftId])) as { total: number };
  return row.total;
}
