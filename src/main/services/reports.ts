// Reports / dashboard service.
//
// Returns a single "overview snapshot" — six KPIs plus a few drill-down
// widgets (sparkline, top sellers, slow movers, recent stocktake variance).
// One query bundle per call so the renderer can paint the whole dashboard
// without N round-trips.
//
// Read-only. OWNER / FOUNDER / SUPERVISOR roles only — the dashboard
// exposes margin and supplier balances which cashiers shouldn't see.
//
// All money is integer pesewas. All dates here are computed in local time
// from the server clock so "today" / "this week" match what the shop's
// staff would call those windows. Edge cases at midnight roll naturally.

import type { Database as DB } from 'better-sqlite3';
import { DEFAULT_LOCATION_ID } from '../../shared/lib/constants.js';

const ALLOWED_ROLES = new Set(['OWNER', 'FOUNDER', 'SUPERVISOR']);

function requireReportsActor(db: DB, actorId: string): void {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('reports: actor not active');
  }
  if (!ALLOWED_ROLES.has(w.role)) {
    throw new Error(`reports: role ${w.role} not permitted (OWNER, FOUNDER, or SUPERVISOR required)`);
  }
}

// --- Date helpers (local time) -------------------------------------------

function localDateISO(d: Date): string {
  // YYYY-MM-DD in local time (not UTC) so "today" matches the wall clock.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localStartOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function localStartOfWeek(d: Date): Date {
  // Monday as week start (Ghana convention; matches most shop owners).
  const out = localStartOfDay(d);
  const dow = out.getDay(); // 0=Sun … 6=Sat
  const back = dow === 0 ? 6 : dow - 1;
  out.setDate(out.getDate() - back);
  return out;
}

function localStartOfMonth(d: Date): Date {
  const out = localStartOfDay(d);
  out.setDate(1);
  return out;
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function pctChange(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null; // null = "no comparable previous period"
  return Math.round(((curr - prev) / Math.abs(prev)) * 10000) / 100;
}

// --- Tiny SQL helpers ----------------------------------------------------

interface SumRow { sumPesewas: number; sumCount: number }

function salesTotalsBetween(db: DB, fromISO: string, toExclusiveISO: string): SumRow {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(total_pesewas), 0) AS sumPesewas,
              COUNT(*)                         AS sumCount
         FROM sales
         WHERE voided = 0
           AND created_at >= ? AND created_at < ?`,
    )
    .get(fromISO, toExclusiveISO) as SumRow;
  return r;
}

function marginTotalsBetween(db: DB, fromISO: string, toExclusiveISO: string): {
  revenuePesewas: number;
  cogsPesewas: number;
  marginPesewas: number;
} {
  // sale_lines.margin_pesewas is enforced by CHECK to be exactly
  // (unit_price - unit_cost) * quantity, so we can trust it.
  // We exclude voided sales by joining; sale_lines for voided sales stay in
  // the table but the parent sale is voided, so we filter on s.voided=0.
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(sl.line_total_pesewas), 0)                         AS revenuePesewas,
              COALESCE(SUM(sl.unit_cost_pesewas * sl.quantity), 0)            AS cogsPesewas,
              COALESCE(SUM(sl.margin_pesewas), 0)                             AS marginPesewas
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         WHERE s.voided = 0
           AND s.created_at >= ? AND s.created_at < ?`,
    )
    .get(fromISO, toExclusiveISO) as { revenuePesewas: number; cogsPesewas: number; marginPesewas: number };
  return r;
}

// --- Public response shape -----------------------------------------------

export interface ReportsOverview {
  generatedAt: string;
  locationId: string;
  /** All currency below is integer pesewas. */
  revenue: {
    todayPesewas: number;
    thisWeekPesewas: number;
    thisMonthPesewas: number;
    /** Same window one period earlier. NULL if no comparable prior data. */
    yesterdayPesewas: number;
    lastWeekPesewas: number;
    lastMonthPesewas: number;
    /** % change vs previous period (e.g. +12.5 means +12.5%). NULL if prior was 0. */
    todayChangePct: number | null;
    thisWeekChangePct: number | null;
    thisMonthChangePct: number | null;
    numSalesToday: number;
    numSalesThisWeek: number;
    numSalesThisMonth: number;
  };
  margin: {
    revenuePesewas: number;             // this-month revenue
    cogsPesewas: number;
    grossMarginPesewas: number;
    grossMarginBps: number;             // basis points, 0..10000+. 1234 = 12.34%
    revenueLast30dPesewas: number;
    grossMarginLast30dPesewas: number;
    grossMarginLast30dBps: number;
  };
  cashPosition: {
    /** Expected cash sitting in open tills right now, summed across all open shifts. */
    openTillExpectedPesewas: number;
    /** Number of currently-open shifts. */
    openShifts: number;
    /** Last closed shift's variance (if any) — quick "is anyone short today?" tell. */
    lastClosedVariancePesewas: number | null;
    lastClosedAt: string | null;
  };
  receivables: {
    totalPesewas: number;
    bucket0_30Pesewas: number;
    bucket31_60Pesewas: number;
    bucket61_90Pesewas: number;
    bucket90PlusPesewas: number;
    /** Customer count with positive balance. */
    customerCount: number;
    overLimitCount: number;
  };
  payables: {
    totalOwedPesewas: number;
    supplierCount: number;
  };
  inventory: {
    /** SUM(stock_movements.quantity × products.cost_price_pesewas) at this location. */
    totalAtCostPesewas: number;
    /** Same units at current walk-in retail price. */
    totalAtRetailPesewas: number;
    activeSkuCount: number;
    belowReorderCount: number;
    stockoutCount: number;
  };
  /** Per-day revenue for the last 30 calendar days (oldest first). Days with
   *  no sales appear as 0 so the sparkline doesn't have gaps. */
  revenueSparkline: Array<{ date: string; pesewas: number }>;
  /** Top 5 products by revenue this week. */
  topSellersThisWeek: Array<{
    productId: string; sku: string; name: string;
    unitsSold: number; revenuePesewas: number;
  }>;
  /** Products with > 0 stock that haven't sold in the last 14 days. */
  slowMovers: Array<{
    productId: string; sku: string; name: string;
    unitsOnHand: number; daysSinceLastSale: number | null;
    stockValueAtCostPesewas: number;
  }>;
  /** Last 5 completed stocktakes with non-zero variance. */
  recentVarianceEvents: Array<{
    stocktakeId: string; completedAt: string;
    lossValuePesewas: number; foundValuePesewas: number;
    shrinkageRate: number | null;
    productsWithVariance: number;
  }>;
}

export interface GetReportsOverviewInput {
  actorWorkerId: string;
  locationId?: string;
  /** Date the dashboard treats as "today" (default = server local date). Test hook. */
  asOfDateISO?: string;
}

export function getReportsOverview(db: DB, input: GetReportsOverviewInput): ReportsOverview {
  requireReportsActor(db, input.actorWorkerId);

  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  const now = input.asOfDateISO ? new Date(`${input.asOfDateISO}T12:00:00`) : new Date();

  // --- Window boundaries -------------------------------------------------
  const startToday = localStartOfDay(now);
  const startTomorrow = addDays(startToday, 1);
  const startYesterday = addDays(startToday, -1);
  const startWeek = localStartOfWeek(now);
  const startLastWeek = addDays(startWeek, -7);
  const startMonth = localStartOfMonth(now);
  // Previous month: drop one month, keeping day=1
  const startLastMonth = new Date(startMonth);
  startLastMonth.setMonth(startLastMonth.getMonth() - 1);
  const start30dAgo = addDays(startToday, -30);

  const iso = (d: Date) => d.toISOString();

  // --- 1. Revenue --------------------------------------------------------
  const today = salesTotalsBetween(db, iso(startToday), iso(startTomorrow));
  const yest = salesTotalsBetween(db, iso(startYesterday), iso(startToday));
  const week = salesTotalsBetween(db, iso(startWeek), iso(startTomorrow));
  const lastWeek = salesTotalsBetween(db, iso(startLastWeek), iso(startWeek));
  const month = salesTotalsBetween(db, iso(startMonth), iso(startTomorrow));
  const lastMonth = salesTotalsBetween(db, iso(startLastMonth), iso(startMonth));

  // --- 2. Margin ---------------------------------------------------------
  const marginMonth = marginTotalsBetween(db, iso(startMonth), iso(startTomorrow));
  const margin30d = marginTotalsBetween(db, iso(start30dAgo), iso(startTomorrow));

  // --- 3. Cash position --------------------------------------------------
  // For each currently-open shift: expected = opening_cash + cash sales +
  // overpayments - cash drops - cash expenses. We approximate via
  // (opening_cash + cash sales during shift - drops - expenses). This is
  // the same intent as cashDrops.getExpectedCash but inlined for the bundle.
  const openShiftsRow = db
    .prepare(
      `SELECT s.id, s.opening_cash_pesewas AS openingCashPesewas, s.opened_at
         FROM shifts s
         WHERE s.closed_at IS NULL AND s.location_id = ?`,
    )
    .all(locationId) as Array<{ id: string; openingCashPesewas: number; opened_at: string }>;

  let openTillExpected = 0;
  for (const s of openShiftsRow) {
    const cashSales = db
      .prepare(
        `SELECT COALESCE(SUM(total_pesewas), 0) AS s FROM sales
           WHERE shift_id = ? AND voided = 0 AND payment_method = 'CASH'`,
      )
      .get(s.id) as { s: number };
    const drops = db
      .prepare(
        `SELECT COALESCE(SUM(counted_pesewas), 0) AS s FROM cash_counts
           WHERE shift_id = ? AND count_type = 'CASH_DROP'`,
      )
      .get(s.id) as { s: number };
    const expenses = db
      .prepare(
        `SELECT COALESCE(SUM(amount_pesewas), 0) AS s FROM petty_cash_expenses
           WHERE shift_id = ?`,
      )
      .get(s.id) as { s: number };
    openTillExpected += s.openingCashPesewas + cashSales.s - drops.s - expenses.s;
  }

  const lastClosed = db
    .prepare(
      `SELECT cash_variance_pesewas AS variance, closed_at
         FROM shifts
         WHERE closed_at IS NOT NULL AND location_id = ?
         ORDER BY closed_at DESC LIMIT 1`,
    )
    .get(locationId) as { variance: number | null; closed_at: string } | undefined;

  // --- 4. Receivables (credit aging) -------------------------------------
  // We compute aging from the open credit sales themselves: each sale's
  // outstanding amount goes into the bucket matching its age. Customer
  // balance cache is reliable for the total but doesn't give us age, so we
  // re-derive from sales for the bucket split.
  //
  // Outstanding = (sum of CREDIT tenders on the sale) − (allocations paid
  // against the sale). The credit-tender sum replaces sale.total_pesewas
  // for the same reason completeSale now bumps balance by the credit
  // portion only: on a CASH 100 + CREDIT 500 sale, only the 500 is owed.
  const openCredit = db
    .prepare(
      `SELECT s.created_at,
              COALESCE((SELECT SUM(amount_pesewas)
                          FROM sale_payments
                          WHERE sale_id = s.id AND payment_method = 'CREDIT'), 0)
                - COALESCE((SELECT SUM(amount_pesewas)
                              FROM customer_payment_allocations
                              WHERE sale_id = s.id), 0) AS outstanding
         FROM sales s
         WHERE s.is_credit = 1 AND s.voided = 0`,
    )
    .all() as Array<{ created_at: string; outstanding: number }>;

  let recBucket0 = 0, recBucket1 = 0, recBucket2 = 0, recBucket3 = 0;
  const nowMs = now.getTime();
  for (const row of openCredit) {
    if (row.outstanding <= 0) continue;
    const ageDays = Math.max(0, Math.floor((nowMs - new Date(row.created_at).getTime()) / 86_400_000));
    if (ageDays <= 30) recBucket0 += row.outstanding;
    else if (ageDays <= 60) recBucket1 += row.outstanding;
    else if (ageDays <= 90) recBucket2 += row.outstanding;
    else recBucket3 += row.outstanding;
  }
  const receivablesTotal = recBucket0 + recBucket1 + recBucket2 + recBucket3;

  const customerCounts = db
    .prepare(
      `SELECT
         SUM(CASE WHEN current_balance_pesewas > 0 THEN 1 ELSE 0 END) AS withBalance,
         SUM(CASE WHEN credit_limit_pesewas > 0 AND current_balance_pesewas >= credit_limit_pesewas THEN 1 ELSE 0 END) AS overLimit
       FROM customers WHERE deleted_at IS NULL`,
    )
    .get() as { withBalance: number; overLimit: number };

  // --- 5. Payables -------------------------------------------------------
  // suppliers.current_balance_pesewas: positive = we owe them. The
  // receiveStock flow doesn't auto-bump this today, so the figure is what
  // payments have decremented vs. whatever was on file. Honest caveat is in
  // the supplier-payments UI — we just total it here.
  const payables = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN current_balance_pesewas > 0 THEN current_balance_pesewas ELSE 0 END), 0)
                AS totalOwed,
              SUM(CASE WHEN current_balance_pesewas > 0 THEN 1 ELSE 0 END) AS supplierCount
         FROM suppliers
         WHERE deleted_at IS NULL`,
    )
    .get() as { totalOwed: number; supplierCount: number };

  // --- 6. Inventory value ------------------------------------------------
  // Sum per-product (units on hand × current cost_price_pesewas / walk_in).
  // stock_movements.quantity is signed; SUM gives net on-hand. Filter to the
  // requested location.
  const invRows = db
    .prepare(
      `SELECT p.id, p.cost_price_pesewas AS costEach, p.walk_in_price_pesewas AS retailEach,
              p.reorder_threshold AS reorderThreshold,
              COALESCE(SUM(sm.quantity), 0) AS onHand
         FROM products p
         LEFT JOIN stock_movements sm
           ON sm.product_id = p.id AND sm.location_id = ?
         WHERE p.deleted_at IS NULL AND p.active = 1
         GROUP BY p.id`,
    )
    .all(locationId) as Array<{ id: string; costEach: number; retailEach: number; reorderThreshold: number; onHand: number }>;

  let invAtCost = 0, invAtRetail = 0, belowReorder = 0, stockout = 0;
  for (const r of invRows) {
    if (r.onHand > 0) {
      invAtCost += r.onHand * r.costEach;
      invAtRetail += r.onHand * r.retailEach;
    }
    if (r.onHand <= 0) stockout++;
    else if (r.reorderThreshold > 0 && r.onHand <= r.reorderThreshold) belowReorder++;
  }

  // --- 7. Revenue sparkline (last 30 days) -------------------------------
  const sparkRows = db
    .prepare(
      `SELECT date(created_at, 'localtime') AS d,
              SUM(total_pesewas) AS p
         FROM sales
         WHERE voided = 0
           AND created_at >= ? AND created_at < ?
         GROUP BY date(created_at, 'localtime')
         ORDER BY d`,
    )
    .all(iso(start30dAgo), iso(startTomorrow)) as Array<{ d: string; p: number }>;
  const sparkMap = new Map(sparkRows.map((r) => [r.d, r.p]));
  const sparkline: Array<{ date: string; pesewas: number }> = [];
  for (let i = 30; i >= 1; i--) {
    const d = addDays(startToday, -i + 1);
    const key = localDateISO(d);
    sparkline.push({ date: key, pesewas: sparkMap.get(key) ?? 0 });
  }

  // --- 8. Top sellers this week ------------------------------------------
  const topSellers = db
    .prepare(
      `SELECT p.id AS productId, p.sku, p.name,
              SUM(sl.quantity) AS unitsSold,
              SUM(sl.line_total_pesewas) AS revenuePesewas
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN products p ON p.id = sl.product_id
         WHERE s.voided = 0
           AND s.created_at >= ? AND s.created_at < ?
         GROUP BY p.id
         ORDER BY revenuePesewas DESC
         LIMIT 5`,
    )
    .all(iso(startWeek), iso(startTomorrow)) as ReportsOverview['topSellersThisWeek'];

  // --- 9. Slow movers (positive stock, no sale in 14d) -------------------
  const start14dAgo = addDays(startToday, -14);
  const slow = db
    .prepare(
      `SELECT p.id AS productId, p.sku, p.name,
              p.cost_price_pesewas AS costEach,
              COALESCE(SUM(sm.quantity), 0) AS unitsOnHand,
              (SELECT MAX(s.created_at)
                 FROM sale_lines sl
                 JOIN sales s ON s.id = sl.sale_id
                 WHERE sl.product_id = p.id AND s.voided = 0) AS lastSaleAt
         FROM products p
         LEFT JOIN stock_movements sm
           ON sm.product_id = p.id AND sm.location_id = ?
         WHERE p.deleted_at IS NULL AND p.active = 1
         GROUP BY p.id
         HAVING unitsOnHand > 0
            AND (lastSaleAt IS NULL OR lastSaleAt < ?)
         ORDER BY unitsOnHand * p.cost_price_pesewas DESC
         LIMIT 5`,
    )
    .all(locationId, iso(start14dAgo)) as Array<{
      productId: string; sku: string; name: string;
      costEach: number; unitsOnHand: number; lastSaleAt: string | null;
    }>;
  const slowMovers = slow.map((r) => ({
    productId: r.productId, sku: r.sku, name: r.name,
    unitsOnHand: r.unitsOnHand,
    daysSinceLastSale: r.lastSaleAt
      ? Math.max(0, Math.floor((nowMs - new Date(r.lastSaleAt).getTime()) / 86_400_000))
      : null,
    stockValueAtCostPesewas: r.unitsOnHand * r.costEach,
  }));

  // --- 10. Recent stocktake variance events ------------------------------
  const recentVar = db
    .prepare(
      `SELECT id AS stocktakeId, completed_at AS completedAt,
              total_loss_value_pesewas AS lossValuePesewas,
              total_found_value_pesewas AS foundValuePesewas,
              shrinkage_rate AS shrinkageRate,
              products_with_variance AS productsWithVariance
         FROM stocktake_events
         WHERE status = 'COMPLETED'
           AND (total_loss_value_pesewas > 0 OR total_found_value_pesewas > 0)
         ORDER BY completed_at DESC
         LIMIT 5`,
    )
    .all() as ReportsOverview['recentVarianceEvents'];

  // --- Pack response -----------------------------------------------------

  const monthRev = marginMonth.revenuePesewas;
  const monthGmBps = monthRev > 0
    ? Math.round((marginMonth.marginPesewas / monthRev) * 10000)
    : 0;
  const rev30d = margin30d.revenuePesewas;
  const gm30dBps = rev30d > 0
    ? Math.round((margin30d.marginPesewas / rev30d) * 10000)
    : 0;

  return {
    generatedAt: new Date().toISOString(),
    locationId,
    revenue: {
      todayPesewas: today.sumPesewas,
      thisWeekPesewas: week.sumPesewas,
      thisMonthPesewas: month.sumPesewas,
      yesterdayPesewas: yest.sumPesewas,
      lastWeekPesewas: lastWeek.sumPesewas,
      lastMonthPesewas: lastMonth.sumPesewas,
      todayChangePct: pctChange(today.sumPesewas, yest.sumPesewas),
      thisWeekChangePct: pctChange(week.sumPesewas, lastWeek.sumPesewas),
      thisMonthChangePct: pctChange(month.sumPesewas, lastMonth.sumPesewas),
      numSalesToday: today.sumCount,
      numSalesThisWeek: week.sumCount,
      numSalesThisMonth: month.sumCount,
    },
    margin: {
      revenuePesewas: monthRev,
      cogsPesewas: marginMonth.cogsPesewas,
      grossMarginPesewas: marginMonth.marginPesewas,
      grossMarginBps: monthGmBps,
      revenueLast30dPesewas: rev30d,
      grossMarginLast30dPesewas: margin30d.marginPesewas,
      grossMarginLast30dBps: gm30dBps,
    },
    cashPosition: {
      openTillExpectedPesewas: openTillExpected,
      openShifts: openShiftsRow.length,
      lastClosedVariancePesewas: lastClosed?.variance ?? null,
      lastClosedAt: lastClosed?.closed_at ?? null,
    },
    receivables: {
      totalPesewas: receivablesTotal,
      bucket0_30Pesewas: recBucket0,
      bucket31_60Pesewas: recBucket1,
      bucket61_90Pesewas: recBucket2,
      bucket90PlusPesewas: recBucket3,
      customerCount: customerCounts.withBalance ?? 0,
      overLimitCount: customerCounts.overLimit ?? 0,
    },
    payables: {
      totalOwedPesewas: payables.totalOwed,
      supplierCount: payables.supplierCount ?? 0,
    },
    inventory: {
      totalAtCostPesewas: invAtCost,
      totalAtRetailPesewas: invAtRetail,
      activeSkuCount: invRows.length,
      belowReorderCount: belowReorder,
      stockoutCount: stockout,
    },
    revenueSparkline: sparkline,
    topSellersThisWeek: topSellers,
    slowMovers,
    recentVarianceEvents: recentVar,
  };
}

// =========================================================================
// Pass 2 reports — Sales, Margin, Inventory
// =========================================================================
//
// Each takes a date window (Pass 1's "asOfDate" is always now; here the
// caller supplies fromDate/toDate as inclusive YYYY-MM-DD). All three
// require the same role gate as the overview.

function dateRangeToISO(fromDate: string, toDate: string): { fromISO: string; toExclusiveISO: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new Error("date range must be YYYY-MM-DD");
  }
  if (toDate < fromDate) throw new Error("toDate before fromDate");
  // Convert to local-time boundaries: [from 00:00 local, to+1 00:00 local).
  const [fy, fm, fd] = fromDate.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = toDate.split('-').map(Number) as [number, number, number];
  const fromMidnightLocal = new Date(fy, fm - 1, fd, 0, 0, 0, 0);
  const toExclusiveLocal = new Date(ty, tm - 1, td + 1, 0, 0, 0, 0);
  return { fromISO: fromMidnightLocal.toISOString(), toExclusiveISO: toExclusiveLocal.toISOString() };
}

// --- Sales report --------------------------------------------------------

export type GroupBy = 'day' | 'week' | 'month';

export interface SalesReportInput {
  actorWorkerId: string;
  fromDate: string;   // YYYY-MM-DD inclusive
  toDate: string;     // YYYY-MM-DD inclusive
  groupBy: GroupBy;
}

export interface SalesReportBucket {
  /** YYYY-MM-DD for day, YYYY-Www for week (ISO-ish), YYYY-MM for month. */
  bucket: string;
  revenuePesewas: number;
  numSales: number;
  numUniqueCustomers: number;
  walkInPesewas: number;
  wholesalePesewas: number;
  routePesewas: number;
  /** "Avg basket" = revenue / numSales. NULL if no sales. */
  avgBasketPesewas: number | null;
}

export interface SalesByChannel { channel: string; revenuePesewas: number; numSales: number }
export interface SalesByPaymentMethod { method: string; revenuePesewas: number; numSales: number }
export interface SalesByCashier {
  workerId: string; workerName: string;
  revenuePesewas: number; numSales: number;
  voidedCount: number;
}

export interface SalesReportResult {
  fromDate: string;
  toDate: string;
  groupBy: GroupBy;
  totalRevenuePesewas: number;
  totalNumSales: number;
  totalUniqueCustomers: number;
  totalAvgBasketPesewas: number | null;
  buckets: SalesReportBucket[];
  byChannel: SalesByChannel[];
  byPaymentMethod: SalesByPaymentMethod[];
  byCashier: SalesByCashier[];
}

export function getSalesReport(db: DB, input: SalesReportInput): SalesReportResult {
  requireReportsActor(db, input.actorWorkerId);
  const { fromISO, toExclusiveISO } = dateRangeToISO(input.fromDate, input.toDate);

  const bucketExpr =
    input.groupBy === 'month' ? "strftime('%Y-%m', s.created_at, 'localtime')"
    : input.groupBy === 'week' ? "strftime('%Y-W%W', s.created_at, 'localtime')"
    : "date(s.created_at, 'localtime')";

  const bucketRows = db
    .prepare(
      `SELECT ${bucketExpr} AS bucket,
              COALESCE(SUM(s.total_pesewas), 0) AS revenuePesewas,
              COUNT(*) AS numSales,
              COUNT(DISTINCT s.customer_id) AS numUniqueCustomers,
              COALESCE(SUM(CASE WHEN s.channel = 'WALK_IN' THEN s.total_pesewas ELSE 0 END), 0) AS walkInPesewas,
              COALESCE(SUM(CASE WHEN s.channel = 'WHOLESALE' THEN s.total_pesewas ELSE 0 END), 0) AS wholesalePesewas,
              COALESCE(SUM(CASE WHEN s.channel = 'ROUTE' THEN s.total_pesewas ELSE 0 END), 0) AS routePesewas
         FROM sales s
         WHERE s.voided = 0
           AND s.created_at >= ? AND s.created_at < ?
         GROUP BY bucket
         ORDER BY bucket ASC`,
    )
    .all(fromISO, toExclusiveISO) as Array<Omit<SalesReportBucket, 'avgBasketPesewas'>>;

  const buckets: SalesReportBucket[] = bucketRows.map((b) => ({
    ...b,
    avgBasketPesewas: b.numSales > 0 ? Math.round(b.revenuePesewas / b.numSales) : null,
  }));

  const byChannel = db
    .prepare(
      `SELECT s.channel AS channel,
              COALESCE(SUM(s.total_pesewas), 0) AS revenuePesewas,
              COUNT(*) AS numSales
         FROM sales s
         WHERE s.voided = 0 AND s.created_at >= ? AND s.created_at < ?
         GROUP BY s.channel
         ORDER BY revenuePesewas DESC`,
    )
    .all(fromISO, toExclusiveISO) as SalesByChannel[];

  // Read tender-by-tender from sale_payments instead of bucketing the
  // whole sale by its "primary" (largest) tender. Without this, a sale
  // paid 70 cash + 30 MoMo would attribute 100 cedis to CASH and 0 to
  // MoMo — masking real MoMo throughput. SUM(amount_pesewas) gives the
  // honest revenue per method; COUNT(DISTINCT sale_id) keeps numSales
  // meaning "sales that touched this method" so the UI's "5 sales"
  // label stays accurate (vs. counting tenders, which would double-
  // count split-payment sales).
  const byPaymentMethod = db
    .prepare(
      `SELECT sp.payment_method AS method,
              COALESCE(SUM(sp.amount_pesewas), 0) AS revenuePesewas,
              COUNT(DISTINCT sp.sale_id) AS numSales
         FROM sale_payments sp
         JOIN sales s ON s.id = sp.sale_id
         WHERE s.voided = 0 AND s.created_at >= ? AND s.created_at < ?
         GROUP BY sp.payment_method
         ORDER BY revenuePesewas DESC`,
    )
    .all(fromISO, toExclusiveISO) as SalesByPaymentMethod[];

  // By cashier: include voided counts so the owner can spot suspicious cashiers.
  const byCashier = db
    .prepare(
      `SELECT w.id AS workerId, w.full_name AS workerName,
              COALESCE(SUM(CASE WHEN s.voided = 0 THEN s.total_pesewas ELSE 0 END), 0) AS revenuePesewas,
              SUM(CASE WHEN s.voided = 0 THEN 1 ELSE 0 END) AS numSales,
              SUM(CASE WHEN s.voided = 1 THEN 1 ELSE 0 END) AS voidedCount
         FROM sales s
         JOIN workers w ON w.id = s.worker_id
         WHERE s.created_at >= ? AND s.created_at < ?
         GROUP BY w.id
         HAVING numSales > 0 OR voidedCount > 0
         ORDER BY revenuePesewas DESC`,
    )
    .all(fromISO, toExclusiveISO) as SalesByCashier[];

  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(total_pesewas), 0) AS rev,
              COUNT(*) AS n,
              COUNT(DISTINCT customer_id) AS uniq
         FROM sales
         WHERE voided = 0 AND created_at >= ? AND created_at < ?`,
    )
    .get(fromISO, toExclusiveISO) as { rev: number; n: number; uniq: number };

  return {
    fromDate: input.fromDate,
    toDate: input.toDate,
    groupBy: input.groupBy,
    totalRevenuePesewas: totals.rev,
    totalNumSales: totals.n,
    totalUniqueCustomers: totals.uniq,
    totalAvgBasketPesewas: totals.n > 0 ? Math.round(totals.rev / totals.n) : null,
    buckets,
    byChannel,
    byPaymentMethod,
    byCashier,
  };
}

// --- Margin report -------------------------------------------------------

export interface MarginReportInput {
  actorWorkerId: string;
  fromDate: string;
  toDate: string;
}

export interface MarginPerProduct {
  productId: string; sku: string; name: string; category: string; brand: string | null;
  unitsSold: number;
  revenuePesewas: number;
  cogsPesewas: number;
  marginPesewas: number;
  marginBps: number;  // basis points
}

export interface MarginPerCategory {
  category: string;
  unitsSold: number;
  revenuePesewas: number;
  cogsPesewas: number;
  marginPesewas: number;
  marginBps: number;
  productCount: number;
}

export interface MarginReportResult {
  fromDate: string;
  toDate: string;
  totalRevenuePesewas: number;
  totalCogsPesewas: number;
  totalMarginPesewas: number;
  totalMarginBps: number;
  byProduct: MarginPerProduct[];
  byCategory: MarginPerCategory[];
  /** Lines sold at negative margin (below cost). Each row is a single line. */
  belowCost: {
    numLines: number;
    totalLossPesewas: number;   // positive number = how much margin we lost
    worst: Array<{
      saleId: string;
      saleAt: string;
      productId: string; sku: string; name: string;
      quantity: number;
      unitPricePesewas: number;
      unitCostPesewas: number;
      marginPesewas: number;     // negative
      workerName: string;
    }>;
  };
}

export function getMarginReport(db: DB, input: MarginReportInput): MarginReportResult {
  requireReportsActor(db, input.actorWorkerId);
  const { fromISO, toExclusiveISO } = dateRangeToISO(input.fromDate, input.toDate);

  const byProductRows = db
    .prepare(
      `SELECT p.id AS productId, p.sku, p.name, p.category, p.brand,
              SUM(sl.quantity) AS unitsSold,
              SUM(sl.line_total_pesewas) AS revenuePesewas,
              SUM(sl.unit_cost_pesewas * sl.quantity) AS cogsPesewas,
              SUM(sl.margin_pesewas) AS marginPesewas
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN products p ON p.id = sl.product_id
         WHERE s.voided = 0
           AND s.created_at >= ? AND s.created_at < ?
         GROUP BY p.id
         ORDER BY marginPesewas DESC`,
    )
    .all(fromISO, toExclusiveISO) as Array<Omit<MarginPerProduct, 'marginBps'>>;

  const byProduct: MarginPerProduct[] = byProductRows.map((r) => ({
    ...r,
    marginBps: r.revenuePesewas > 0 ? Math.round((r.marginPesewas / r.revenuePesewas) * 10000) : 0,
  }));

  const byCategoryRows = db
    .prepare(
      `SELECT p.category AS category,
              SUM(sl.quantity) AS unitsSold,
              SUM(sl.line_total_pesewas) AS revenuePesewas,
              SUM(sl.unit_cost_pesewas * sl.quantity) AS cogsPesewas,
              SUM(sl.margin_pesewas) AS marginPesewas,
              COUNT(DISTINCT p.id) AS productCount
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN products p ON p.id = sl.product_id
         WHERE s.voided = 0
           AND s.created_at >= ? AND s.created_at < ?
         GROUP BY p.category
         ORDER BY marginPesewas DESC`,
    )
    .all(fromISO, toExclusiveISO) as Array<Omit<MarginPerCategory, 'marginBps'>>;

  const byCategory: MarginPerCategory[] = byCategoryRows.map((r) => ({
    ...r,
    marginBps: r.revenuePesewas > 0 ? Math.round((r.marginPesewas / r.revenuePesewas) * 10000) : 0,
  }));

  const belowCostSummary = db
    .prepare(
      `SELECT COUNT(*) AS numLines,
              COALESCE(SUM(-sl.margin_pesewas), 0) AS totalLossPesewas
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         WHERE s.voided = 0
           AND s.created_at >= ? AND s.created_at < ?
           AND sl.margin_pesewas < 0`,
    )
    .get(fromISO, toExclusiveISO) as { numLines: number; totalLossPesewas: number };

  const belowCostWorst = db
    .prepare(
      `SELECT s.id AS saleId, s.created_at AS saleAt,
              p.id AS productId, p.sku, p.name,
              sl.quantity, sl.unit_price_pesewas AS unitPricePesewas,
              sl.unit_cost_pesewas AS unitCostPesewas,
              sl.margin_pesewas AS marginPesewas,
              w.full_name AS workerName
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN products p ON p.id = sl.product_id
         JOIN workers w ON w.id = s.worker_id
         WHERE s.voided = 0
           AND s.created_at >= ? AND s.created_at < ?
           AND sl.margin_pesewas < 0
         ORDER BY sl.margin_pesewas ASC
         LIMIT 10`,
    )
    .all(fromISO, toExclusiveISO) as MarginReportResult['belowCost']['worst'];

  const totals = byProduct.reduce(
    (acc, r) => ({
      rev: acc.rev + r.revenuePesewas,
      cogs: acc.cogs + r.cogsPesewas,
      margin: acc.margin + r.marginPesewas,
    }),
    { rev: 0, cogs: 0, margin: 0 },
  );

  return {
    fromDate: input.fromDate,
    toDate: input.toDate,
    totalRevenuePesewas: totals.rev,
    totalCogsPesewas: totals.cogs,
    totalMarginPesewas: totals.margin,
    totalMarginBps: totals.rev > 0 ? Math.round((totals.margin / totals.rev) * 10000) : 0,
    byProduct,
    byCategory,
    belowCost: {
      numLines: belowCostSummary.numLines,
      totalLossPesewas: belowCostSummary.totalLossPesewas,
      worst: belowCostWorst,
    },
  };
}

// --- Inventory report ----------------------------------------------------

export interface InventoryReportInput {
  actorWorkerId: string;
  locationId?: string;
  /** Window for the "units sold" rate that drives days-of-supply. Default 30. */
  velocityWindowDays?: number;
}

export interface InventoryRow {
  productId: string; sku: string; name: string;
  category: string; brand: string | null;
  unitsOnHand: number;
  costPerUnitPesewas: number;
  retailPerUnitPesewas: number;
  totalAtCostPesewas: number;
  totalAtRetailPesewas: number;
  reorderThreshold: number;
  belowReorder: boolean;
  stockout: boolean;
  unitsSoldInWindow: number;       // units in the velocity window
  /** unitsOnHand / (unitsSoldInWindow / windowDays). NULL if no sales in window. */
  daysOfSupply: number | null;
  lastReceivedAt: string | null;
  lastSoldAt: string | null;
}

export interface InventoryReportResult {
  generatedAt: string;
  locationId: string;
  velocityWindowDays: number;
  totalAtCostPesewas: number;
  totalAtRetailPesewas: number;
  activeSkuCount: number;
  stockoutCount: number;
  belowReorderCount: number;
  rows: InventoryRow[];
}

export function getInventoryReport(db: DB, input: InventoryReportInput): InventoryReportResult {
  requireReportsActor(db, input.actorWorkerId);
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  const windowDays = Math.max(1, Math.min(365, input.velocityWindowDays ?? 30));
  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - windowDays);

  const rows = db
    .prepare(
      `SELECT p.id AS productId, p.sku, p.name, p.category, p.brand,
              p.cost_price_pesewas AS costPerUnitPesewas,
              p.walk_in_price_pesewas AS retailPerUnitPesewas,
              p.reorder_threshold AS reorderThreshold,
              COALESCE(SUM(sm.quantity), 0) AS unitsOnHand,
              (SELECT MAX(created_at) FROM stock_movements
                 WHERE product_id = p.id AND location_id = ?
                   AND reason_code IN ('RECEIVED_FROM_SUPPLIER','OPENING_STOCK'))
                AS lastReceivedAt,
              (SELECT MAX(s.created_at) FROM sale_lines sl
                 JOIN sales s ON s.id = sl.sale_id
                 WHERE sl.product_id = p.id AND s.voided = 0)
                AS lastSoldAt,
              (SELECT COALESCE(SUM(sl.quantity), 0)
                 FROM sale_lines sl
                 JOIN sales s ON s.id = sl.sale_id
                 WHERE sl.product_id = p.id AND s.voided = 0
                   AND s.created_at >= ?)
                AS unitsSoldInWindow
         FROM products p
         LEFT JOIN stock_movements sm
           ON sm.product_id = p.id AND sm.location_id = ?
         WHERE p.deleted_at IS NULL AND p.active = 1
         GROUP BY p.id
         ORDER BY p.name ASC`,
    )
    .all(locationId, windowStart.toISOString(), locationId) as Array<
      Omit<InventoryRow, 'totalAtCostPesewas' | 'totalAtRetailPesewas' | 'belowReorder' | 'stockout' | 'daysOfSupply'>
    >;

  let totalAtCost = 0, totalAtRetail = 0;
  let stockoutCount = 0, belowReorderCount = 0;
  const enriched: InventoryRow[] = rows.map((r) => {
    const stockout = r.unitsOnHand <= 0;
    const belowReorder = !stockout && r.reorderThreshold > 0 && r.unitsOnHand <= r.reorderThreshold;
    if (stockout) stockoutCount++;
    if (belowReorder) belowReorderCount++;
    const atCost = Math.max(0, r.unitsOnHand) * r.costPerUnitPesewas;
    const atRetail = Math.max(0, r.unitsOnHand) * r.retailPerUnitPesewas;
    totalAtCost += atCost;
    totalAtRetail += atRetail;
    const daysOfSupply = r.unitsSoldInWindow > 0 && r.unitsOnHand > 0
      ? Math.round((r.unitsOnHand / (r.unitsSoldInWindow / windowDays)) * 10) / 10
      : null;
    return {
      ...r,
      totalAtCostPesewas: atCost,
      totalAtRetailPesewas: atRetail,
      belowReorder,
      stockout,
      daysOfSupply,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    locationId,
    velocityWindowDays: windowDays,
    totalAtCostPesewas: totalAtCost,
    totalAtRetailPesewas: totalAtRetail,
    activeSkuCount: enriched.length,
    stockoutCount,
    belowReorderCount,
    rows: enriched,
  };
}
