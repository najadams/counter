// VAT build: supplier costs carry reclaimable input VAT, claimed when goods sell.
//
// Before this, the VAT build ran two cost models at once. The daily summary,
// Reports and the Taxes report took the input VAT out of cost and off the VAT
// owed; the sale journal and income statement booked the full cost as COGS and
// the full output tax as owed. Paying what the Taxes report said left the
// ledger's tax liability open forever. These tests pin one crate -- GHS 100 cost,
// GHS 180 sale -- to the same numbers on every screen and in the ledger.
//
// Run with the flag, like tests/vat-sale.test.ts:
//
//   COUNTER_VAT=1 npx vitest --run tests/vat-input-tax.test.ts

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSale } from '../src/main/services/sales';
import { _setPrinter, _resetPrinter } from '../src/main/printer/printer';
import { addUnit } from '../src/main/services/productUnits';
import { receiveStock } from '../src/main/services/stockReceipts';
import { recordCustomerReturn } from '../src/main/services/customerReturns';
import { recordTaxPayment } from '../src/main/services/taxPayments';
import { setLedgerShadowMode, verifyLedgerShadow } from '../src/main/services/ledger';
import { generateDailySummary } from '../src/main/services/dailySummaries';
import { getIncomeStatement } from '../src/main/services/managementReports';
import { getTaxesReport } from '../src/main/services/reports';
import { extractInclusiveVat, inclusiveBaseSql, inputTaxForCost } from '../src/shared/lib/vat';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const VAT_ON = process.env['COUNTER_VAT'] === '1';
const W = 'dev-counter-1';
const OWNER = 'dev-supervisor-1';
const L = 'loc-main-counter';
const D = 'test-device';
const PIN = '9999';

// One crate: 10 received at GHS 100 each, one sold at GHS 180 VAT-inclusive.
const CRATE_COST = 10_000;
const CRATE_PRICE = 18_000;
const NET_COST = 8_333; // 10000 / 1.20
const INPUT_TAX = 1_667; // 10000 - 8333
const NET_SALES = 15_000; // 18000 / 1.20
const OUTPUT_TAX = 3_000; // 18000 - 15000
const VAT_OWED = OUTPUT_TAX - INPUT_TAX; // 1333

let db: ReturnType<typeof Database>;
let shiftId: string;
let starId: string;
let crateId: string;
let today: string;

type JournalLine = { code: string; debit: number; credit: number };

function journal(sourceType: string, sourceId: string): JournalLine[] {
  return db.prepare(
    `SELECT la.code AS code, jl.debit_pesewas AS debit, jl.credit_pesewas AS credit
       FROM journal_entries je
       JOIN journal_lines jl ON jl.journal_entry_id = je.id
       JOIN ledger_accounts la ON la.id = jl.ledger_account_id
      WHERE je.source_type = ? AND je.source_id = ? AND je.status = 'POSTED'`,
  ).all(sourceType, sourceId) as JournalLine[];
}

function amount(lines: JournalLine[], code: string, side: 'debit' | 'credit'): number {
  return lines.filter((line) => line.code === code).reduce((sum, line) => sum + line[side], 0);
}

/** Tax owed per the ledger: credits less debits on TAX_PAYABLE. */
function ledgerTaxOwed(): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(jl.credit_pesewas - jl.debit_pesewas), 0) AS owed
       FROM journal_entries je
       JOIN journal_lines jl ON jl.journal_entry_id = je.id
       JOIN ledger_accounts la ON la.id = jl.ledger_account_id
      WHERE je.location_id = ? AND je.status = 'POSTED' AND la.code = 'TAX_PAYABLE'`,
  ).get(L) as { owed: number }).owed;
}

function sellCrate(customerId: string | null = null) {
  return completeSale(db, {
    shiftId, workerId: W, workerName: 'Naj', locationId: L, channel: 'WALK_IN',
    lines: [{ productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: CRATE_PRICE }],
    paymentMethod: 'CASH', cashGivenPesewas: CRATE_PRICE, customerId, deviceId: D, shopName: 'T',
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(OWNER);
  starId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
  shiftId = openShift(db, {
    workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D,
  }).shiftId;
  _setPrinter({ async print() { return { ok: true } as const; } });
  today = new Date().toISOString().slice(0, 10);

  setLedgerShadowMode(db, { locationId: L, enabled: true, actorWorkerId: OWNER, pin: PIN, deviceId: D });
  crateId = addUnit(db, {
    productId: starId, unitName: 'CRATE', conversionFactor: 24, pricePesewas: CRATE_PRICE,
    isPurchaseUnit: true, isSaleUnit: true, actorWorkerId: OWNER, deviceId: D,
  }).unitId;
  const supplierId = (db.prepare('SELECT id FROM suppliers LIMIT 1').get() as { id: string }).id;
  receiveStock(db, {
    supplierId, locationId: L, workerId: W, supervisorApprovalId: OWNER,
    lines: [{ productId: starId, unitId: crateId, quantity: 10, unitCostPesewas: CRATE_COST }],
    allowLargeCostSwing: true, deviceId: D,
  });
});

afterEach(() => { _resetPrinter(); db.close(); });

describe.runIf(VAT_ON)('VAT build: reclaimable input VAT on sold goods', () => {
  it('splits the sale journal into COGS and reclaimed input VAT', async () => {
    const sale = await sellCrate();
    const lines = journal('SALE', sale.saleId);

    expect(amount(lines, 'INVENTORY', 'credit')).toBe(CRATE_COST);
    expect(amount(lines, 'COGS', 'debit')).toBe(NET_COST);
    expect(amount(lines, 'TAX_PAYABLE', 'debit')).toBe(INPUT_TAX);
    expect(amount(lines, 'TAX_PAYABLE', 'credit')).toBe(OUTPUT_TAX);
    expect(amount(lines, 'SALES_NET', 'credit')).toBe(NET_SALES);
    const debits = lines.reduce((sum, line) => sum + line.debit, 0);
    const credits = lines.reduce((sum, line) => sum + line.credit, 0);
    expect(debits).toBe(credits);
  });

  it('agrees on every screen: GHS 83.33 cost, GHS 66.67 profit, GHS 13.33 VAT owed', async () => {
    await sellCrate();

    const summary = generateDailySummary(db, { date: today, locationId: L, workerId: OWNER, deviceId: D });
    expect(summary.totalCostOfGoodsSoldPesewas).toBe(NET_COST);
    expect(summary.grossMarginPesewas).toBe(NET_SALES - NET_COST);

    const income = getIncomeStatement(db, {
      actorWorkerId: OWNER, deviceId: D, locationId: L, fromDate: today, toDate: today,
    });
    expect(income.accrual.cogsPesewas).toBe(NET_COST);
    expect(income.accrual.grossProfitPesewas).toBe(NET_SALES - NET_COST);

    const taxes = getTaxesReport(db, { actorWorkerId: OWNER, fromDate: today, toDate: today });
    expect(taxes.inputTaxTotalPesewas).toBe(INPUT_TAX);
    expect(taxes.netVatPayablePesewas).toBe(VAT_OWED);
    expect(ledgerTaxOwed()).toBe(taxes.netVatPayablePesewas);

    // The supplier invoice for the 10 crates landed today too. Its VAT is shown
    // for reference but must not be claimed a second time in the day row.
    const day = taxes.byDay.find((row) => row.date === today)!;
    expect(day.purchaseInclusivePesewas).toBeGreaterThan(0);
    expect(day.inputTaxPesewas).toBe(INPUT_TAX);
    expect(taxes.byDay.reduce((sum, row) => sum + row.netPayablePesewas, 0)).toBe(taxes.netVatPayablePesewas);

    const shadow = verifyLedgerShadow(db, L);
    expect(shadow.issues.map((issue) => issue.code)).not.toContain('SHADOW_COGS_DIFFERENCE');
  });

  it('paying the VAT the Taxes report shows clears the ledger tax liability', async () => {
    await sellCrate();
    const owed = getTaxesReport(db, { actorWorkerId: OWNER, fromDate: today, toDate: today }).netVatPayablePesewas;
    expect(owed).toBe(VAT_OWED);

    recordTaxPayment(db, {
      actorWorkerId: OWNER, locationId: L, shiftId, taxPeriodFrom: today, taxPeriodTo: today,
      amountPesewas: owed, paymentMethod: 'CASH', deviceId: D,
    });

    expect(ledgerTaxOwed()).toBe(0);
    expect(getTaxesReport(db, { actorWorkerId: OWNER, fromDate: today, toDate: today }).taxBalancePesewas).toBe(0);
  });

  it('a customer return gives back the input VAT the sale reclaimed', async () => {
    const customerId = 'cu-vat-return';
    db.prepare(
      `INSERT INTO customers (id, display_name, phone, customer_type,
         current_balance_pesewas, credit_limit_pesewas, blocked,
         empties_owed_count, created_by, updated_by, device_id)
       VALUES (?, 'VAT Return Customer', '+233500001199', 'WALK_IN_REGULAR', 0, 100000, 0, 0, ?, ?, ?)`,
    ).run(customerId, W, W, D);
    const sale = await sellCrate(customerId);

    const ret = recordCustomerReturn(db, {
      customerId, originalSaleId: sale.saleId, locationId: L, workerId: W, shiftId,
      supervisorWorkerId: OWNER, supervisorPin: PIN, refundMethod: 'CASH', reason: 'damaged',
      lines: [{ productId: starId, unitId: crateId, quantity: 1, unitPricePesewas: CRATE_PRICE }],
      deviceId: D,
    });
    const lines = journal('CUSTOMER_RETURN', ret.returnId);

    // The return restocks exactly what the sale took out, so it mirrors the
    // sale journal line for line.
    expect(amount(lines, 'INVENTORY', 'debit')).toBe(CRATE_COST);
    expect(amount(lines, 'COGS', 'credit')).toBe(inputTaxForCost(CRATE_COST).taxablePesewas);
    expect(amount(lines, 'COGS', 'credit')).toBe(NET_COST);
    // TAX_PAYABLE is debited for the refunded output tax and credited back for
    // the input VAT the sale had claimed on these goods.
    expect(amount(lines, 'TAX_PAYABLE', 'credit')).toBe(INPUT_TAX);
    expect(amount(lines, 'TAX_PAYABLE', 'debit')).toBe(OUTPUT_TAX);
    expect(lines.reduce((sum, line) => sum + line.debit, 0))
      .toBe(lines.reduce((sum, line) => sum + line.credit, 0));
    // Sold and fully returned: nothing is owed to GRA for this crate.
    expect(ledgerTaxOwed()).toBe(0);
  });
});

describe('input VAT rounding', () => {
  it('extracts the base identically in SQL and JS, so ledger postings match reports', () => {
    // The sale journal and reports extract per line in SQL; returns and the
    // Taxes report split in JS. One pesewa apart and the tax liability never
    // clears, so check every cost up to GHS 100 exhaustively.
    const bases = db.prepare(
      `WITH RECURSIVE n(v) AS (SELECT 0 UNION ALL SELECT v + 1 FROM n WHERE v < 10000)
       SELECT v, ${inclusiveBaseSql('v')} AS base FROM n`,
    ).all() as Array<{ v: number; base: number }>;
    expect(bases).toHaveLength(10_001);
    for (const { v, base } of bases) expect(base).toBe(extractInclusiveVat(v).taxablePesewas);
  });
});

describe.runIf(!VAT_ON)('no-VAT build: the whole supplier cost is COGS', () => {
  it('posts the full cost to COGS and claims no input VAT', async () => {
    const sale = await sellCrate();
    const lines = journal('SALE', sale.saleId);
    expect(amount(lines, 'COGS', 'debit')).toBe(CRATE_COST);
    expect(amount(lines, 'INVENTORY', 'credit')).toBe(CRATE_COST);
    expect(lines.some((line) => line.code === 'TAX_PAYABLE')).toBe(false);
  });
});
