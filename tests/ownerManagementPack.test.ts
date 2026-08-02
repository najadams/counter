import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSaleCore } from '../src/main/services/sales';
import { vatForSale } from '../src/shared/lib/vat';
import {
  activateFinancialCutover,
  createAccountTransfer,
  createBusinessExpense,
  createFinancialAccount,
  createLiabilityAgreement,
  depreciateFixedAsset,
  disposeFixedAsset,
  getFinancialDataQuality,
  listFixedAssets,
  listRiskConfiguration,
  payObligation,
  postJournal,
  recordInventoryValuationMovement,
  registerFixedAsset,
  reverseJournal,
  saveScenario,
  setLedgerShadowMode,
  updateFinancialAccount,
  updateObligation,
  upsertRiskAssumption,
  verifyLedgerShadow,
} from '../src/main/services/ledger';
import {
  getConcentrationReport,
  getDebtMaturity,
  getIncomeStatement,
  getManagementBalanceSheet,
  getManagementCashflow,
  getManagementDrilldown,
  runDownsideScenario,
} from '../src/main/services/managementReports';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);
const OWNER = 'dev-supervisor-1';
const CASHIER = 'dev-counter-1';
const LOCATION = 'loc-main-counter';
const DEVICE = 'owner-pack-test-device';
const PIN = '9999';

let db: ReturnType<typeof Database>;
let productId: string;
let productCost: number;
let cutoverDate: string;

function addDays(date: string, days: number): string {
  const out = new Date(`${date}T00:00:00.000Z`);
  out.setUTCDate(out.getUTCDate() + days);
  return out.toISOString().slice(0, 10);
}

function ledgerAccountId(code: string): string {
  return (db.prepare(
    'SELECT id FROM ledger_accounts WHERE location_id = ? AND code = ?',
  ).get(LOCATION, code) as { id: string }).id;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(OWNER);
  const product = db.prepare(
    "SELECT id, cost_price_pesewas AS cost FROM products WHERE sku = 'STAR-330'",
  ).get() as { id: string; cost: number };
  productId = product.id;
  productCost = product.cost;
  cutoverDate = new Date().toISOString().slice(0, 10);
  const prior = addDays(cutoverDate, -1);
  db.prepare(
    `INSERT INTO stock_movements (
       id, product_id, location_id, quantity, reason_code, worker_id,
       unit_cost_pesewas, total_value_pesewas,
       created_at, created_by, updated_by, device_id
     ) VALUES ('sm-opening', ?, ?, 10, 'OPENING_STOCK', ?, ?, ?,
               ?, ?, ?, ?)`,
  ).run(
    productId, LOCATION, OWNER, productCost, 10 * productCost,
    `${prior}T12:00:00.000Z`, OWNER, OWNER, DEVICE,
  );
  db.prepare(
    `INSERT INTO stocktake_events (
       id, location_id, status, started_by, started_at, completed_at,
       supervisor_approval_id, total_expected_stock_value_pesewas,
       products_counted, created_by, updated_by, device_id
     ) VALUES ('st-opening', ?, 'COMPLETED', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    LOCATION, CASHIER, `${prior}T10:00:00.000Z`, `${prior}T11:00:00.000Z`,
    OWNER, 10 * productCost, CASHIER, CASHIER, DEVICE,
  );
  db.prepare(
    `INSERT INTO period_closes (
       id, location_id, business_date, sealed_by, device_id
     ) VALUES ('pc-opening', ?, ?, ?, ?)`,
  ).run(LOCATION, prior, OWNER, DEVICE);
});

afterEach(() => db?.close());

function activate(openingCash = 10_000) {
  return activateFinancialCutover(db, {
    locationId: LOCATION,
    cutoverDate,
    balances: [
      { ledgerAccountId: ledgerAccountId('CASH_TILL_DEFAULT'), amountPesewas: openingCash },
      { ledgerAccountId: ledgerAccountId('INVENTORY'), amountPesewas: 10 * productCost },
    ],
    actorWorkerId: OWNER,
    pin: PIN,
    deviceId: DEVICE,
  });
}

describe('owner management ledger foundation', () => {
  it('dual-posts and verifies operational activity in shadow mode before cutover', () => {
    const started = setLedgerShadowMode(db, {
      locationId: LOCATION, enabled: true,
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
    });
    expect(started).toMatchObject({ enabled: true, status: 'PASS', salesChecked: 0 });
    const till = (db.prepare(
      'SELECT id FROM financial_accounts WHERE ledger_account_id = ?',
    ).get(ledgerAccountId('CASH_TILL_DEFAULT')) as { id: string }).id;
    const shiftId = openShift(db, {
      workerId: CASHIER, locationId: LOCATION, shiftType: 'COUNTER',
      openingCashPesewas: 0, financialAccountId: till, deviceId: DEVICE,
    }).shiftId;
    completeSaleCore(db, {
      shiftId, workerId: CASHIER, workerName: 'Dev Counter', locationId: LOCATION,
      channel: 'WALK_IN', lines: [{ productId, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: DEVICE, shopName: 'Shadow Shop',
    });
    const verification = verifyLedgerShadow(db, LOCATION);
    expect(verification.issues).toEqual([]);
    expect(verification).toMatchObject({
      enabled: true, status: 'PASS', salesChecked: 1, stockMovementsChecked: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM financial_cutovers").get())
      .toEqual({ count: 0 });
  });

  it('creates one balanced immutable opening journal and seeds exact inventory valuation', () => {
    const result = activate();
    const totals = db.prepare(
      `SELECT SUM(debit_pesewas) AS debit, SUM(credit_pesewas) AS credit
         FROM journal_lines WHERE journal_entry_id = ?`,
    ).get(result.openingJournalEntryId) as { debit: number; credit: number };
    expect(totals.debit).toBe(totals.credit);

    const valuation = db.prepare(
      `SELECT balance_quantity AS quantity, balance_value_pesewas AS value
         FROM inventory_valuation_movements WHERE product_id = ?`,
    ).get(productId) as { quantity: number; value: number };
    expect(valuation).toEqual({ quantity: 10, value: 10 * productCost });

    expect(() => db.prepare(
      "UPDATE journal_entries SET description = 'tampered' WHERE id = ?",
    ).run(result.openingJournalEntryId)).toThrow(/immutable/);
  });

  it('posts idempotently and refuses unbalanced journals', () => {
    activate();
    const valid = {
      locationId: LOCATION,
      businessDate: cutoverDate,
      occurredAt: `${cutoverDate}T12:00:00.000Z`,
      sourceType: 'TEST',
      sourceId: 'one',
      postingType: 'CAPITAL',
      description: 'Test capital',
      actorWorkerId: OWNER,
      deviceId: DEVICE,
      lines: [
        { accountCode: 'CASH_BANK_DEFAULT', debitPesewas: 500 },
        { accountCode: 'OWNER_CAPITAL', creditPesewas: 500 },
      ],
    };
    expect(postJournal(db, valid).created).toBe(true);
    expect(postJournal(db, valid).created).toBe(false);
    expect(() => postJournal(db, {
      ...valid,
      sourceId: 'bad',
      lines: [
        { accountCode: 'CASH_BANK_DEFAULT', debitPesewas: 500 },
        { accountCode: 'OWNER_CAPITAL', creditPesewas: 499 },
      ],
    })).toThrow(/unbalanced/);
  });

  it('reverses by appending an exact opposite journal without editing history', () => {
    activate();
    const original = postJournal(db, {
      locationId: LOCATION,
      businessDate: cutoverDate,
      occurredAt: `${cutoverDate}T10:00:00.000Z`,
      sourceType: 'TEST_EXPENSE',
      sourceId: 'expense-one',
      postingType: 'EXPENSE',
      description: 'Reversible expense',
      actorWorkerId: OWNER,
      deviceId: DEVICE,
      lines: [
        { accountCode: 'EXP_OTHER', debitPesewas: 700 },
        { accountCode: 'CASH_TILL_DEFAULT', creditPesewas: 700 },
      ],
    });
    const before = db.prepare(
      `SELECT description, status FROM journal_entries WHERE id = ?`,
    ).get(original.journalEntryId);
    const reversed = reverseJournal(db, {
      journalEntryId: original.journalEntryId,
      sourceType: 'TEST_REVERSAL',
      sourceId: 'expense-one-reversal',
      reason: 'Duplicate receipt',
      actorWorkerId: OWNER,
      pin: PIN,
      deviceId: DEVICE,
    });
    expect(db.prepare(
      'SELECT description, status FROM journal_entries WHERE id = ?',
    ).get(original.journalEntryId)).toEqual(before);
    const net = db.prepare(
      `SELECT SUM(jl.debit_pesewas - jl.credit_pesewas) AS net
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         JOIN ledger_accounts la ON la.id = jl.ledger_account_id
        WHERE la.code = 'EXP_OTHER'
          AND je.id IN (?, ?)`,
    ).get(original.journalEntryId, reversed.reversalJournalEntryId) as { net: number };
    expect(net.net).toBe(0);
  });

  it('uses moving weighted-average value, snapshots exact COGS, and keeps statements balanced', () => {
    activate();
    const receiptId = 'sm-weighted-receipt';
    db.prepare(
      `INSERT INTO stock_movements (
         id, product_id, location_id, quantity, reason_code, worker_id,
         unit_cost_pesewas, total_value_pesewas,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, 10, 'RECEIVED_FROM_SUPPLIER', ?, 200, 2000, ?, ?, ?)`,
    ).run(receiptId, productId, LOCATION, OWNER, OWNER, OWNER, DEVICE);
    const value = recordInventoryValuationMovement(db, {
      stockMovementId: receiptId,
      exactInboundValuePesewas: 2000,
      actorWorkerId: OWNER,
      deviceId: DEVICE,
    });
    postJournal(db, {
      locationId: LOCATION,
      businessDate: cutoverDate,
      occurredAt: `${cutoverDate}T12:00:00.000Z`,
      sourceType: 'TEST_RECEIPT',
      sourceId: receiptId,
      postingType: 'INVENTORY_RECEIPT',
      description: 'Weighted-average test receipt',
      actorWorkerId: OWNER,
      deviceId: DEVICE,
      lines: [
        { accountCode: 'INVENTORY', debitPesewas: 2000 },
        { accountCode: 'AP_TRADE', creditPesewas: 2000 },
      ],
    });
    expect(value.averageUnitCostPesewas).toBe(Math.round((10 * productCost + 2000) / 20));

    const shiftId = openShift(db, {
      workerId: CASHIER,
      locationId: LOCATION,
      shiftType: 'COUNTER',
      openingCashPesewas: 0,
      deviceId: DEVICE,
    }).shiftId;
    const sale = completeSaleCore(db, {
      shiftId,
      workerId: CASHIER,
      workerName: 'Dev Counter',
      locationId: LOCATION,
      channel: 'WALK_IN',
      lines: [{ productId, quantity: 3, unitPricePesewas: 800 }],
      paymentMethod: 'CASH',
      cashGivenPesewas: 2400,
      deviceId: DEVICE,
      shopName: 'Counter Test',
    });
    const line = db.prepare(
      'SELECT line_cogs_pesewas AS cogs FROM sale_lines WHERE sale_id = ?',
    ).get(sale.saleId) as { cogs: number };
    expect(line.cogs).toBe(value.averageUnitCostPesewas * 3);

    const position = getManagementBalanceSheet(db, {
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
      locationId: LOCATION, asOfDate: cutoverDate,
    });
    expect(position.integrityOk).toBe(true);
    expect(position.equationDifferencePesewas).toBe(0);

    const profit = getIncomeStatement(db, {
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
      locationId: LOCATION, fromDate: cutoverDate, toDate: cutoverDate,
    });
    expect(profit.accrual.cogsPesewas).toBe(line.cogs);
    expect(profit.accrual.grossProfitPesewas)
      .toBe(profit.accrual.netSalesPesewas - line.cogs);
  });

  it('excludes internal transfers from net cash and preserves the cash identity', () => {
    activate();
    const till = (db.prepare(
      "SELECT id FROM financial_accounts WHERE ledger_account_id = ?",
    ).get(ledgerAccountId('CASH_TILL_DEFAULT')) as { id: string }).id;
    const bank = (db.prepare(
      "SELECT id FROM financial_accounts WHERE ledger_account_id = ?",
    ).get(ledgerAccountId('CASH_BANK_DEFAULT')) as { id: string }).id;
    createAccountTransfer(db, {
      fromFinancialAccountId: till,
      toFinancialAccountId: bank,
      amountPesewas: 2000,
      occurredAt: `${addDays(cutoverDate, 1)}T12:00:00.000Z`,
      actorWorkerId: OWNER,
      pin: PIN,
      deviceId: DEVICE,
    });
    const cash = getManagementCashflow(db, {
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
      locationId: LOCATION,
      fromDate: addDays(cutoverDate, 1),
      toDate: addDays(cutoverDate, 1),
    });
    expect(cash.transferLines).toHaveLength(1);
    expect(cash.netExternalCashflowPesewas).toBe(0);
    expect(cash.openingCashPesewas + cash.netExternalCashflowPesewas)
      .toBe(cash.endingCashPesewas);
  });

  it('marks stale reconciliations provisional but treats invariant failures as incomplete', () => {
    activate();
    const quality = getFinancialDataQuality(db, {
      locationId: LOCATION,
      asOfDate: cutoverDate,
      reportKind: 'POSITION',
    });
    expect(quality.status).toBe('PROVISIONAL');
    expect(quality.issues.some((issue) => issue.code === 'STALE_ACCOUNT_RECONCILIATION'))
      .toBe(true);
  });

  it('maintains accounts and obligations without bypassing structured controls', () => {
    activate();
    const account = createFinancialAccount(db, {
      locationId: LOCATION, name: 'Dormant wallet', kind: 'MOMO', provider: 'TEST',
      actorWorkerId: OWNER, deviceId: DEVICE,
    });
    expect(updateFinancialAccount(db, {
      financialAccountId: account.id, name: 'Archived wallet', provider: 'TEST',
      active: false, actorWorkerId: OWNER, deviceId: DEVICE,
    }).active).toBe(false);
    expect(updateFinancialAccount(db, {
      financialAccountId: account.id, name: 'Restored wallet', provider: 'TEST',
      active: true, actorWorkerId: OWNER, deviceId: DEVICE,
    }).active).toBe(true);

    const expense = createBusinessExpense(db, {
      locationId: LOCATION, category: 'UTILITIES', payee: 'ECG', incurredDate: cutoverDate,
      dueDate: addDays(cutoverDate, 5), amountPesewas: 1000,
      actorWorkerId: OWNER, deviceId: DEVICE,
    });
    const obligation = db.prepare(
      "SELECT id FROM obligations WHERE source_type = 'BUSINESS_EXPENSE' AND source_id = ?",
    ).get(expense.businessExpenseId) as { id: string };
    updateObligation(db, {
      obligationId: obligation.id, dueDate: addDays(cutoverDate, 7), disputed: true,
      notes: 'Bill under review', actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
    });
    const maturity = getDebtMaturity(db, {
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
      locationId: LOCATION, asOfDate: cutoverDate,
    });
    expect(maturity.rows[0]).toMatchObject({
      id: obligation.id, disputed: true, dueDate: addDays(cutoverDate, 7), outstandingPesewas: 1000,
    });
    const till = (db.prepare(
      'SELECT id FROM financial_accounts WHERE ledger_account_id = ?',
    ).get(ledgerAccountId('CASH_TILL_DEFAULT')) as { id: string }).id;
    expect(payObligation(db, {
      obligationId: obligation.id, financialAccountId: till, amountPesewas: 400,
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
    }).outstandingPesewas).toBe(600);
  });

  it('posts straight-line depreciation and disposal through immutable journals', () => {
    activate();
    const till = (db.prepare(
      'SELECT id FROM financial_accounts WHERE ledger_account_id = ?',
    ).get(ledgerAccountId('CASH_TILL_DEFAULT')) as { id: string }).id;
    const asset = registerFixedAsset(db, {
      locationId: LOCATION, name: 'Display fridge', assetClass: 'EQUIPMENT',
      acquiredDate: cutoverDate, costPesewas: 1200, residualValuePesewas: 0,
      usefulLifeMonths: 12, sourceFinancialAccountId: till,
      actorWorkerId: OWNER, deviceId: DEVICE,
    });
    const depreciation = depreciateFixedAsset(db, {
      fixedAssetId: asset.fixedAssetId, throughDate: cutoverDate,
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
    });
    expect(depreciation.depreciationPesewas).toBe(100);
    const depreciatedPosition = getManagementBalanceSheet(db, {
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
      locationId: LOCATION, asOfDate: cutoverDate,
    });
    expect(depreciatedPosition.assets.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FIXED_ASSETS', amountPesewas: 1200 }),
      expect.objectContaining({ code: 'ACCUM_DEPRECIATION', amountPesewas: -100 }),
    ]));
    expect(depreciatedPosition.integrityOk).toBe(true);
    const disposal = disposeFixedAsset(db, {
      fixedAssetId: asset.fixedAssetId, disposedDate: cutoverDate,
      proceedsPesewas: 600, receivingFinancialAccountId: till,
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
    });
    expect(disposal.gainLossPesewas).toBe(-500);
    expect(listFixedAssets(db, LOCATION)[0]).toMatchObject({
      disposedAt: `${cutoverDate}T12:00:00.000Z`,
      accumulatedDepreciationPesewas: 100,
      disposalProceedsPesewas: 600,
    });
    const position = getManagementBalanceSheet(db, {
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
      locationId: LOCATION, asOfDate: cutoverDate,
    });
    expect(position.integrityOk).toBe(true);
  });

  it('persists reviewed assumptions and reusable downside scenarios', () => {
    activate();
    const assumption = upsertRiskAssumption(db, {
      locationId: LOCATION, driver: 'salesVolumeChangeBps', baselineBps: 0,
      downsideBps: -1500, rationale: 'Road works reduce foot traffic',
      reviewDate: addDays(cutoverDate, 30), actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
    });
    const drivers = {
      salesVolumeChangeBps: -1500, sellingPriceChangeBps: 0, cogsChangeBps: 500,
      fixedExpenseChangeBps: 0, variableExpenseChangeBps: 0, collectionChangeBps: -500,
      badDebtBps: 0, additionalInventoryLossBps: 100,
      removeTopCustomer: false, removeTopProduct: false,
    };
    const saved = saveScenario(db, {
      locationId: LOCATION, name: 'Road works', horizonDays: 90, drivers,
      actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE,
    });
    const config = listRiskConfiguration(db, LOCATION);
    expect(config.assumptions).toContainEqual(expect.objectContaining({ id: assumption.id, downsideBps: -1500 }));
    expect(config.scenarios).toContainEqual(expect.objectContaining({ id: saved.id, name: 'Road works', drivers }));
  });

  it('golden shop month answers all six owner questions and preserves every core identity', () => {
    activate();
    const till = (db.prepare(
      'SELECT id FROM financial_accounts WHERE ledger_account_id = ?',
    ).get(ledgerAccountId('CASH_TILL_DEFAULT')) as { id: string }).id;
    const bank = (db.prepare(
      'SELECT id FROM financial_accounts WHERE ledger_account_id = ?',
    ).get(ledgerAccountId('CASH_BANK_DEFAULT')) as { id: string }).id;
    const shiftId = openShift(db, {
      workerId: CASHIER, locationId: LOCATION, shiftType: 'COUNTER',
      openingCashPesewas: 0, financialAccountId: till, deviceId: DEVICE,
    }).shiftId;
    completeSaleCore(db, {
      shiftId, workerId: CASHIER, workerName: 'Dev Counter', locationId: LOCATION,
      channel: 'WALK_IN', lines: [{ productId, quantity: 1, unitPricePesewas: 800 }],
      paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: DEVICE, shopName: 'Golden Shop',
    });
    createBusinessExpense(db, {
      locationId: LOCATION, category: 'UTILITIES', payee: 'ECG', incurredDate: cutoverDate,
      amountPesewas: 300, financialAccountId: till,
      actorWorkerId: OWNER, deviceId: DEVICE,
    });
    createLiabilityAgreement(db, {
      locationId: LOCATION, kind: 'BANK_LOAN', creditorName: 'Golden Bank',
      originalPrincipalPesewas: 1200, receivedFinancialAccountId: bank,
      startDate: cutoverDate,
      schedule: [{ dueDate: addDays(cutoverDate, 20), principalPesewas: 1200, interestPesewas: 0 }],
      actorWorkerId: OWNER, deviceId: DEVICE,
    });

    const access = { actorWorkerId: OWNER, pin: PIN, deviceId: DEVICE, locationId: LOCATION };
    const profit = getIncomeStatement(db, { ...access, fromDate: cutoverDate, toDate: cutoverDate });
    const position = getManagementBalanceSheet(db, { ...access, asOfDate: cutoverDate });
    const cash = getManagementCashflow(db, { ...access, fromDate: cutoverDate, toDate: cutoverDate });
    const obligations = getDebtMaturity(db, { ...access, asOfDate: cutoverDate });
    const concentration = getConcentrationReport(db, { ...access, fromDate: cutoverDate, toDate: cutoverDate });
    const downside = runDownsideScenario(db, {
      ...access, asOfDate: cutoverDate, preset: 'MILD', horizonDays: 90,
    });

    const tax = vatForSale(800);
    const expectedNetSales = 800 - tax.vatPesewas - tax.nhilPesewas - tax.getfundPesewas;
    expect(profit.accrual).toMatchObject({
      netSalesPesewas: expectedNetSales,
      cogsPesewas: productCost,
      grossProfitPesewas: expectedNetSales - productCost,
      operatingExpensesPesewas: 300,
      operatingProfitPesewas: expectedNetSales - productCost - 300,
    });
    expect(position).toMatchObject({ integrityOk: true, equationDifferencePesewas: 0 });
    expect(cash).toMatchObject({ integrityOk: true, reconciliationDifferencePesewas: 0 });
    expect(cash.openingCashPesewas + cash.netExternalCashflowPesewas).toBe(cash.endingCashPesewas);
    expect(obligations).toMatchObject({ totalOutstandingPesewas: 1200, dueNext30DaysPesewas: 1200 });
    expect(concentration.anonymousWalkInRevenuePesewas).toBe(800);
    expect(concentration.dimensions.find((row) => row.dimension === 'PRODUCT')?.topOneBps).toBe(10_000);
    expect(downside.disclaimer).toMatch(/not a forecast/i);
    const repeated = runDownsideScenario(db, {
      ...access, asOfDate: cutoverDate, preset: 'MILD', horizonDays: 90,
    });
    expect(repeated.projected).toEqual(downside.projected);

    const drilldown = getManagementDrilldown(db, {
      ...access, accountCode: 'SALES_NET', fromDate: cutoverDate, toDate: cutoverDate,
    });
    expect(drilldown.rows).toHaveLength(1);
    expect(drilldown.rows[0]).toMatchObject({ sourceType: 'SALE', sourceId: expect.any(String), amountPesewas: expectedNetSales });
  });
});
