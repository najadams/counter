import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { createFirstOwner } from '../src/main/services/setup';
import { receiveStock } from '../src/main/services/stockReceipts';
import { openShift } from '../src/main/services/shifts';
import { completeSaleCore } from '../src/main/services/sales';
import {
  getFinancialDataQuality,
  isLedgerActive,
  listFinancialAccounts,
  previewFinancialCutover,
  startBooksForNewShop,
  tradingHistory,
} from '../src/main/services/ledger';
import {
  getManagementBalanceSheet,
  suggestedOpeningBalances,
} from '../src/main/services/managementReports';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);
const LOCATION = 'loc-main-counter';
const DEVICE = 'start-books-test-device';
const PIN = '4321';
const today = new Date().toISOString().slice(0, 10);

let db: ReturnType<typeof Database>;
let owner: string;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  // The dev fixture brings products; its workers would make setup think an
  // owner already exists, so they step aside until the first owner is made.
  runSeed(db, { includeDevFixtures: true });
  db.prepare(
    `UPDATE workers SET deleted_at = '2026-01-01T00:00:00.000Z', deleted_reason = 'test', deleted_by = 'sys-system'
      WHERE role != 'SYSTEM'`,
  ).run();
  owner = createFirstOwner(db, {
    fullName: 'Ama Owner', phone: '0244123456', pin: PIN, deviceId: DEVICE,
  }).workerId;
  db.prepare(
    `UPDATE workers SET deleted_at = NULL, deleted_reason = NULL, deleted_by = NULL
      WHERE id = 'dev-counter-1'`,
  ).run();
});

afterEach(() => db?.close());

function moneyAccount(kind: string, name?: string) {
  const account = listFinancialAccounts(db, LOCATION)
    .find((row) => row.kind === kind && (name == null || row.name === name));
  if (!account) throw new Error(`no ${kind} account`);
  return account;
}

function ledgerBalance(code: string): number {
  return (db.prepare(
    `SELECT COALESCE(SUM(jl.debit_pesewas - jl.credit_pesewas), 0) AS total
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id AND je.status = 'POSTED'
       JOIN ledger_accounts la ON la.id = jl.ledger_account_id
      WHERE la.location_id = ? AND la.code = ?`,
  ).get(LOCATION, code) as { total: number }).total;
}

function product() {
  return db.prepare(
    "SELECT id, cost_price_pesewas AS cost FROM products WHERE sku = 'STAR-330'",
  ).get() as { id: string; cost: number };
}

describe('starting the books for a new shop', () => {
  it('starts today with the money the shop opens with, and nothing to reconcile', () => {
    expect(tradingHistory(db, LOCATION)).toEqual([]);
    const started = startBooksForNewShop(db, {
      locationId: LOCATION,
      startingMoney: [
        { financialAccountId: moneyAccount('TILL').id, amountPesewas: 20_000 },
        { financialAccountId: moneyAccount('MOMO', 'MTN MoMo').id, amountPesewas: 50_000 },
        { financialAccountId: moneyAccount('SAFE').id, amountPesewas: 0 },
      ],
      actorWorkerId: owner,
      deviceId: DEVICE,
    });

    expect(started).toMatchObject({ cutoverDate: today, openingEquityPesewas: 70_000 });
    expect(isLedgerActive(db, LOCATION)).toBe(true);
    expect(ledgerBalance('CASH_TILL_DEFAULT')).toBe(20_000);
    expect(ledgerBalance('CASH_MOMO_MTN')).toBe(50_000);
    expect(ledgerBalance('OPENING_EQUITY')).toBe(-70_000);
    expect(moneyAccount('TILL').lastReconciledAt).toBe(`${today}T00:00:00.000Z`);

    // Nothing to put right, and nothing to count: the shop has no stock yet.
    const quality = getFinancialDataQuality(db, { locationId: LOCATION });
    expect(quality.issues).toEqual([]);

    const position = getManagementBalanceSheet(db, {
      actorWorkerId: owner, deviceId: DEVICE, locationId: LOCATION, asOfDate: today,
    });
    expect(position).toMatchObject({ legacyEstimate: false, integrityOk: true });
    expect(position.keptAndFree).toMatchObject({ cashOnHandPesewas: 70_000, profitKeptPesewas: 0 });

    const audit = db.prepare(
      "SELECT after_value AS afterValue FROM audit_log WHERE action = 'FINANCIAL_CUTOVER_ACTIVATED'",
    ).get() as { afterValue: string };
    expect(JSON.parse(audit.afterValue)).toMatchObject({ automatic: true, cutoverDate: today });
  });

  it('starts a shop that opens with no money at all, without an opening journal', () => {
    startBooksForNewShop(db, {
      locationId: LOCATION, startingMoney: [], actorWorkerId: owner, deviceId: DEVICE,
    });
    expect(isLedgerActive(db, LOCATION)).toBe(true);
    expect((db.prepare('SELECT opening_journal_entry_id AS id FROM financial_cutovers').get() as { id: string | null }).id)
      .toBeNull();
    expect(() => startBooksForNewShop(db, {
      locationId: LOCATION, startingMoney: [], actorWorkerId: owner, deviceId: DEVICE,
    })).toThrow(/already active/);
  });

  it('refuses a shop that already has records, and bad amounts', () => {
    expect(() => startBooksForNewShop(db, {
      locationId: LOCATION,
      startingMoney: [{ financialAccountId: moneyAccount('TILL').id, amountPesewas: 10.5 }],
      actorWorkerId: owner, deviceId: DEVICE,
    })).toThrow(/whole pesewas/);
    expect(() => startBooksForNewShop(db, {
      locationId: LOCATION, startingMoney: [], actorWorkerId: 'dev-counter-1', deviceId: DEVICE,
    })).toThrow(/OWNER or FOUNDER/);

    receiveStock(db, {
      supplierId: null, isOpeningStock: true, locationId: LOCATION, workerId: owner,
      supervisorApprovalId: owner, lines: [{ productId: product().id, quantity: 12, unitCostPesewas: 500 }],
      allowLargeCostSwing: true, deviceId: DEVICE,
    });
    expect(tradingHistory(db, LOCATION)).toEqual(['stock']);
    expect(() => startBooksForNewShop(db, {
      locationId: LOCATION, startingMoney: [], actorWorkerId: owner, deviceId: DEVICE,
    })).toThrow(/already has stock/);
    expect(isLedgerActive(db, LOCATION)).toBe(false);
  });
});

describe('opening stock once the books are running', () => {
  it('reaches the books as stock the owner brought in, so they still agree after a sale', () => {
    startBooksForNewShop(db, {
      locationId: LOCATION,
      startingMoney: [{ financialAccountId: moneyAccount('TILL').id, amountPesewas: 10_000 }],
      actorWorkerId: owner, deviceId: DEVICE,
    });
    const { id: productId } = product();
    receiveStock(db, {
      supplierId: null, isOpeningStock: true, locationId: LOCATION, workerId: owner,
      supervisorApprovalId: owner, lines: [{ productId, quantity: 24, unitCostPesewas: 600 }],
      allowLargeCostSwing: true, deviceId: DEVICE,
    });
    expect(ledgerBalance('INVENTORY')).toBe(24 * 600);
    expect(ledgerBalance('OPENING_EQUITY')).toBe(-(10_000 + 24 * 600));
    const codes = () => getFinancialDataQuality(db, { locationId: LOCATION }).issues.map((issue) => issue.code);
    expect(codes()).not.toContain('INVENTORY_VALUE_MISMATCH');
    // Now there is stock, it should be counted.
    expect(codes()).toContain('STALE_STOCKTAKE');

    const till = moneyAccount('TILL').id;
    const shiftId = openShift(db, {
      workerId: owner, locationId: LOCATION, shiftType: 'COUNTER',
      openingCashPesewas: 10_000, financialAccountId: till, deviceId: DEVICE,
    }).shiftId;
    completeSaleCore(db, {
      shiftId, workerId: owner, workerName: 'Ama Owner', locationId: LOCATION,
      channel: 'WALK_IN', lines: [{ productId, quantity: 2, unitPricePesewas: 900 }],
      paymentMethod: 'CASH', cashGivenPesewas: 1_800, deviceId: DEVICE, shopName: 'New Shop',
    });
    expect(ledgerBalance('INVENTORY')).toBe(22 * 600);
    expect(codes()).not.toContain('INVENTORY_VALUE_MISMATCH');

    const position = getManagementBalanceSheet(db, {
      actorWorkerId: owner, deviceId: DEVICE, locationId: LOCATION, asOfDate: today,
    });
    expect(position.integrityOk).toBe(true);
    // Stock the owner brought in is their stake, not profit.
    expect(position.keptAndFree!.profitSinceCutoverPesewas)
      .toBe(position.equity.lines.find((line) => line.code === 'CURRENT_EARNINGS')!.amountPesewas);
    expect(position.equity.lines.find((line) => line.code === 'OPENING_EQUITY')!.amountPesewas)
      .toBe(10_000 + 24 * 600);
  });
});

describe('starting the books for a shop that already trades', () => {
  const yesterday = (() => {
    const d = new Date(`${today}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  it("asks an empty shop for nothing, and fills a trading shop's figures from its records", () => {
    const empty = previewFinancialCutover(db, { locationId: LOCATION, cutoverDate: today, balances: [] });
    expect(empty.hasTradingHistory).toBe(false);
    expect(empty.issues.filter((issue) => issue.severity === 'BLOCKING')).toEqual([]);

    const { id: productId, cost } = product();
    db.prepare(
      `INSERT INTO stock_movements (
         id, product_id, location_id, quantity, reason_code, worker_id,
         unit_cost_pesewas, total_value_pesewas, created_at, created_by, updated_by, device_id
       ) VALUES ('sm-old', ?, ?, 30, 'OPENING_STOCK', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(productId, LOCATION, owner, cost, 30 * cost, `${yesterday}T09:00:00.000Z`, owner, owner, DEVICE);

    const trading = previewFinancialCutover(db, { locationId: LOCATION, cutoverDate: today, balances: [] });
    expect(trading.hasTradingHistory).toBe(true);
    expect(trading.derivedInventoryPesewas).toBe(30 * cost);
    const blocking = trading.issues.filter((issue) => issue.severity === 'BLOCKING').map((issue) => issue.code);
    expect(blocking).toEqual(expect.arrayContaining([
      'PRIOR_DAY_NOT_SEALED', 'RECENT_STOCKTAKE_REQUIRED', 'OPENING_INVENTORY_MISMATCH',
    ]));
    const suggestions = suggestedOpeningBalances(db, trading);
    expect(suggestions.find((row) => row.code === 'INVENTORY'))
      .toMatchObject({ amountPesewas: 30 * cost, locked: true });
    expect(suggestions.find((row) => row.code === 'AR')).toMatchObject({ amountPesewas: 0, locked: false });
    expect(suggestions.find((row) => row.code === 'AP_TRADE')).toMatchObject({ amountPesewas: 0, locked: false });
  });

  it('refuses to start on a day that already had sales or deliveries', () => {
    const { id: productId, cost } = product();
    db.prepare(
      `INSERT INTO stock_movements (
         id, product_id, location_id, quantity, reason_code, worker_id,
         unit_cost_pesewas, total_value_pesewas, created_at, created_by, updated_by, device_id
       ) VALUES ('sm-today', ?, ?, 5, 'OPENING_STOCK', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(productId, LOCATION, owner, cost, 5 * cost, `${today}T09:00:00.000Z`, owner, owner, DEVICE);
    const preview = previewFinancialCutover(db, { locationId: LOCATION, cutoverDate: today, balances: [] });
    const issue = preview.issues.find((row) => row.code === 'TRADED_BEFORE_START');
    expect(issue?.severity).toBe('BLOCKING');
    const tomorrow = new Date(`${today}T00:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    expect(issue?.message).toContain(`Start the books on ${tomorrow.toISOString().slice(0, 10)}`);
  });
});
