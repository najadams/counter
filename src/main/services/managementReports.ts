// Owner Management Pack reports.
//
// Sensitive management statements are OWNER/FOUNDER-only and always carry a
// data-quality assessment. Post-cutover statements read the immutable ledger;
// pre-cutover operating history remains explicitly labelled as a legacy
// estimate rather than being presented as reconstructed cash truth.

import type { Database as DB } from 'better-sqlite3';
import { DEFAULT_LOCATION_ID } from '../../shared/lib/constants.js';
import { creditPrincipalExpr } from './customerCredit.js';
import {
  getFinancialDataQuality,
  listFinancialAccounts,
  type DataQualityResult,
  type FinancialAccountRow,
} from './ledger.js';
import { logAudit } from '../db/audit.js';

export type ReportBasis = 'ACCRUAL' | 'CASH';

export interface ManagementAccessInput {
  actorWorkerId: string;
  deviceId: string;
  locationId?: string;
}

function requireManagementAccess(
  db: DB,
  input: ManagementAccessInput,
  report: string,
  period: Record<string, string>,
): string {
  const worker = db.prepare(
    `SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?`,
  ).get(input.actorWorkerId) as {
    role: string; active: number; deleted_at: string | null; terminated_at: string | null;
  } | undefined;
  if (!worker || worker.active !== 1 || worker.deleted_at || worker.terminated_at) {
    throw new Error('management report: actor not active');
  }
  if (worker.role !== 'OWNER' && worker.role !== 'FOUNDER') {
    throw new Error('management reports require OWNER or FOUNDER');
  }
  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'MANAGEMENT_REPORT_VIEWED',
    entityType: 'reports',
    entityId: report.toLowerCase(),
    afterValue: { report, ...period },
    deviceId: input.deviceId,
  });
  return input.locationId ?? DEFAULT_LOCATION_ID;
}

function assertDate(label: string, value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
}

function dateRange(fromDate: string, toDate: string): { fromISO: string; toExclusiveISO: string } {
  assertDate('fromDate', fromDate);
  assertDate('toDate', toDate);
  if (toDate < fromDate) throw new Error('toDate must be on or after fromDate');
  const from = new Date(`${fromDate}T00:00:00.000Z`);
  const to = new Date(`${toDate}T00:00:00.000Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  return { fromISO: from.toISOString(), toExclusiveISO: to.toISOString() };
}

function addDaysISO(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysInclusive(fromDate: string, toDate: string): number {
  return Math.max(
    1,
    Math.round(
      (new Date(`${toDate}T00:00:00.000Z`).getTime()
        - new Date(`${fromDate}T00:00:00.000Z`).getTime()) / 86_400_000,
    ) + 1,
  );
}

function pctChange(current: number, prior: number): number | null {
  if (prior === 0) return current === 0 ? 0 : null;
  return Math.round(((current - prior) / Math.abs(prior)) * 10_000) / 100;
}

export interface ManagementLine {
  code: string;
  label: string;
  amountPesewas: number;
  comparisonPesewas?: number;
  note?: string | null;
}

interface LedgerAmountRow {
  code: string;
  name: string;
  accountClass: string;
  accountSubtype: string;
  amountPesewas: number;
}

function ledgerAmountsForPeriod(
  db: DB,
  locationId: string,
  fromDate: string,
  toDate: string,
): LedgerAmountRow[] {
  return db.prepare(
    `SELECT la.code, la.name, la.account_class AS accountClass,
            la.account_subtype AS accountSubtype,
            CASE
              WHEN la.normal_balance = 'DEBIT'
                THEN COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit_pesewas - jl.credit_pesewas ELSE 0 END), 0)
              ELSE COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit_pesewas - jl.debit_pesewas ELSE 0 END), 0)
            END AS amountPesewas
       FROM ledger_accounts la
       LEFT JOIN journal_lines jl ON jl.ledger_account_id = la.id
       LEFT JOIN journal_entries je
         ON je.id = jl.journal_entry_id
        AND je.status = 'POSTED'
        AND je.business_date >= ?
        AND je.business_date <= ?
      WHERE la.location_id = ? AND la.active = 1
      GROUP BY la.id
      ORDER BY la.code`,
  ).all(fromDate, toDate, locationId) as LedgerAmountRow[];
}

function amountByCode(rows: LedgerAmountRow[], code: string): number {
  return rows.find((row) => row.code === code)?.amountPesewas ?? 0;
}

function sumWhere(rows: LedgerAmountRow[], predicate: (row: LedgerAmountRow) => boolean): number {
  return rows.filter(predicate).reduce((sum, row) => sum + row.amountPesewas, 0);
}

function legacyAccrual(
  db: DB,
  locationId: string,
  fromISO: string,
  toExclusiveISO: string,
): {
  netSales: number; cogs: number; deliveryIncome: number; otherIncome: number;
  operatingExpenses: ManagementLine[]; inventoryLosses: ManagementLine[];
  depreciation: number; financeCosts: number; incomeTax: number;
} {
  const sales = db.prepare(
    `SELECT COALESCE(SUM(total_pesewas - vat_pesewas - nhil_pesewas - getfund_pesewas), 0) AS netSales
       FROM sales
      WHERE location_id = ? AND voided = 0 AND created_at >= ? AND created_at < ?`,
  ).get(locationId, fromISO, toExclusiveISO) as { netSales: number };
  const cogs = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN sl.line_cogs_pesewas > 0
                             THEN sl.line_cogs_pesewas
                             ELSE sl.unit_cost_pesewas * sl.quantity END), 0) AS cogs
       FROM sale_lines sl
       JOIN sales s ON s.id = sl.sale_id
      WHERE s.location_id = ? AND s.voided = 0
        AND s.created_at >= ? AND s.created_at < ?`,
  ).get(locationId, fromISO, toExclusiveISO) as { cogs: number };
  const legacyExpenses = db.prepare(
    `SELECT category, COALESCE(SUM(amount_pesewas), 0) AS amountPesewas
       FROM petty_cash_expenses
      WHERE location_id = ? AND created_at >= ? AND created_at < ?
      GROUP BY category`,
  ).all(locationId, fromISO, toExclusiveISO) as Array<{ category: string; amountPesewas: number }>;
  const newExpenses = db.prepare(
    `SELECT category, COALESCE(SUM(amount_pesewas), 0) AS amountPesewas
       FROM business_expenses
      WHERE location_id = ? AND payment_status != 'VOID'
        AND incurred_date >= date(?) AND incurred_date < date(?)
      GROUP BY category`,
  ).all(locationId, fromISO, toExclusiveISO) as Array<{ category: string; amountPesewas: number }>;
  const expenseMap = new Map<string, number>();
  for (const row of [...legacyExpenses, ...newExpenses]) {
    expenseMap.set(row.category, (expenseMap.get(row.category) ?? 0) + row.amountPesewas);
  }
  const depreciation = expenseMap.get('DEPRECIATION') ?? 0;
  const financeCosts = (expenseMap.get('INTEREST') ?? 0) + (expenseMap.get('BANK_FEES') ?? 0);
  const incomeTax = expenseMap.get('INCOME_TAX') ?? 0;
  expenseMap.delete('DEPRECIATION');
  expenseMap.delete('INTEREST');
  expenseMap.delete('INCOME_TAX');
  expenseMap.delete('BANK_FEES');

  const lossRows = db.prepare(
    `SELECT reason_code AS reason,
            COALESCE(SUM(ABS(total_value_pesewas)), 0) AS amountPesewas
       FROM stock_movements
      WHERE location_id = ? AND created_at >= ? AND created_at < ?
        AND reason_code IN (
          'BREAKAGE','EXPIRED','THEFT_CONFIRMED','STOCKTAKE_VARIANCE_LOSS',
          'WORKER_CONSUMED_FREE','WORKER_CONSUMED_PAID'
        )
      GROUP BY reason_code`,
  ).all(locationId, fromISO, toExclusiveISO) as Array<{ reason: string; amountPesewas: number }>;
  const delivery = db.prepare(
    `SELECT COALESCE(SUM(delivery_fee_pesewas), 0) AS income
       FROM pending_orders
      WHERE delivery_status = 'DELIVERED'
        AND delivered_at >= ? AND delivered_at < ?`,
  ).get(fromISO, toExclusiveISO) as { income: number };

  return {
    netSales: sales.netSales,
    cogs: cogs.cogs,
    deliveryIncome: delivery.income,
    otherIncome: 0,
    operatingExpenses: Array.from(expenseMap.entries())
      .map(([code, amountPesewas]) => ({ code, label: code.replace(/_/g, ' '), amountPesewas }))
      .sort((a, b) => b.amountPesewas - a.amountPesewas),
    inventoryLosses: lossRows.map((row) => ({
      code: row.reason,
      label: row.reason.replace(/_/g, ' '),
      amountPesewas: row.amountPesewas,
    })),
    depreciation,
    financeCosts,
    incomeTax,
  };
}

export interface IncomeStatementResult {
  generatedAt: string;
  fromDate: string;
  toDate: string;
  locationId: string;
  basis: ReportBasis;
  legacyEstimate: boolean;
  dataQuality: DataQualityResult;
  accrual: {
    netSalesPesewas: number;
    cogsPesewas: number;
    grossProfitPesewas: number;
    grossMarginBps: number;
    otherOperatingIncomePesewas: number;
    operatingExpensesPesewas: number;
    inventoryLossesPesewas: number;
    operatingProfitPesewas: number;
    depreciationPesewas: number;
    financeCostsPesewas: number;
    profitBeforeIncomeTaxPesewas: number;
    incomeTaxExpensePesewas: number;
    netManagementProfitPesewas: number;
    comparisonNetManagementProfitPesewas: number;
    changePct: number | null;
    operatingExpenseLines: ManagementLine[];
    inventoryLossLines: ManagementLine[];
  };
  cash: {
    customerCashReceivedPesewas: number;
    inventoryCashPaidPesewas: number;
    operatingExpensesPaidPesewas: number;
    taxPaidPesewas: number;
    cashOperatingSurplusPesewas: number;
    accrualToCashDifferencePesewas: number;
    reconciliationLines: ManagementLine[];
  };
}

function accrualForRange(
  db: DB,
  locationId: string,
  fromDate: string,
  toDate: string,
): Omit<IncomeStatementResult['accrual'], 'comparisonNetManagementProfitPesewas' | 'changePct'> & {
  legacyEstimate: boolean;
} {
  const { fromISO, toExclusiveISO } = dateRange(fromDate, toDate);
  const cutover = db.prepare(
    `SELECT cutover_date AS cutoverDate, status FROM financial_cutovers WHERE location_id = ?`,
  ).get(locationId) as { cutoverDate: string; status: string } | undefined;
  const useLedger = !!cutover && cutover.status === 'ACTIVE' && fromDate >= cutover.cutoverDate;

  let netSales: number;
  let cogs: number;
  let deliveryIncome: number;
  let otherIncome: number;
  let operatingExpenseLines: ManagementLine[];
  let inventoryLossLines: ManagementLine[];
  let depreciation: number;
  let financeCosts: number;
  let incomeTax: number;

  if (useLedger) {
    const rows = ledgerAmountsForPeriod(db, locationId, fromDate, toDate);
    netSales = amountByCode(rows, 'SALES_NET');
    cogs = amountByCode(rows, 'COGS');
    deliveryIncome = amountByCode(rows, 'DELIVERY_INCOME');
    otherIncome = amountByCode(rows, 'OTHER_INCOME') + amountByCode(rows, 'INVENTORY_GAIN')
      + amountByCode(rows, 'GAIN_ASSET_DISPOSAL');
    depreciation = amountByCode(rows, 'DEPRECIATION_EXPENSE');
    financeCosts = amountByCode(rows, 'INTEREST_EXPENSE') + amountByCode(rows, 'EXP_BANK_FEES');
    incomeTax = amountByCode(rows, 'INCOME_TAX_EXPENSE');
    const inventoryLossCodes = new Set([
      'LOSS_BREAKAGE', 'LOSS_EXPIRY', 'LOSS_THEFT', 'LOSS_SHRINKAGE', 'LOSS_CONSUMPTION',
    ]);
    inventoryLossLines = rows
      .filter((row) => inventoryLossCodes.has(row.code) && row.amountPesewas !== 0)
      .map((row) => ({ code: row.code, label: row.name, amountPesewas: row.amountPesewas }));
    const excluded = new Set([
      'DEPRECIATION_EXPENSE', 'INTEREST_EXPENSE', 'INCOME_TAX_EXPENSE',
      'EXP_BANK_FEES', 'CASH_OVER_SHORT',
      ...inventoryLossLines.map((line) => line.code),
    ]);
    operatingExpenseLines = rows
      .filter((row) => row.accountClass === 'EXPENSE' && !excluded.has(row.code) && row.amountPesewas !== 0)
      .map((row) => ({ code: row.code, label: row.name, amountPesewas: row.amountPesewas }));
    const cashVariance = amountByCode(rows, 'CASH_OVER_SHORT');
    if (cashVariance !== 0) {
      operatingExpenseLines.push({
        code: 'CASH_OVER_SHORT',
        label: 'Cash over or short',
        amountPesewas: cashVariance,
      });
    }
  } else {
    const legacy = legacyAccrual(db, locationId, fromISO, toExclusiveISO);
    netSales = legacy.netSales;
    cogs = legacy.cogs;
    deliveryIncome = legacy.deliveryIncome;
    otherIncome = legacy.otherIncome;
    operatingExpenseLines = legacy.operatingExpenses;
    inventoryLossLines = legacy.inventoryLosses;
    depreciation = legacy.depreciation;
    financeCosts = legacy.financeCosts;
    incomeTax = legacy.incomeTax;
  }
  const grossProfit = netSales - cogs;
  const operatingExpenses = operatingExpenseLines.reduce((sum, row) => sum + row.amountPesewas, 0);
  const inventoryLosses = inventoryLossLines.reduce((sum, row) => sum + row.amountPesewas, 0);
  const operatingProfit = grossProfit + deliveryIncome + otherIncome - operatingExpenses - inventoryLosses;
  const profitBeforeTax = operatingProfit - depreciation - financeCosts;
  return {
    legacyEstimate: !useLedger,
    netSalesPesewas: netSales,
    cogsPesewas: cogs,
    grossProfitPesewas: grossProfit,
    grossMarginBps: netSales > 0 ? Math.round((grossProfit * 10_000) / netSales) : 0,
    otherOperatingIncomePesewas: deliveryIncome + otherIncome,
    operatingExpensesPesewas: operatingExpenses,
    inventoryLossesPesewas: inventoryLosses,
    operatingProfitPesewas: operatingProfit,
    depreciationPesewas: depreciation,
    financeCostsPesewas: financeCosts,
    profitBeforeIncomeTaxPesewas: profitBeforeTax,
    incomeTaxExpensePesewas: incomeTax,
    netManagementProfitPesewas: profitBeforeTax - incomeTax,
    operatingExpenseLines,
    inventoryLossLines,
  };
}

export function getIncomeStatement(
  db: DB,
  input: ManagementAccessInput & { fromDate: string; toDate: string; basis?: ReportBasis },
): IncomeStatementResult {
  const locationId = requireManagementAccess(db, input, 'INCOME_STATEMENT', {
    fromDate: input.fromDate,
    toDate: input.toDate,
    basis: input.basis ?? 'ACCRUAL',
  });
  const { fromISO, toExclusiveISO } = dateRange(input.fromDate, input.toDate);
  const days = daysInclusive(input.fromDate, input.toDate);
  const priorTo = addDaysISO(input.fromDate, -1);
  const priorFrom = addDaysISO(priorTo, -(days - 1));
  const current = accrualForRange(db, locationId, input.fromDate, input.toDate);
  const prior = accrualForRange(db, locationId, priorFrom, priorTo);

  const cashSales = (db.prepare(
    `SELECT COALESCE(SUM(sp.amount_pesewas), 0) AS total
       FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
      WHERE s.location_id = ? AND s.voided = 0
        AND s.created_at >= ? AND s.created_at < ?
        AND sp.payment_method != 'CREDIT'`,
  ).get(locationId, fromISO, toExclusiveISO) as { total: number }).total;
  const collections = (db.prepare(
    `SELECT COALESCE(SUM(cp.amount_pesewas), 0) AS total
       FROM customer_payments cp
       LEFT JOIN shifts sh ON sh.id = cp.shift_id
      WHERE COALESCE(sh.location_id, ?) = ?
        AND cp.received_at >= ? AND cp.received_at < ?
        AND cp.payment_method != 'RETURN_CREDIT'`,
  ).get(locationId, locationId, fromISO, toExclusiveISO) as { total: number }).total;
  const inventoryPaid = (db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
       FROM supplier_payments WHERE paid_at >= ? AND paid_at < ?`,
  ).get(fromISO, toExclusiveISO) as { total: number }).total;
  const legacyExpensePaid = (db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
       FROM petty_cash_expenses
      WHERE location_id = ? AND created_at >= ? AND created_at < ?`,
  ).get(locationId, fromISO, toExclusiveISO) as { total: number }).total;
  const newExpensePaid = (db.prepare(
    `SELECT COALESCE(SUM(ep.amount_pesewas), 0) AS total
       FROM expense_payments ep
       JOIN business_expenses be ON be.id = ep.business_expense_id
      WHERE be.location_id = ? AND ep.paid_at >= ? AND ep.paid_at < ?`,
  ).get(locationId, fromISO, toExclusiveISO) as { total: number }).total;
  const taxPaid = (db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
       FROM tax_payments
      WHERE location_id = ? AND paid_at >= ? AND paid_at < ?`,
  ).get(locationId, fromISO, toExclusiveISO) as { total: number }).total;
  const customerCash = cashSales + collections;
  const operatingExpensePaid = legacyExpensePaid + newExpensePaid;
  const cashSurplus = customerCash - inventoryPaid - operatingExpensePaid - taxPaid;
  const accrualToCashDifference = cashSurplus - current.netManagementProfitPesewas;

  return {
    generatedAt: new Date().toISOString(),
    fromDate: input.fromDate,
    toDate: input.toDate,
    locationId,
    basis: input.basis ?? 'ACCRUAL',
    legacyEstimate: current.legacyEstimate,
    dataQuality: getFinancialDataQuality(db, {
      locationId, fromDate: input.fromDate, toDate: input.toDate, reportKind: 'PROFIT',
    }),
    accrual: {
      ...current,
      comparisonNetManagementProfitPesewas: prior.netManagementProfitPesewas,
      changePct: pctChange(current.netManagementProfitPesewas, prior.netManagementProfitPesewas),
    },
    cash: {
      customerCashReceivedPesewas: customerCash,
      inventoryCashPaidPesewas: inventoryPaid,
      operatingExpensesPaidPesewas: operatingExpensePaid,
      taxPaidPesewas: taxPaid,
      cashOperatingSurplusPesewas: cashSurplus,
      accrualToCashDifferencePesewas: accrualToCashDifference,
      reconciliationLines: [
        {
          code: 'ACCRUAL_PROFIT',
          label: 'Net management profit',
          amountPesewas: current.netManagementProfitPesewas,
        },
        {
          code: 'WORKING_CAPITAL_TIMING',
          label: 'Working-capital and payment timing',
          amountPesewas: accrualToCashDifference,
          note: 'Receivables, inventory purchases, payables, tax timing, and non-cash costs.',
        },
        { code: 'CASH_SURPLUS', label: 'Cash operating surplus', amountPesewas: cashSurplus },
      ],
    },
  };
}

export interface ManagementBalanceSheetResult {
  generatedAt: string;
  asOfDate: string;
  locationId: string;
  legacyEstimate: boolean;
  dataQuality: DataQualityResult;
  assets: { totalPesewas: number; currentPesewas: number; lines: ManagementLine[] };
  liabilities: {
    totalPesewas: number;
    currentPesewas: number;
    nonCurrentPesewas: number;
    lines: ManagementLine[];
  };
  equity: { totalPesewas: number; lines: ManagementLine[] };
  workingCapitalPesewas: number;
  currentRatioBps: number | null;
  equationDifferencePesewas: number;
  integrityOk: boolean;
}

function ledgerBalancesAsOf(db: DB, locationId: string, fromDate: string, asOfDate: string): LedgerAmountRow[] {
  return db.prepare(
    `SELECT la.code, la.name, la.account_class AS accountClass,
            la.account_subtype AS accountSubtype,
            CASE
              WHEN la.normal_balance = 'DEBIT'
                THEN COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.debit_pesewas - jl.credit_pesewas ELSE 0 END), 0)
              ELSE COALESCE(SUM(CASE WHEN je.id IS NOT NULL THEN jl.credit_pesewas - jl.debit_pesewas ELSE 0 END), 0)
            END AS amountPesewas
       FROM ledger_accounts la
       LEFT JOIN journal_lines jl ON jl.ledger_account_id = la.id
       LEFT JOIN journal_entries je
         ON je.id = jl.journal_entry_id
        AND je.status = 'POSTED'
        AND je.business_date >= ?
        AND je.business_date <= ?
      WHERE la.location_id = ? AND la.active = 1
      GROUP BY la.id ORDER BY la.code`,
  ).all(fromDate, asOfDate, locationId) as LedgerAmountRow[];
}

export function getManagementBalanceSheet(
  db: DB,
  input: ManagementAccessInput & { asOfDate: string },
): ManagementBalanceSheetResult {
  assertDate('asOfDate', input.asOfDate);
  const locationId = requireManagementAccess(db, input, 'MANAGEMENT_BALANCE_SHEET', {
    asOfDate: input.asOfDate,
  });
  const cutover = db.prepare(
    `SELECT cutover_date AS cutoverDate, status FROM financial_cutovers WHERE location_id = ?`,
  ).get(locationId) as { cutoverDate: string; status: string } | undefined;
  const useLedger = !!cutover && cutover.status === 'ACTIVE' && input.asOfDate >= cutover.cutoverDate;
  if (!useLedger) {
    // Keep the existing operational balance sheet available, but make the
    // incompleteness impossible to miss.
    const inventory = (db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN q > 0 THEN q * cost ELSE 0 END), 0) AS total
         FROM (
           SELECT p.id, p.cost_price_pesewas AS cost, COALESCE(SUM(sm.quantity), 0) AS q
             FROM products p
             LEFT JOIN stock_movements sm ON sm.product_id = p.id
               AND sm.location_id = ? AND date(sm.created_at) <= ?
            WHERE p.active = 1 AND p.deleted_at IS NULL GROUP BY p.id
         )`,
    ).get(locationId, input.asOfDate) as { total: number }).total;
    const receivables = (db.prepare(
      `SELECT COALESCE(SUM(outstanding), 0) AS total FROM (
         SELECT MAX(0, ${creditPrincipalExpr('s')} -
           COALESCE((SELECT SUM(amount_pesewas) FROM customer_payment_allocations
                     WHERE sale_id = s.id AND date(created_at) <= ?), 0)) AS outstanding
           FROM sales s WHERE s.location_id = ? AND s.is_credit = 1
             AND s.voided = 0 AND date(s.created_at) <= ?
       )`,
    ).get(input.asOfDate, locationId, input.asOfDate) as { total: number }).total;
    const payables = (db.prepare(
      `SELECT COALESCE(SUM(MAX(0, total_pesewas - total_paid_pesewas)), 0) AS total
         FROM supplier_invoices
        WHERE status != 'VOID' AND invoice_date <= ?`,
    ).get(input.asOfDate) as { total: number }).total;
    const assets = inventory + receivables;
    const equity = assets - payables;
    return {
      generatedAt: new Date().toISOString(),
      asOfDate: input.asOfDate,
      locationId,
      legacyEstimate: true,
      dataQuality: getFinancialDataQuality(db, {
        locationId, asOfDate: input.asOfDate, reportKind: 'POSITION',
      }),
      assets: {
        totalPesewas: assets,
        currentPesewas: assets,
        lines: [
          { code: 'INVENTORY', label: 'Inventory at current recorded cost', amountPesewas: inventory },
          { code: 'AR', label: 'Customer receivables', amountPesewas: receivables },
        ],
      },
      liabilities: {
        totalPesewas: payables,
        currentPesewas: payables,
        nonCurrentPesewas: 0,
        lines: [{ code: 'AP_TRADE', label: 'Supplier payables', amountPesewas: payables }],
      },
      equity: {
        totalPesewas: equity,
        lines: [{ code: 'LEGACY_POSITION', label: 'Legacy recorded position', amountPesewas: equity }],
      },
      workingCapitalPesewas: assets - payables,
      currentRatioBps: payables > 0 ? Math.round((assets * 10_000) / payables) : null,
      equationDifferencePesewas: 0,
      integrityOk: true,
    };
  }

  const rows = ledgerBalancesAsOf(db, locationId, cutover.cutoverDate, input.asOfDate)
    .map((row) => ({
      ...row,
      amountPesewas: row.accountSubtype === 'CONTRA_ASSET' || row.accountSubtype === 'CONTRA_EQUITY'
        ? -row.amountPesewas
        : row.amountPesewas,
    }));
  const assetRows = rows.filter((row) => row.accountClass === 'ASSET' && row.amountPesewas !== 0);
  const liabilityRows = rows.filter((row) => row.accountClass === 'LIABILITY' && row.amountPesewas !== 0);
  const equityRows = rows.filter((row) => row.accountClass === 'EQUITY' && row.amountPesewas !== 0);
  const currentEarnings = sumWhere(rows, (row) => row.accountClass === 'REVENUE')
    - sumWhere(rows, (row) => row.accountClass === 'COGS' || row.accountClass === 'EXPENSE');
  const assets = assetRows.reduce((sum, row) => sum + row.amountPesewas, 0);
  const liabilities = liabilityRows.reduce((sum, row) => sum + row.amountPesewas, 0);
  const recordedEquity = equityRows.reduce((sum, row) => sum + row.amountPesewas, 0);
  const totalEquity = recordedEquity + currentEarnings;
  const currentAssets = assetRows
    .filter((row) => !['FIXED_ASSET', 'CONTRA_ASSET', 'OTHER_ASSET'].includes(row.accountSubtype))
    .reduce((sum, row) => sum + row.amountPesewas, 0);
  const nonCurrentLoan = (db.prepare(
    `SELECT COALESCE(SUM(MAX(0, o.principal_pesewas - COALESCE((
       SELECT SUM(oa.principal_pesewas) FROM obligation_allocations oa
        WHERE oa.obligation_id = o.id
     ), 0))), 0) AS total
       FROM obligations o
      WHERE o.location_id = ? AND o.status IN ('OPEN','PARTIALLY_PAID','DISPUTED')
        AND o.obligation_type IN ('LOAN_INSTALLMENT','OWNER_LOAN_INSTALLMENT')
        AND o.due_date > date(?, '+365 days')`,
  ).get(locationId, input.asOfDate) as { total: number }).total;
  const currentLiabilities = Math.max(0, liabilities - nonCurrentLoan);
  const difference = assets - liabilities - totalEquity;
  return {
    generatedAt: new Date().toISOString(),
    asOfDate: input.asOfDate,
    locationId,
    legacyEstimate: false,
    dataQuality: getFinancialDataQuality(db, {
      locationId, asOfDate: input.asOfDate, reportKind: 'POSITION',
    }),
    assets: {
      totalPesewas: assets,
      currentPesewas: currentAssets,
      lines: assetRows.map((row) => ({
        code: row.code, label: row.name, amountPesewas: row.amountPesewas,
      })),
    },
    liabilities: {
      totalPesewas: liabilities,
      currentPesewas: currentLiabilities,
      nonCurrentPesewas: nonCurrentLoan,
      lines: liabilityRows.map((row) => ({
        code: row.code, label: row.name, amountPesewas: row.amountPesewas,
      })),
    },
    equity: {
      totalPesewas: totalEquity,
      lines: [
        ...equityRows.map((row) => ({ code: row.code, label: row.name, amountPesewas: row.amountPesewas })),
        { code: 'CURRENT_EARNINGS', label: 'Current earnings', amountPesewas: currentEarnings },
      ],
    },
    workingCapitalPesewas: currentAssets - currentLiabilities,
    currentRatioBps: currentLiabilities > 0
      ? Math.round((currentAssets * 10_000) / currentLiabilities)
      : null,
    equationDifferencePesewas: difference,
    integrityOk: difference === 0,
  };
}

export interface ManagementCashflowResult {
  generatedAt: string;
  fromDate: string;
  toDate: string;
  locationId: string;
  dataQuality: DataQualityResult;
  openingCashPesewas: number;
  operatingPesewas: number;
  investingPesewas: number;
  financingPesewas: number;
  netExternalCashflowPesewas: number;
  endingCashPesewas: number;
  expectedEndingCashPesewas: number;
  reconciliationDifferencePesewas: number;
  integrityOk: boolean;
  operatingLines: ManagementLine[];
  investingLines: ManagementLine[];
  financingLines: ManagementLine[];
  transferLines: ManagementLine[];
  accounts: FinancialAccountRow[];
}

function financialAccountBalanceAt(
  db: DB,
  financialAccountId: string,
  boundaryISO: string,
  cutoverDate: string | null,
  includeBoundary = false,
): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(jl.debit_pesewas - jl.credit_pesewas), 0) AS total
       FROM financial_accounts fa
       JOIN journal_lines jl ON jl.ledger_account_id = fa.ledger_account_id
       JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE fa.id = ? AND je.status = 'POSTED'
        AND (? IS NULL OR je.business_date >= ?)
        AND je.occurred_at ${includeBoundary ? '<=' : '<'} ?`,
  ).get(financialAccountId, cutoverDate, cutoverDate, boundaryISO) as { total: number }).total;
}

export function getManagementCashflow(
  db: DB,
  input: ManagementAccessInput & { fromDate: string; toDate: string },
): ManagementCashflowResult {
  const locationId = requireManagementAccess(db, input, 'MANAGEMENT_CASHFLOW', {
    fromDate: input.fromDate, toDate: input.toDate,
  });
  const { fromISO, toExclusiveISO } = dateRange(input.fromDate, input.toDate);
  const cutover = db.prepare(
    `SELECT cutover_date AS cutoverDate FROM financial_cutovers
      WHERE location_id = ? AND status = 'ACTIVE'`,
  ).get(locationId) as { cutoverDate: string } | undefined;
  const accounts = listFinancialAccounts(db, locationId);
  const openingCash = accounts.reduce(
    (sum, account) => sum + financialAccountBalanceAt(db, account.id, fromISO, cutover?.cutoverDate ?? null, true),
    0,
  );
  const endingCash = accounts.reduce(
    (sum, account) => sum + financialAccountBalanceAt(db, account.id, toExclusiveISO, cutover?.cutoverDate ?? null),
    0,
  );
  const rows = db.prepare(
    `SELECT je.id, je.source_type AS sourceType, je.posting_type AS postingType,
            je.description,
            COALESCE(SUM(jl.debit_pesewas - jl.credit_pesewas), 0) AS cashDeltaPesewas
       FROM journal_entries je
       JOIN journal_lines jl ON jl.journal_entry_id = je.id
       JOIN financial_accounts fa ON fa.ledger_account_id = jl.ledger_account_id
      WHERE je.location_id = ? AND je.status = 'POSTED'
        AND (? IS NULL OR je.business_date >= ?)
        AND je.occurred_at >= ? AND je.occurred_at < ?
        AND je.posting_type != 'OPENING_BALANCES'
      GROUP BY je.id
     HAVING cashDeltaPesewas != 0
      ORDER BY je.occurred_at, je.id`,
  ).all(locationId, cutover?.cutoverDate ?? null, cutover?.cutoverDate ?? null, fromISO, toExclusiveISO) as Array<{
    id: string; sourceType: string; postingType: string;
    description: string; cashDeltaPesewas: number;
  }>;
  const operating: ManagementLine[] = [];
  const investing: ManagementLine[] = [];
  const financing: ManagementLine[] = [];
  const transfers = db.prepare(
    `SELECT atx.id AS code,
            f.name || ' → ' || t.name AS label,
            atx.amount_pesewas AS amountPesewas
       FROM account_transfers atx
       JOIN financial_accounts f ON f.id = atx.from_financial_account_id
       JOIN financial_accounts t ON t.id = atx.to_financial_account_id
      WHERE atx.location_id = ?
        AND atx.occurred_at >= ? AND atx.occurred_at < ?
      ORDER BY atx.occurred_at, atx.id`,
  ).all(locationId, fromISO, toExclusiveISO) as ManagementLine[];
  for (const row of rows) {
    const line = {
      code: row.postingType,
      label: row.description,
      amountPesewas: row.cashDeltaPesewas,
    };
    if (row.postingType.includes('ASSET_')) investing.push(line);
    else if (row.postingType.includes('LOAN') || row.sourceType === 'OWNER_CONTRIBUTION'
      || row.sourceType === 'OWNER_DRAWING') financing.push(line);
    else operating.push(line);
  }
  const operatingTotal = operating.reduce((sum, line) => sum + line.amountPesewas, 0);
  const investingTotal = investing.reduce((sum, line) => sum + line.amountPesewas, 0);
  const financingTotal = financing.reduce((sum, line) => sum + line.amountPesewas, 0);
  const net = operatingTotal + investingTotal + financingTotal;
  const expectedEnding = openingCash + net;
  return {
    generatedAt: new Date().toISOString(),
    fromDate: input.fromDate,
    toDate: input.toDate,
    locationId,
    dataQuality: getFinancialDataQuality(db, {
      locationId, fromDate: input.fromDate, toDate: input.toDate, reportKind: 'CASH',
    }),
    openingCashPesewas: openingCash,
    operatingPesewas: operatingTotal,
    investingPesewas: investingTotal,
    financingPesewas: financingTotal,
    netExternalCashflowPesewas: net,
    endingCashPesewas: endingCash,
    expectedEndingCashPesewas: expectedEnding,
    reconciliationDifferencePesewas: endingCash - expectedEnding,
    integrityOk: endingCash === expectedEnding,
    operatingLines: operating,
    investingLines: investing,
    financingLines: financing,
    transferLines: transfers,
    accounts,
  };
}

export type MaturityBucket = 'OVERDUE' | 'DUE_0_7' | 'DUE_8_30' | 'DUE_31_60' | 'DUE_61_90' | 'DUE_90_PLUS' | 'NO_DUE_DATE';

export interface ObligationReportRow {
  id: string;
  obligationType: string;
  creditorName: string;
  sourceType: string;
  sourceId: string;
  issueDate: string;
  dueDate: string | null;
  principalPesewas: number;
  interestPesewas: number;
  paidPesewas: number;
  outstandingPesewas: number;
  status: string;
  disputed: boolean;
  bucket: MaturityBucket;
  daysUntilDue: number | null;
}

export interface DebtMaturityResult {
  generatedAt: string;
  asOfDate: string;
  locationId: string;
  dataQuality: DataQualityResult;
  rows: ObligationReportRow[];
  buckets: Array<{ bucket: MaturityBucket; amountPesewas: number; count: number }>;
  totalOutstandingPesewas: number;
  overduePesewas: number;
  dueNext7DaysPesewas: number;
  dueNext30DaysPesewas: number;
  availableReconciledCashPesewas: number;
  cashCoverageBps: number | null;
  projectedCoverageBps: number | null;
}

function maturityBucket(asOfDate: string, dueDate: string | null): {
  bucket: MaturityBucket; daysUntilDue: number | null;
} {
  if (!dueDate) return { bucket: 'NO_DUE_DATE', daysUntilDue: null };
  const days = Math.round(
    (new Date(`${dueDate}T00:00:00.000Z`).getTime()
      - new Date(`${asOfDate}T00:00:00.000Z`).getTime()) / 86_400_000,
  );
  if (days < 0) return { bucket: 'OVERDUE', daysUntilDue: days };
  if (days <= 7) return { bucket: 'DUE_0_7', daysUntilDue: days };
  if (days <= 30) return { bucket: 'DUE_8_30', daysUntilDue: days };
  if (days <= 60) return { bucket: 'DUE_31_60', daysUntilDue: days };
  if (days <= 90) return { bucket: 'DUE_61_90', daysUntilDue: days };
  return { bucket: 'DUE_90_PLUS', daysUntilDue: days };
}

export function getDebtMaturity(
  db: DB,
  input: ManagementAccessInput & { asOfDate: string; projectedCashPesewas?: number },
): DebtMaturityResult {
  assertDate('asOfDate', input.asOfDate);
  const locationId = requireManagementAccess(db, input, 'DEBT_MATURITY', {
    asOfDate: input.asOfDate,
  });
  const unified = db.prepare(
    `SELECT o.id, o.obligation_type AS obligationType, o.creditor_name AS creditorName,
            o.source_type AS sourceType, o.source_id AS sourceId,
            o.issue_date AS issueDate, o.due_date AS dueDate,
            o.principal_pesewas AS principalPesewas,
            o.interest_pesewas AS interestPesewas,
            o.total_paid_pesewas AS paidPesewas, o.status
       FROM obligations o
      WHERE o.location_id = ?
        AND o.status IN ('OPEN','PARTIALLY_PAID','DISPUTED')`,
  ).all(locationId) as Array<Omit<ObligationReportRow, 'outstandingPesewas' | 'disputed' | 'bucket' | 'daysUntilDue'>>;
  const legacySupplier = db.prepare(
    `SELECT 'legacy-' || si.id AS id, 'SUPPLIER_INVOICE' AS obligationType,
            s.name AS creditorName, 'SUPPLIER_INVOICE' AS sourceType,
            si.id AS sourceId, si.invoice_date AS issueDate, si.due_date AS dueDate,
            si.total_pesewas AS principalPesewas, 0 AS interestPesewas,
            si.total_paid_pesewas AS paidPesewas, si.status
       FROM supplier_invoices si
       JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.status IN ('OPEN','PARTIALLY_PAID','DISPUTED')
        AND NOT EXISTS (
          SELECT 1 FROM obligations o
           WHERE o.location_id = ? AND o.source_type = 'SUPPLIER_INVOICE'
             AND o.source_id = si.id
        )`,
  ).all(locationId) as Array<Omit<ObligationReportRow, 'outstandingPesewas' | 'disputed' | 'bucket' | 'daysUntilDue'>>;
  const rows: ObligationReportRow[] = [...unified, ...legacySupplier]
    .map((row) => {
      const due = maturityBucket(input.asOfDate, row.dueDate);
      return {
        ...row,
        outstandingPesewas: Math.max(0, row.principalPesewas + row.interestPesewas - row.paidPesewas),
        disputed: row.status === 'DISPUTED',
        ...due,
      };
    })
    .filter((row) => row.outstandingPesewas > 0)
    .sort((a, b) => (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31'));
  const bucketOrder: MaturityBucket[] = [
    'OVERDUE', 'DUE_0_7', 'DUE_8_30', 'DUE_31_60', 'DUE_61_90', 'DUE_90_PLUS', 'NO_DUE_DATE',
  ];
  const buckets = bucketOrder.map((bucket) => {
    const matching = rows.filter((row) => row.bucket === bucket);
    return {
      bucket,
      amountPesewas: matching.reduce((sum, row) => sum + row.outstandingPesewas, 0),
      count: matching.length,
    };
  });
  const total = rows.reduce((sum, row) => sum + row.outstandingPesewas, 0);
  const overdue = rows.filter((row) => row.bucket === 'OVERDUE')
    .reduce((sum, row) => sum + row.outstandingPesewas, 0);
  const due7 = rows.filter((row) => row.daysUntilDue != null && row.daysUntilDue >= 0 && row.daysUntilDue <= 7)
    .reduce((sum, row) => sum + row.outstandingPesewas, 0);
  const due30 = rows.filter((row) => row.daysUntilDue != null && row.daysUntilDue >= 0 && row.daysUntilDue <= 30)
    .reduce((sum, row) => sum + row.outstandingPesewas, 0);
  const nowMs = new Date(`${input.asOfDate}T23:59:59.999Z`).getTime();
  const reconciledCash = listFinancialAccounts(db, locationId)
    .filter((account) => {
      if (!account.lastReconciledAt) return false;
      const age = Math.floor((nowMs - new Date(account.lastReconciledAt).getTime()) / 86_400_000);
      return age <= (account.kind === 'TILL' ? 1 : 7);
    })
    .reduce((sum, account) => sum + Math.max(0, account.balancePesewas), 0);
  return {
    generatedAt: new Date().toISOString(),
    asOfDate: input.asOfDate,
    locationId,
    dataQuality: getFinancialDataQuality(db, {
      locationId, asOfDate: input.asOfDate, reportKind: 'OBLIGATIONS',
    }),
    rows,
    buckets,
    totalOutstandingPesewas: total,
    overduePesewas: overdue,
    dueNext7DaysPesewas: due7,
    dueNext30DaysPesewas: due30,
    availableReconciledCashPesewas: reconciledCash,
    cashCoverageBps: due30 > 0 ? Math.round((reconciledCash * 10_000) / due30) : null,
    projectedCoverageBps: due30 > 0 && input.projectedCashPesewas != null
      ? Math.round((input.projectedCashPesewas * 10_000) / due30)
      : null,
  };
}

type ConcentrationDimension = 'CUSTOMER' | 'PRODUCT' | 'SUPPLIER' | 'CATEGORY' | 'PAYMENT_RAIL';

export interface ConcentrationExposure {
  id: string;
  name: string;
  amountPesewas: number;
  shareBps: number;
}

export interface ConcentrationDimensionResult {
  dimension: ConcentrationDimension;
  metric: string;
  totalPesewas: number;
  topOneBps: number;
  topThreeBps: number;
  topFiveBps: number;
  previousTopOneBps: number;
  changeBps: number;
  hhi: number;
  hhiLabel: 'DIVERSIFIED' | 'MODERATE' | 'CONCENTRATED';
  risk: 'OK' | 'WARNING' | 'DANGER';
  warningBps: number;
  dangerBps: number;
  exposures: ConcentrationExposure[];
}

export interface ConcentrationReportResult {
  generatedAt: string;
  fromDate: string;
  toDate: string;
  locationId: string;
  dataQuality: DataQualityResult;
  identifiedCustomerRevenueBps: number;
  anonymousWalkInRevenuePesewas: number;
  dimensions: ConcentrationDimensionResult[];
}

function concentrationStats(
  dimension: ConcentrationDimension,
  metric: string,
  rows: Array<{ id: string; name: string; amountPesewas: number }>,
  total: number,
  previousRows: Array<{ amountPesewas: number }>,
  previousTotal: number,
  warningBps: number,
  dangerBps: number,
): ConcentrationDimensionResult {
  const exposures = rows
    .filter((row) => row.amountPesewas > 0)
    .sort((a, b) => b.amountPesewas - a.amountPesewas)
    .map((row) => ({
      ...row,
      shareBps: total > 0 ? Math.round((row.amountPesewas * 10_000) / total) : 0,
    }));
  const top = (count: number) => exposures.slice(0, count).reduce((sum, row) => sum + row.shareBps, 0);
  const previousTop = previousRows
    .filter((row) => row.amountPesewas > 0)
    .sort((a, b) => b.amountPesewas - a.amountPesewas)[0]?.amountPesewas ?? 0;
  const previousTopOneBps = previousTotal > 0 ? Math.round((previousTop * 10_000) / previousTotal) : 0;
  const hhi = Math.round(exposures.reduce((sum, row) => {
    const pct = row.shareBps / 100;
    return sum + pct * pct;
  }, 0));
  const topOne = top(1);
  return {
    dimension,
    metric,
    totalPesewas: total,
    topOneBps: topOne,
    topThreeBps: top(3),
    topFiveBps: top(5),
    previousTopOneBps,
    changeBps: topOne - previousTopOneBps,
    hhi,
    hhiLabel: hhi < 1500 ? 'DIVERSIFIED' : hhi <= 2500 ? 'MODERATE' : 'CONCENTRATED',
    risk: topOne >= dangerBps ? 'DANGER' : topOne >= warningBps ? 'WARNING' : 'OK',
    warningBps,
    dangerBps,
    exposures: exposures.slice(0, 20),
  };
}

function concentrationRows(
  db: DB,
  dimension: ConcentrationDimension,
  locationId: string,
  fromISO: string,
  toExclusiveISO: string,
): Array<{ id: string; name: string; amountPesewas: number }> {
  if (dimension === 'CUSTOMER') {
    return db.prepare(
      `SELECT c.id, c.display_name AS name, COALESCE(SUM(s.total_pesewas), 0) AS amountPesewas
         FROM sales s JOIN customers c ON c.id = s.customer_id
        WHERE s.location_id = ? AND s.voided = 0
          AND s.created_at >= ? AND s.created_at < ?
        GROUP BY c.id`,
    ).all(locationId, fromISO, toExclusiveISO) as Array<{ id: string; name: string; amountPesewas: number }>;
  }
  if (dimension === 'PRODUCT') {
    return db.prepare(
      `SELECT p.id, p.name,
              COALESCE(SUM(
                (sl.line_total_pesewas - ROUND(
                  (s.vat_pesewas + s.nhil_pesewas + s.getfund_pesewas)
                  * sl.line_total_pesewas * 1.0 / MAX(1, s.total_pesewas)
                )) - CASE WHEN sl.line_cogs_pesewas > 0
                          THEN sl.line_cogs_pesewas ELSE sl.unit_cost_pesewas * sl.quantity END
              ), 0) AS amountPesewas
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN products p ON p.id = sl.product_id
        WHERE s.location_id = ? AND s.voided = 0
          AND s.created_at >= ? AND s.created_at < ?
        GROUP BY p.id`,
    ).all(locationId, fromISO, toExclusiveISO) as Array<{ id: string; name: string; amountPesewas: number }>;
  }
  if (dimension === 'CATEGORY') {
    return db.prepare(
      `SELECT p.category AS id, p.category AS name,
              COALESCE(SUM(
                (sl.line_total_pesewas - ROUND(
                  (s.vat_pesewas + s.nhil_pesewas + s.getfund_pesewas)
                  * sl.line_total_pesewas * 1.0 / MAX(1, s.total_pesewas)
                )) - CASE WHEN sl.line_cogs_pesewas > 0
                          THEN sl.line_cogs_pesewas ELSE sl.unit_cost_pesewas * sl.quantity END
              ), 0) AS amountPesewas
         FROM sale_lines sl
         JOIN sales s ON s.id = sl.sale_id
         JOIN products p ON p.id = sl.product_id
        WHERE s.location_id = ? AND s.voided = 0
          AND s.created_at >= ? AND s.created_at < ?
        GROUP BY p.category`,
    ).all(locationId, fromISO, toExclusiveISO) as Array<{ id: string; name: string; amountPesewas: number }>;
  }
  if (dimension === 'SUPPLIER') {
    return db.prepare(
      `SELECT s.id, s.name, COALESCE(SUM(si.total_pesewas), 0) AS amountPesewas
         FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.status != 'VOID'
          AND si.invoice_date >= date(?) AND si.invoice_date < date(?)
        GROUP BY s.id`,
    ).all(fromISO, toExclusiveISO) as Array<{ id: string; name: string; amountPesewas: number }>;
  }
  return db.prepare(
    `SELECT sp.payment_method AS id, sp.payment_method AS name,
            COALESCE(SUM(sp.amount_pesewas), 0) AS amountPesewas
       FROM sale_payments sp JOIN sales s ON s.id = sp.sale_id
      WHERE s.location_id = ? AND s.voided = 0
        AND s.created_at >= ? AND s.created_at < ?
        AND sp.payment_method != 'CREDIT'
      GROUP BY sp.payment_method`,
  ).all(locationId, fromISO, toExclusiveISO) as Array<{ id: string; name: string; amountPesewas: number }>;
}

export function getConcentrationReport(
  db: DB,
  input: ManagementAccessInput & { fromDate: string; toDate: string },
): ConcentrationReportResult {
  const locationId = requireManagementAccess(db, input, 'CONCENTRATION', {
    fromDate: input.fromDate, toDate: input.toDate,
  });
  const range = dateRange(input.fromDate, input.toDate);
  const days = daysInclusive(input.fromDate, input.toDate);
  const previousTo = addDaysISO(input.fromDate, -1);
  const previousFrom = addDaysISO(previousTo, -(days - 1));
  const previousRange = dateRange(previousFrom, previousTo);
  const salesTotal = (db.prepare(
    `SELECT COALESCE(SUM(total_pesewas), 0) AS total,
            COALESCE(SUM(CASE WHEN customer_id IS NOT NULL THEN total_pesewas ELSE 0 END), 0) AS identified,
            COALESCE(SUM(CASE WHEN customer_id IS NULL AND channel = 'WALK_IN'
                              THEN total_pesewas ELSE 0 END), 0) AS anonymous
       FROM sales WHERE location_id = ? AND voided = 0
        AND created_at >= ? AND created_at < ?`,
  ).get(locationId, range.fromISO, range.toExclusiveISO) as {
    total: number; identified: number; anonymous: number;
  });
  const previousSalesTotal = (db.prepare(
    `SELECT COALESCE(SUM(total_pesewas), 0) AS total
       FROM sales WHERE location_id = ? AND voided = 0
        AND created_at >= ? AND created_at < ?`,
  ).get(locationId, previousRange.fromISO, previousRange.toExclusiveISO) as { total: number }).total;
  const dimensions: ConcentrationDimension[] = [
    'CUSTOMER', 'PRODUCT', 'SUPPLIER', 'CATEGORY', 'PAYMENT_RAIL',
  ];
  const thresholdRows = db.prepare(
    `SELECT dimension, warning_bps AS warningBps, danger_bps AS dangerBps
       FROM risk_thresholds WHERE location_id = ?`,
  ).all(locationId) as Array<{ dimension: ConcentrationDimension; warningBps: number; dangerBps: number }>;
  const thresholds = new Map(thresholdRows.map((row) => [row.dimension, row]));
  const results = dimensions.map((dimension) => {
    const rows = concentrationRows(db, dimension, locationId, range.fromISO, range.toExclusiveISO);
    const previousRows = concentrationRows(
      db, dimension, locationId, previousRange.fromISO, previousRange.toExclusiveISO,
    );
    const total = dimension === 'CUSTOMER' || dimension === 'PAYMENT_RAIL'
      ? salesTotal.total
      : rows.reduce((sum, row) => sum + Math.max(0, row.amountPesewas), 0);
    const previousTotal = dimension === 'CUSTOMER' || dimension === 'PAYMENT_RAIL'
      ? previousSalesTotal
      : previousRows.reduce((sum, row) => sum + Math.max(0, row.amountPesewas), 0);
    const threshold = thresholds.get(dimension) ?? { warningBps: 5000, dangerBps: 7000 };
    return concentrationStats(
      dimension,
      dimension === 'PRODUCT' || dimension === 'CATEGORY' ? 'GROSS_PROFIT' : dimension === 'SUPPLIER' ? 'PURCHASES' : 'REVENUE',
      rows,
      total,
      previousRows,
      previousTotal,
      threshold.warningBps,
      threshold.dangerBps,
    );
  });
  return {
    generatedAt: new Date().toISOString(),
    fromDate: input.fromDate,
    toDate: input.toDate,
    locationId,
    dataQuality: getFinancialDataQuality(db, {
      locationId, fromDate: input.fromDate, toDate: input.toDate, reportKind: 'CONCENTRATION',
    }),
    identifiedCustomerRevenueBps: salesTotal.total > 0
      ? Math.round((salesTotal.identified * 10_000) / salesTotal.total)
      : 0,
    anonymousWalkInRevenuePesewas: salesTotal.anonymous,
    dimensions: results,
  };
}

export interface ManagementDrilldownRow {
  journalEntryId: string;
  businessDate: string;
  occurredAt: string;
  sourceType: string;
  sourceId: string;
  postingType: string;
  description: string;
  accountCode: string;
  accountName: string;
  debitPesewas: number;
  creditPesewas: number;
  amountPesewas: number;
  counterpartyType: string | null;
  counterpartyId: string | null;
}

export interface ManagementDrilldownResult {
  generatedAt: string;
  locationId: string;
  rows: ManagementDrilldownRow[];
  truncated: boolean;
  legacyUnavailable: boolean;
}

export function getManagementDrilldown(
  db: DB,
  input: ManagementAccessInput & {
    accountCode?: string;
    financialAccountId?: string;
    sourceType?: string;
    sourceId?: string;
    fromDate?: string;
    toDate?: string;
    asOfDate?: string;
  },
): ManagementDrilldownResult {
  const period: Record<string, string> = {};
  if (input.fromDate) period.fromDate = input.fromDate;
  if (input.toDate) period.toDate = input.toDate;
  if (input.asOfDate) period.asOfDate = input.asOfDate;
  const locationId = requireManagementAccess(db, input, 'SOURCE_DRILLDOWN', period);
  if (!input.accountCode && !input.financialAccountId && !(input.sourceType && input.sourceId)) {
    throw new Error('drill-down requires an account or source record');
  }
  if (input.fromDate) assertDate('fromDate', input.fromDate);
  if (input.toDate) assertDate('toDate', input.toDate);
  if (input.asOfDate) assertDate('asOfDate', input.asOfDate);
  if (input.fromDate && input.toDate && input.toDate < input.fromDate) {
    throw new Error('toDate must be on or after fromDate');
  }
  const clauses = ["je.location_id = ?", "je.status = 'POSTED'"];
  const params: Array<string | number> = [locationId];
  if (input.accountCode) {
    clauses.push('la.code = ?');
    params.push(input.accountCode);
  }
  if (input.financialAccountId) {
    clauses.push('fa.id = ?');
    params.push(input.financialAccountId);
  }
  if (input.sourceType && input.sourceId) {
    clauses.push('je.source_type = ?', 'je.source_id = ?');
    params.push(input.sourceType, input.sourceId);
  }
  if (input.fromDate) {
    clauses.push('je.business_date >= ?');
    params.push(input.fromDate);
  }
  if (input.toDate) {
    clauses.push('je.business_date <= ?');
    params.push(input.toDate);
  }
  if (input.asOfDate) {
    clauses.push('je.business_date <= ?');
    params.push(input.asOfDate);
  }
  const rows = db.prepare(
    `SELECT je.id AS journalEntryId, je.business_date AS businessDate,
            je.occurred_at AS occurredAt, je.source_type AS sourceType,
            je.source_id AS sourceId, je.posting_type AS postingType,
            je.description, la.code AS accountCode, la.name AS accountName,
            jl.debit_pesewas AS debitPesewas, jl.credit_pesewas AS creditPesewas,
            CASE WHEN la.normal_balance = 'DEBIT'
                 THEN jl.debit_pesewas - jl.credit_pesewas
                 ELSE jl.credit_pesewas - jl.debit_pesewas END AS amountPesewas,
            jl.counterparty_type AS counterpartyType,
            jl.counterparty_id AS counterpartyId
       FROM journal_entries je
       JOIN journal_lines jl ON jl.journal_entry_id = je.id
       JOIN ledger_accounts la ON la.id = jl.ledger_account_id
       LEFT JOIN financial_accounts fa ON fa.ledger_account_id = la.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY je.business_date DESC, je.occurred_at DESC, je.id DESC
      LIMIT 501`,
  ).all(...params) as ManagementDrilldownRow[];
  const cutover = db.prepare(
    `SELECT cutover_date AS cutoverDate FROM financial_cutovers
      WHERE location_id = ? AND status = 'ACTIVE'`,
  ).get(locationId) as { cutoverDate: string } | undefined;
  const requestedStart = input.fromDate ?? input.asOfDate ?? null;
  return {
    generatedAt: new Date().toISOString(),
    locationId,
    rows: rows.slice(0, 500),
    truncated: rows.length > 500,
    legacyUnavailable: !cutover || !!(requestedStart && requestedStart < cutover.cutoverDate),
  };
}

export interface ScenarioDrivers {
  salesVolumeChangeBps: number;
  sellingPriceChangeBps: number;
  cogsChangeBps: number;
  fixedExpenseChangeBps: number;
  variableExpenseChangeBps: number;
  collectionChangeBps: number;
  badDebtBps: number;
  additionalInventoryLossBps: number;
  removeTopCustomer: boolean;
  removeTopProduct: boolean;
}

export type ScenarioPreset = 'BASELINE' | 'MILD' | 'SEVERE' | 'TOP_DEPENDENCY' | 'CUSTOM';

const PRESET_DRIVERS: Record<Exclude<ScenarioPreset, 'CUSTOM'>, ScenarioDrivers> = {
  BASELINE: {
    salesVolumeChangeBps: 0, sellingPriceChangeBps: 0, cogsChangeBps: 0,
    fixedExpenseChangeBps: 0, variableExpenseChangeBps: 0, collectionChangeBps: 0,
    badDebtBps: 0, additionalInventoryLossBps: 0,
    removeTopCustomer: false, removeTopProduct: false,
  },
  MILD: {
    salesVolumeChangeBps: -1000, sellingPriceChangeBps: 0, cogsChangeBps: 500,
    fixedExpenseChangeBps: 500, variableExpenseChangeBps: 500, collectionChangeBps: -1000,
    badDebtBps: 0, additionalInventoryLossBps: 100,
    removeTopCustomer: false, removeTopProduct: false,
  },
  SEVERE: {
    salesVolumeChangeBps: -2500, sellingPriceChangeBps: 0, cogsChangeBps: 1200,
    fixedExpenseChangeBps: 1000, variableExpenseChangeBps: 1000, collectionChangeBps: -2500,
    badDebtBps: 1000, additionalInventoryLossBps: 300,
    removeTopCustomer: false, removeTopProduct: false,
  },
  TOP_DEPENDENCY: {
    salesVolumeChangeBps: 0, sellingPriceChangeBps: 0, cogsChangeBps: 0,
    fixedExpenseChangeBps: 0, variableExpenseChangeBps: 0, collectionChangeBps: 0,
    badDebtBps: 0, additionalInventoryLossBps: 0,
    removeTopCustomer: true, removeTopProduct: false,
  },
};

function applyBps(value: number, bps: number): number {
  return Math.round((value * (10_000 + bps)) / 10_000);
}

function clampBps(value: number): number {
  return Math.max(0, Math.min(10_000, value));
}

export interface ScenarioResult {
  generatedAt: string;
  locationId: string;
  preset: ScenarioPreset;
  horizonDays: 30 | 90 | 180;
  baselineFromDate: string;
  baselineToDate: string;
  dataQuality: DataQualityResult;
  drivers: ScenarioDrivers;
  baseline: {
    revenuePesewas: number;
    grossProfitPesewas: number;
    operatingProfitPesewas: number;
    endingCashPesewas: number;
  };
  projected: {
    revenuePesewas: number;
    cogsPesewas: number;
    grossProfitPesewas: number;
    operatingExpensesPesewas: number;
    inventoryLossPesewas: number;
    badDebtPesewas: number;
    operatingProfitPesewas: number;
    cashOperatingSurplusPesewas: number;
    endingCashPesewas: number;
    minimumCashPesewas: number;
    cashRunwayDays: number | null;
    breakEvenRevenuePesewas: number | null;
    obligationsDuePesewas: number;
    obligationsCoverageBps: number | null;
    firstNegativeCashDate: string | null;
  };
  difference: {
    revenuePesewas: number;
    operatingProfitPesewas: number;
    endingCashPesewas: number;
  };
  monthly: Array<{
    month: number;
    revenuePesewas: number;
    operatingProfitPesewas: number;
    endingCashPesewas: number;
  }>;
  disclaimer: string;
}

export function runDownsideScenario(
  db: DB,
  input: ManagementAccessInput & {
    preset: ScenarioPreset;
    horizonDays: 30 | 90 | 180;
    drivers?: Partial<ScenarioDrivers>;
    asOfDate?: string;
  },
): ScenarioResult {
  const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
  assertDate('asOfDate', asOfDate);
  if (![30, 90, 180].includes(input.horizonDays)) throw new Error('horizonDays must be 30, 90, or 180');
  const locationId = requireManagementAccess(db, input, 'DOWNSIDE_SCENARIO', {
    asOfDate, preset: input.preset, horizonDays: String(input.horizonDays),
  });
  const baseDrivers = input.preset === 'CUSTOM'
    ? PRESET_DRIVERS.BASELINE
    : PRESET_DRIVERS[input.preset];
  const drivers: ScenarioDrivers = { ...baseDrivers, ...(input.drivers ?? {}) };
  const baselineToDate = asOfDate;
  const baselineFromDate = addDaysISO(asOfDate, -89);
  const base = accrualForRange(db, locationId, baselineFromDate, baselineToDate);
  const scale = input.horizonDays / 90;
  let baselineRevenue = Math.round(base.netSalesPesewas * scale);
  let baselineCogs = Math.round(base.cogsPesewas * scale);
  const baselineExpenses = Math.round(base.operatingExpensesPesewas * scale);
  const baselineLosses = Math.round(base.inventoryLossesPesewas * scale);

  const { fromISO, toExclusiveISO } = dateRange(baselineFromDate, baselineToDate);
  const fixed90 = (db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS total FROM business_expenses
      WHERE location_id = ? AND payment_status != 'VOID' AND fixed_or_variable = 'FIXED'
        AND incurred_date >= date(?) AND incurred_date < date(?)`,
  ).get(locationId, fromISO, toExclusiveISO) as { total: number }).total;
  const fixedExpenses = Math.round(Math.min(base.operatingExpensesPesewas, fixed90) * scale);
  const variableExpenses = Math.max(0, baselineExpenses - fixedExpenses);
  const receivables = (db.prepare(
    `SELECT COALESCE(SUM(outstanding), 0) AS total FROM (
       SELECT MAX(0, ${creditPrincipalExpr('s')} -
         COALESCE((SELECT SUM(amount_pesewas) FROM customer_payment_allocations
                   WHERE sale_id = s.id), 0)) AS outstanding
         FROM sales s WHERE s.location_id = ? AND s.is_credit = 1 AND s.voided = 0
     )`,
  ).get(locationId) as { total: number }).total;
  const inventoryValue = (db.prepare(
    `SELECT COALESCE(SUM(balance_value_pesewas), 0) AS total FROM (
       SELECT product_id, balance_value_pesewas,
              ROW_NUMBER() OVER (PARTITION BY product_id ORDER BY occurred_at DESC, id DESC) AS rn
         FROM inventory_valuation_movements WHERE location_id = ?
     ) WHERE rn = 1`,
  ).get(locationId) as { total: number }).total;
  const currentCash = listFinancialAccounts(db, locationId)
    .reduce((sum, account) => sum + account.balancePesewas, 0);
  const obligationsDue = (db.prepare(
    `SELECT COALESCE(SUM(principal_pesewas + interest_pesewas - total_paid_pesewas), 0) AS total
       FROM obligations
      WHERE location_id = ? AND status IN ('OPEN','PARTIALLY_PAID','DISPUTED')
        AND due_date IS NOT NULL AND due_date >= ? AND due_date <= ?`,
  ).get(locationId, asOfDate, addDaysISO(asOfDate, input.horizonDays)) as { total: number }).total;

  const topCustomer = (db.prepare(
    `SELECT COALESCE(MAX(total), 0) AS total FROM (
       SELECT SUM(total_pesewas) AS total FROM sales
        WHERE location_id = ? AND voided = 0 AND customer_id IS NOT NULL
          AND created_at >= ? AND created_at < ? GROUP BY customer_id
     )`,
  ).get(locationId, fromISO, toExclusiveISO) as { total: number }).total;
  const topProductProfit = (db.prepare(
    `SELECT COALESCE(MAX(profit), 0) AS total FROM (
       SELECT SUM(sl.line_total_pesewas -
         CASE WHEN sl.line_cogs_pesewas > 0 THEN sl.line_cogs_pesewas
              ELSE sl.unit_cost_pesewas * sl.quantity END) AS profit
         FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
        WHERE s.location_id = ? AND s.voided = 0
          AND s.created_at >= ? AND s.created_at < ? GROUP BY sl.product_id
     )`,
  ).get(locationId, fromISO, toExclusiveISO) as { total: number }).total;
  if (drivers.removeTopCustomer) {
    const scaled = Math.round(topCustomer * scale);
    baselineRevenue = Math.max(0, baselineRevenue - scaled);
    baselineCogs = Math.max(0, baselineCogs - Math.round(scaled * (base.cogsPesewas / Math.max(1, base.netSalesPesewas))));
  }
  if (drivers.removeTopProduct) {
    baselineRevenue = Math.max(0, baselineRevenue - Math.round(topProductProfit * scale));
  }

  const revenue = applyBps(applyBps(baselineRevenue, drivers.salesVolumeChangeBps), drivers.sellingPriceChangeBps);
  const cogs = applyBps(
    applyBps(baselineCogs, drivers.salesVolumeChangeBps),
    drivers.cogsChangeBps,
  );
  const fixed = applyBps(fixedExpenses, drivers.fixedExpenseChangeBps);
  const variable = applyBps(
    applyBps(variableExpenses, drivers.salesVolumeChangeBps),
    drivers.variableExpenseChangeBps,
  );
  const operatingExpenses = fixed + variable;
  const badDebt = Math.round((receivables * clampBps(drivers.badDebtBps)) / 10_000);
  const additionalLoss = Math.round((inventoryValue * clampBps(drivers.additionalInventoryLossBps)) / 10_000);
  const inventoryLoss = baselineLosses + additionalLoss;
  const grossProfit = revenue - cogs;
  const operatingProfit = grossProfit + Math.round(base.otherOperatingIncomePesewas * scale)
    - operatingExpenses - inventoryLoss - badDebt;
  const collectionBps = clampBps(10_000 + drivers.collectionChangeBps);
  const collections = Math.round((revenue * collectionBps) / 10_000) - badDebt;
  const futureInventoryCash = Math.max(0, cogs - inventoryValue);
  const cashSurplus = collections - futureInventoryCash - operatingExpenses - obligationsDue;
  const endingCash = currentCash + cashSurplus;
  const monthlyCount = Math.max(1, Math.ceil(input.horizonDays / 30));
  const monthly: ScenarioResult['monthly'] = [];
  let runningCash = currentCash;
  let firstNegativeCashDate: string | null = null;
  let minimumCash = currentCash;
  for (let month = 1; month <= monthlyCount; month++) {
    const fraction = month === monthlyCount && input.horizonDays % 30 !== 0
      ? (input.horizonDays % 30) / 30
      : 1;
    const monthRevenue = Math.round((revenue / monthlyCount) * fraction);
    const monthProfit = Math.round((operatingProfit / monthlyCount) * fraction);
    const monthCash = Math.round((cashSurplus / monthlyCount) * fraction);
    runningCash += monthCash;
    minimumCash = Math.min(minimumCash, runningCash);
    if (runningCash < 0 && !firstNegativeCashDate) {
      firstNegativeCashDate = addDaysISO(asOfDate, Math.min(input.horizonDays, month * 30));
    }
    monthly.push({ month, revenuePesewas: monthRevenue, operatingProfitPesewas: monthProfit, endingCashPesewas: runningCash });
  }
  const contribution = revenue - cogs - variable;
  const contributionBps = revenue > 0 ? Math.round((contribution * 10_000) / revenue) : 0;
  const monthlyBurn = cashSurplus < 0 ? Math.abs(cashSurplus) / (input.horizonDays / 30) : 0;
  const baselineOperatingProfit = Math.round(base.operatingProfitPesewas * scale);
  const baselineCashEnd = currentCash
    + Math.round(base.netSalesPesewas * scale)
    - Math.round(base.cogsPesewas * scale)
    - baselineExpenses
    - obligationsDue;
  return {
    generatedAt: new Date().toISOString(),
    locationId,
    preset: input.preset,
    horizonDays: input.horizonDays,
    baselineFromDate,
    baselineToDate,
    dataQuality: getFinancialDataQuality(db, {
      locationId, asOfDate, reportKind: 'DOWNSIDE',
    }),
    drivers,
    baseline: {
      revenuePesewas: Math.round(base.netSalesPesewas * scale),
      grossProfitPesewas: Math.round(base.grossProfitPesewas * scale),
      operatingProfitPesewas: baselineOperatingProfit,
      endingCashPesewas: baselineCashEnd,
    },
    projected: {
      revenuePesewas: revenue,
      cogsPesewas: cogs,
      grossProfitPesewas: grossProfit,
      operatingExpensesPesewas: operatingExpenses,
      inventoryLossPesewas: inventoryLoss,
      badDebtPesewas: badDebt,
      operatingProfitPesewas: operatingProfit,
      cashOperatingSurplusPesewas: cashSurplus,
      endingCashPesewas: endingCash,
      minimumCashPesewas: minimumCash,
      cashRunwayDays: monthlyBurn > 0 ? Math.max(0, Math.floor((currentCash / monthlyBurn) * 30)) : null,
      breakEvenRevenuePesewas: contributionBps > 0
        ? Math.round((fixed * 10_000) / contributionBps)
        : null,
      obligationsDuePesewas: obligationsDue,
      obligationsCoverageBps: obligationsDue > 0
        ? Math.round((Math.max(0, endingCash) * 10_000) / obligationsDue)
        : null,
      firstNegativeCashDate,
    },
    difference: {
      revenuePesewas: revenue - Math.round(base.netSalesPesewas * scale),
      operatingProfitPesewas: operatingProfit - baselineOperatingProfit,
      endingCashPesewas: endingCash - baselineCashEnd,
    },
    monthly,
    disclaimer: 'Management scenario, not a forecast. Results depend on the selected drivers and recorded Counter data.',
  };
}
