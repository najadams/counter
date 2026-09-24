import type { Database } from 'better-sqlite3';
import { VAT_ENABLED, inclusiveBaseSql } from '../../shared/lib/vat.js';
import { saleLineNetCostSql } from './ledger.js';

/** Cumulative allocation keeps every partial return within the original quantity
 * and gives the final return the exact remaining cost, including old rounding. */
export function returnCost(db: Database, saleId: string, productId: string, quantity: number): { gross: number; net: number } {
  const original = db.prepare(`SELECT COALESCE(SUM(-sm.quantity), 0) AS qty,
      COALESCE(SUM(-COALESCE(iv.value_delta_pesewas, sm.total_value_pesewas)), 0) AS value
    FROM stock_movements sm LEFT JOIN inventory_valuation_movements iv ON iv.stock_movement_id = sm.id
    WHERE sm.sale_id = ? AND sm.product_id = ? AND sm.quantity < 0`).get(saleId, productId) as { qty: number; value: number };
  const returned = db.prepare(`SELECT COALESCE(SUM(sm.quantity), 0) AS qty,
      COALESCE(SUM(sm.total_value_pesewas), 0) AS value,
      COALESCE(SUM(COALESCE(cl.restored_net_cost_pesewas, ${VAT_ENABLED ? inclusiveBaseSql('sm.total_value_pesewas') : 'sm.total_value_pesewas'})), 0) AS net
    FROM customer_returns cr JOIN customer_return_lines cl ON cl.return_id = cr.id
    JOIN stock_movements sm ON sm.id = cl.stock_movement_id
    WHERE cr.original_sale_id = ? AND cl.product_id = ?`).get(saleId, productId) as { qty: number; value: number; net: number };
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || original.qty <= 0 || quantity > original.qty - returned.qty) {
    throw new Error(`Cannot return more than was sold. ${Math.max(0, original.qty - returned.qty)} smallest units remain returnable for this product.`);
  }
  if (returned.value > original.value) throw new Error('Earlier returns exceed the original cost. Ask the owner to reconcile this sale.');
  const numerator = BigInt(original.value) * BigInt(returned.qty + quantity);
  const denominator = BigInt(original.qty);
  const target = Number((numerator * 2n + denominator) / (2n * denominator));
  const originalNet = (db.prepare(`SELECT COALESCE(SUM(${saleLineNetCostSql()}), 0) AS n FROM sale_lines WHERE sale_id = ? AND product_id = ?`)
    .get(saleId, productId) as { n: number }).n;
  // Allocate net cost against cumulative gross value: this also guarantees
  // that one tiny return cannot restore more net cost than gross cost.
  const grossDenominator = BigInt(original.value);
  const netTarget = original.value === 0 ? 0
    : Number((2n * BigInt(originalNet) * BigInt(target) + grossDenominator) / (2n * grossDenominator));
  if (returned.net > netTarget) throw new Error('Earlier return costs need owner reconciliation before this return.');
  return { gross: Math.max(0, target - returned.value), net: netTarget - returned.net };
}
