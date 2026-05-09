// Daily summary generator. Idempotent — safe to re-run for the same date.
//
// shrinkage_rate is computed from the most recent COMPLETED stocktake on
// that date (pushback fix #2). If no stocktake completed that day, the
// stocktake_* fields stay NULL and the renderer should display "no
// stocktake yet" rather than a misleading number.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { unitsOnHand } from './stockMovements.js';

export interface DailySummary {
  id: string;
  summaryDate: string;             // 'YYYY-MM-DD'
  locationId: string;
  totalRevenuePesewas: number;
  totalCostOfGoodsSoldPesewas: number;
  grossMarginPesewas: number;
  totalBreakageValuePesewas: number;
  totalConsumptionValuePesewas: number;
  totalExpensesValuePesewas: number;
  expensesByCategory: Array<{ category: string; totalPesewas: number; count: number }>;
  cashCountVariancePesewas: number;
  stocktakeShrinkageValuePesewas: number | null;
  stocktakeShrinkageRate: number | null;
  creditExtendedPesewas: number;
  creditCollectedPesewas: number;
  totalOutstandingCreditPesewas: number;
  numSales: number;
  numUniqueCustomers: number;
  topSkus: Array<{ sku: string; name: string; revenuePesewas: number; unitsSold: number }>;
  reorderAlerts: Array<{ sku: string; name: string; unitsOnHand: number; reorderThreshold: number }>;
  shiftSummaries: Array<{
    shiftId: string; workerName: string; totalSalesPesewas: number;
    cashVariancePesewas: number | null; closedAt: string | null;
  }>;
  generatedAt: string;
  whatsappSentAt: string | null;
}

export interface GenerateDailySummaryInput {
  date: string;                    // 'YYYY-MM-DD'
  locationId: string;
  workerId: string;
  deviceId: string;
}

/** Generate (or regenerate) the daily summary for a given date+location. */
export function generateDailySummary(
  db: DB,
  input: GenerateDailySummaryInput,
): DailySummary {
  const { date, locationId } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`generateDailySummary: invalid date '${date}', expected YYYY-MM-DD`);
  }
  const dayStart = `${date}T00:00:00.000Z`;
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`generateDailySummary: invalid date components`);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString();

  // Sales
  const salesAgg = db
    .prepare(
      `SELECT COALESCE(SUM(total_pesewas), 0) AS revenue,
              COUNT(*) AS num,
              COUNT(DISTINCT customer_id) AS distinct_customers
         FROM sales
         WHERE location_id = ? AND voided = 0
           AND created_at >= ? AND created_at < ?`,
    )
    .get(locationId, dayStart, next) as { revenue: number; num: number; distinct_customers: number };

  const cogsRow = db
    .prepare(
      `SELECT COALESCE(SUM(sl.unit_cost_pesewas * sl.quantity), 0) AS cogs
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         WHERE s.location_id = ? AND s.voided = 0
           AND s.created_at >= ? AND s.created_at < ?`,
    )
    .get(locationId, dayStart, next) as { cogs: number };

  const totalRevenue = salesAgg.revenue;
  const totalCogs = cogsRow.cogs;
  const grossMargin = totalRevenue - totalCogs;

  // Breakage value (loss is stored as negative total_value; we report positive)
  const breakageRow = db
    .prepare(
      `SELECT COALESCE(SUM(-total_value_pesewas), 0) AS total
         FROM stock_movements
         WHERE location_id = ? AND reason_code = 'BREAKAGE'
           AND created_at >= ? AND created_at < ?`,
    )
    .get(locationId, dayStart, next) as { total: number };

  // Consumption value (free + paid)
  const consumptionRow = db
    .prepare(
      `SELECT COALESCE(SUM(-total_value_pesewas), 0) AS total
         FROM stock_movements
         WHERE location_id = ? AND reason_code IN ('WORKER_CONSUMED_FREE','WORKER_CONSUMED_PAID')
           AND created_at >= ? AND created_at < ?`,
    )
    .get(locationId, dayStart, next) as { total: number };

  // Petty cash expenses (rent, utilities, transport, etc.)
  const expensesRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
         FROM petty_cash_expenses
         WHERE location_id = ? AND created_at >= ? AND created_at < ?`,
    )
    .get(locationId, dayStart, next) as { total: number };
  const expensesByCategory = db
    .prepare(
      `SELECT category, COALESCE(SUM(amount_pesewas), 0) AS totalPesewas, COUNT(*) AS count
         FROM petty_cash_expenses
         WHERE location_id = ? AND created_at >= ? AND created_at < ?
         GROUP BY category ORDER BY totalPesewas DESC`,
    )
    .all(locationId, dayStart, next) as Array<{ category: string; totalPesewas: number; count: number }>;

  // Cash count variance: sum of variance from SHIFT_CLOSE counts on this day
  const cashVarRow = db
    .prepare(
      `SELECT COALESCE(SUM(variance_pesewas), 0) AS total
         FROM cash_counts
         WHERE location_id = ? AND count_type = 'SHIFT_CLOSE'
           AND created_at >= ? AND created_at < ?
           AND variance_pesewas IS NOT NULL`,
    )
    .get(locationId, dayStart, next) as { total: number };

  // Credit extended on this day. Split-tender aware: a 100-cedi sale paid
  // 70 cash + 30 credit only adds 30 to "credit extended", not the full 100.
  const creditExtendedRow = db
    .prepare(
      `SELECT COALESCE(SUM(sp.amount_pesewas), 0) AS total
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
         WHERE s.location_id = ? AND s.voided = 0
           AND sp.payment_method = 'CREDIT'
           AND s.created_at >= ? AND s.created_at < ?`,
    )
    .get(locationId, dayStart, next) as { total: number };

  // Credit collected (customer_payments on this day)
  const creditCollectedRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
         FROM customer_payments
         WHERE received_at >= ? AND received_at < ?`,
    )
    .get(dayStart, next) as { total: number };

  // Total outstanding credit (snapshot — sum of all customer balances now).
  // For an "as-of-end-of-day" reading we'd need historical balance; for
  // v1 we report the current snapshot, which is correct when generated
  // on the actual day.
  const outstandingRow = db
    .prepare(
      `SELECT COALESCE(SUM(current_balance_pesewas), 0) AS total
         FROM customers WHERE deleted_at IS NULL`,
    )
    .get() as { total: number };

  // Stocktake-derived shrinkage (latest COMPLETED stocktake that day)
  const stocktake = db
    .prepare(
      `SELECT total_loss_value_pesewas AS loss, shrinkage_rate AS rate
         FROM stocktake_events
         WHERE location_id = ? AND status = 'COMPLETED'
           AND completed_at >= ? AND completed_at < ?
         ORDER BY completed_at DESC LIMIT 1`,
    )
    .get(locationId, dayStart, next) as { loss: number; rate: number | null } | undefined;

  // Top 5 SKUs by revenue
  const topSkus = db
    .prepare(
      `SELECT p.sku, p.name,
              SUM(sl.line_total_pesewas) AS revenue,
              SUM(sl.quantity) AS unitsSold
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN products p ON p.id = sl.product_id
         WHERE s.location_id = ? AND s.voided = 0
           AND s.created_at >= ? AND s.created_at < ?
         GROUP BY p.id
         ORDER BY revenue DESC
         LIMIT 5`,
    )
    .all(locationId, dayStart, next) as Array<{ sku: string; name: string; revenue: number; unitsSold: number }>;

  // Reorder alerts: products at or below threshold (active only)
  const productsForAlerts = db
    .prepare(
      `SELECT id, sku, name, reorder_threshold AS threshold
         FROM products
         WHERE active = 1 AND deleted_at IS NULL AND reorder_threshold > 0`,
    )
    .all() as Array<{ id: string; sku: string; name: string; threshold: number }>;
  const reorderAlerts = productsForAlerts
    .map((p) => ({ ...p, units: unitsOnHand(db, p.id, locationId) }))
    .filter((p) => p.units <= p.threshold)
    .map((p) => ({ sku: p.sku, name: p.name, unitsOnHand: p.units, reorderThreshold: p.threshold }));

  // Per-shift breakdown (shifts that opened OR closed this day)
  const shifts = db
    .prepare(
      `SELECT s.id, s.total_sales_pesewas AS totalSales, s.cash_variance_pesewas AS cashVar,
              s.closed_at AS closedAt, w.full_name AS workerName
         FROM shifts s
         JOIN workers w ON w.id = s.worker_id
         WHERE s.location_id = ?
           AND ((s.opened_at >= ? AND s.opened_at < ?)
                OR (s.closed_at IS NOT NULL AND s.closed_at >= ? AND s.closed_at < ?))
         ORDER BY s.opened_at`,
    )
    .all(locationId, dayStart, next, dayStart, next) as Array<{
      id: string; totalSales: number; cashVar: number | null;
      closedAt: string | null; workerName: string;
    }>;
  const shiftSummaries = shifts.map((s) => ({
    shiftId: s.id, workerName: s.workerName,
    totalSalesPesewas: s.totalSales, cashVariancePesewas: s.cashVar, closedAt: s.closedAt,
  }));

  const stocktakeLoss = stocktake?.loss ?? null;
  const stocktakeRate = stocktake?.rate ?? null;

  // Upsert
  const existing = db
    .prepare(
      'SELECT id FROM daily_summaries WHERE summary_date = ? AND location_id = ?',
    )
    .get(date, locationId) as { id: string } | undefined;

  const id = existing?.id ?? `ds-${uuidv4()}`;
  const now = new Date().toISOString();
  const topSkusJson = JSON.stringify(topSkus.map((t) => ({
    sku: t.sku, name: t.name, revenuePesewas: t.revenue, unitsSold: t.unitsSold,
  })));
  const reorderJson = JSON.stringify(reorderAlerts);
  const shiftJson = JSON.stringify(shiftSummaries);

  if (existing) {
    db.prepare(
      `UPDATE daily_summaries SET
        total_revenue_pesewas = ?, total_cost_of_goods_sold_pesewas = ?,
        gross_margin_pesewas = ?, total_breakage_value_pesewas = ?,
        total_consumption_value_pesewas = ?, cash_count_variance_pesewas = ?,
        stocktake_shrinkage_value_pesewas = ?, stocktake_shrinkage_rate = ?,
        credit_extended_pesewas = ?, credit_collected_pesewas = ?,
        total_outstanding_credit_pesewas = ?,
        num_sales = ?, num_unique_customers = ?,
        top_skus_json = ?, reorder_alerts_json = ?, shift_summaries_json = ?,
        total_expenses_value_pesewas = ?, expenses_by_category_json = ?,
        generated_at = ?
      WHERE id = ?`,
    ).run(
      totalRevenue, totalCogs, grossMargin, breakageRow.total, consumptionRow.total,
      cashVarRow.total, stocktakeLoss, stocktakeRate,
      creditExtendedRow.total, creditCollectedRow.total, outstandingRow.total,
      salesAgg.num, salesAgg.distinct_customers,
      topSkusJson, reorderJson, shiftJson,
      expensesRow.total, JSON.stringify(expensesByCategory),
      now, id,
    );
  } else {
    db.prepare(
      `INSERT INTO daily_summaries (
        id, summary_date, location_id,
        total_revenue_pesewas, total_cost_of_goods_sold_pesewas,
        gross_margin_pesewas, total_breakage_value_pesewas,
        total_consumption_value_pesewas, cash_count_variance_pesewas,
        stocktake_shrinkage_value_pesewas, stocktake_shrinkage_rate,
        credit_extended_pesewas, credit_collected_pesewas,
        total_outstanding_credit_pesewas,
        num_sales, num_unique_customers,
        top_skus_json, reorder_alerts_json, shift_summaries_json,
        total_expenses_value_pesewas, expenses_by_category_json,
        generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, date, locationId,
      totalRevenue, totalCogs, grossMargin, breakageRow.total, consumptionRow.total,
      cashVarRow.total, stocktakeLoss, stocktakeRate,
      creditExtendedRow.total, creditCollectedRow.total, outstandingRow.total,
      salesAgg.num, salesAgg.distinct_customers,
      topSkusJson, reorderJson, shiftJson,
      expensesRow.total, JSON.stringify(expensesByCategory),
      now,
    );
  }

  return {
    id,
    summaryDate: date,
    locationId,
    totalRevenuePesewas: totalRevenue,
    totalCostOfGoodsSoldPesewas: totalCogs,
    grossMarginPesewas: grossMargin,
    totalBreakageValuePesewas: breakageRow.total,
    totalConsumptionValuePesewas: consumptionRow.total,
    totalExpensesValuePesewas: expensesRow.total,
    expensesByCategory,
    cashCountVariancePesewas: cashVarRow.total,
    stocktakeShrinkageValuePesewas: stocktakeLoss,
    stocktakeShrinkageRate: stocktakeRate,
    creditExtendedPesewas: creditExtendedRow.total,
    creditCollectedPesewas: creditCollectedRow.total,
    totalOutstandingCreditPesewas: outstandingRow.total,
    numSales: salesAgg.num,
    numUniqueCustomers: salesAgg.distinct_customers,
    topSkus: topSkus.map((t) => ({ sku: t.sku, name: t.name, revenuePesewas: t.revenue, unitsSold: t.unitsSold })),
    reorderAlerts,
    shiftSummaries,
    generatedAt: now,
    whatsappSentAt: null,
  };
}

export function getDailySummary(db: DB, date: string, locationId: string): DailySummary | null {
  const row = db
    .prepare(
      `SELECT id, summary_date AS summaryDate, location_id AS locationId,
              total_revenue_pesewas AS totalRevenuePesewas,
              total_cost_of_goods_sold_pesewas AS totalCostOfGoodsSoldPesewas,
              gross_margin_pesewas AS grossMarginPesewas,
              total_breakage_value_pesewas AS totalBreakageValuePesewas,
              total_consumption_value_pesewas AS totalConsumptionValuePesewas,
              cash_count_variance_pesewas AS cashCountVariancePesewas,
              stocktake_shrinkage_value_pesewas AS stocktakeShrinkageValuePesewas,
              stocktake_shrinkage_rate AS stocktakeShrinkageRate,
              credit_extended_pesewas AS creditExtendedPesewas,
              credit_collected_pesewas AS creditCollectedPesewas,
              total_outstanding_credit_pesewas AS totalOutstandingCreditPesewas,
              num_sales AS numSales, num_unique_customers AS numUniqueCustomers,
              top_skus_json AS topSkusJson, reorder_alerts_json AS reorderJson,
              shift_summaries_json AS shiftJson,
              total_expenses_value_pesewas AS totalExpensesValuePesewas,
              expenses_by_category_json AS expensesByCategoryJson,
              generated_at AS generatedAt, whatsapp_sent_at AS whatsappSentAt
         FROM daily_summaries WHERE summary_date = ? AND location_id = ?`,
    )
    .get(date, locationId) as
    | (Omit<DailySummary, 'topSkus' | 'reorderAlerts' | 'shiftSummaries' | 'expensesByCategory'> & {
        topSkusJson: string; reorderJson: string; shiftJson: string;
        expensesByCategoryJson: string;
      })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    topSkus: JSON.parse(row.topSkusJson),
    reorderAlerts: JSON.parse(row.reorderJson),
    shiftSummaries: JSON.parse(row.shiftJson),
    expensesByCategory: JSON.parse(row.expensesByCategoryJson || '[]'),
  } as DailySummary;
}

export function listRecentDailySummaries(db: DB, limit = 30): Array<{
  date: string; locationId: string; revenuePesewas: number; numSales: number;
  shrinkageRate: number | null; generatedAt: string; whatsappSentAt: string | null;
}> {
  return db
    .prepare(
      `SELECT summary_date AS date, location_id AS locationId,
              total_revenue_pesewas AS revenuePesewas,
              num_sales AS numSales,
              stocktake_shrinkage_rate AS shrinkageRate,
              generated_at AS generatedAt,
              whatsapp_sent_at AS whatsappSentAt
         FROM daily_summaries
         ORDER BY summary_date DESC, location_id ASC
         LIMIT ?`,
    )
    .all(limit) as Array<{
      date: string; locationId: string; revenuePesewas: number; numSales: number;
      shrinkageRate: number | null; generatedAt: string; whatsappSentAt: string | null;
    }>;
}
