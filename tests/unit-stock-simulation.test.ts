// Real service calls against disposable SQLite databases, with an independent integer model.
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import { completeSaleCore } from '../src/main/services/sales';
import { receiveStock } from '../src/main/services/stockReceipts';
import { addUnit, priceForUnit } from '../src/main/services/productUnits';
import { unitsOnHand } from '../src/main/services/stockMovements';
import { setLedgerShadowMode } from '../src/main/services/ledger';
import { voidSale } from '../src/main/services/voids';

const W = 'dev-counter-1', OWNER = 'dev-supervisor-1', L = 'loc-main-counter', D = 'simulation';
for (const ledger of [false, true]) {
  it(`mixed-unit receipt → sale → restock → void → empty stock (ledger=${ledger})`, () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      runMigrations(db, path.resolve('migrations'));
      runSeed(db, { includeDevFixtures: true });
      db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(OWNER);
      const productId = (db.prepare("SELECT id FROM products WHERE sku = 'STAR-330'").get() as { id: string }).id;
      const supplierId = (db.prepare('SELECT id FROM suppliers LIMIT 1').get() as { id: string }).id;
      const bottle = (db.prepare("SELECT id FROM product_units WHERE product_id = ? AND unit_name = 'UNIT'").get(productId) as { id: string }).id;
      if (ledger) setLedgerShadowMode(db, { locationId: L, enabled: true, actorWorkerId: OWNER, pin: '9999', deviceId: D });
      const units = [{ id: bottle, factor: 1, price: 800, cost: 417 }];
      for (const [unitName, factor, price, cost] of [['PACK', 6, 4500, 2501], ['CRATE', 24, 18000, 10000]] as const) {
        units.push({ id: addUnit(db, { productId, unitName, conversionFactor: factor, pricePesewas: price,
          isSaleUnit: true, isPurchaseUnit: true, actorWorkerId: OWNER, deviceId: D }).unitId, factor, price, cost });
      }
      const shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 0, deviceId: D }).shiftId;
      let expectedStock = 0;
      function check() {
        expect(unitsOnHand(db, productId, L)).toBe(expectedStock);
        expect(db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE typeof(quantity) != 'integer'").get()).toEqual({ n: 0 });
        if (ledger) expect((db.prepare('SELECT balance_quantity AS q FROM inventory_valuation_movements ORDER BY rowid DESC LIMIT 1').get() as { q: number }).q).toBe(expectedStock);
      }
      function receive(qty: number, u: typeof units[number]) {
        receiveStock(db, { supplierId, locationId: L, workerId: W, supervisorApprovalId: OWNER,
          lines: [{ productId, unitId: u.id, quantity: qty, unitCostPesewas: u.cost }], allowLargeCostSwing: true, deviceId: D });
        expectedStock += qty * u.factor;
        check();
      }
      function sell(entries: Array<{ u: typeof units[number]; qty: number }>) {
        const total = entries.reduce((n, e) => n + e.qty * e.u.price, 0);
        const sale = completeSaleCore(db, { shiftId, workerId: W, workerName: 'Test', locationId: L, channel: 'WALK_IN',
          lines: entries.map(e => ({ productId, unitId: e.u.id, quantity: e.qty, unitPricePesewas: e.u.price })),
          paymentMethod: 'CASH', cashGivenPesewas: total + 123, deviceId: D, shopName: 'Simulation' });
        expect(sale.totalPesewas).toBe(total);
        expectedStock -= entries.reduce((n, e) => n + e.qty * e.u.factor, 0);
        check();
        return sale;
      }
      receive(10, units[2]); // 240 bottles; exactly GHS 1,000, not 240 × rounded GHS 4.17.
      const mixed = sell([{ u: units[2], qty: 2 }, { u: units[1], qty: 3 }, { u: units[0], qty: 5 }]);
      expect(mixed.totalPesewas).toBe(53500);
      expect(expectedStock).toBe(169);
      receive(2, units[2]); receive(1, units[1]);
      expect(expectedStock).toBe(223);
      voidSale(db, { saleId: mixed.saleId, reason: 'Simulation reversal', supervisorWorkerId: OWNER,
        supervisorPin: '9999', workerId: W, deviceId: D });
      expectedStock += 71; check(); expect(expectedStock).toBe(294);
      // Vary packing sizes and quantities over repeated restock/sale cycles.
      for (let i = 0; i < 60; i++) {
        const u = units[i % units.length];
        const qty = i % 5 + 1;
        receive(qty, u);
        sell([{ u, qty }]);
      }
      sell([{ u: units[0], qty: expectedStock }]);
      expect(expectedStock).toBe(0);
      if (ledger) {
        expect(db.prepare('SELECT balance_quantity AS q, balance_value_pesewas AS v FROM inventory_valuation_movements ORDER BY rowid DESC LIMIT 1').get()).toEqual({ q: 0, v: 0 });
      }
      // Both modes reject an unacknowledged shortfall and roll back.
      const oversell = () => completeSaleCore(db, { shiftId, workerId: W, workerName: 'Test', locationId: L,
        channel: 'WALK_IN', lines: [{ productId, unitId: bottle, quantity: 1, unitPricePesewas: 800 }],
        paymentMethod: 'CASH', cashGivenPesewas: 800, deviceId: D, shopName: 'Simulation' });
      expect(oversell).toThrow(/Restock not recorded yet/); check();
      // Explicit exception: a late receipt offsets the sale, never deducts it twice.
      db.prepare('UPDATE products SET cost_price_pesewas = 500 WHERE id = ?').run(productId);
      const pending = completeSaleCore(db, { shiftId, workerId: W, workerName: 'Test', locationId: L,
        channel: 'WALK_IN', lines: [{ productId, unitId: bottle, quantity: 6, unitPricePesewas: 800 }],
        allowUnrecordedStock: true, paymentMethod: 'CASH', cashGivenPesewas: 4800, deviceId: D, shopName: 'Simulation' });
      expectedStock = -6; check();
      expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'SALE_UNRECORDED_STOCK' AND entity_id = ?").get(pending.saleId)).toEqual({ n: 1 });
      receive(2, units[0]); // Partial entry: two delivered bottles, four still pending.
      expect(expectedStock).toBe(-4);
      receive(1, units[2]);
      expect(expectedStock).toBe(20);
      if (ledger) {
        const pool = db.prepare('SELECT balance_value_pesewas AS v FROM inventory_valuation_movements ORDER BY rowid DESC LIMIT 1').get() as { v: number };
        expect(pool.v).toBe(8333); // 20/24 of the exact GHS 100 crate.
        const account = db.prepare(`SELECT SUM(jl.debit_pesewas-jl.credit_pesewas) AS v FROM journal_lines jl
          JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN ledger_accounts a ON a.id=jl.ledger_account_id
          WHERE a.code='INVENTORY' AND je.status='POSTED'`).get() as { v: number };
        expect(account.v).toBe(pool.v);
      }
      // Channel scaling is rounded per sellable unit, then multiplied by quantity.
      db.prepare('UPDATE products SET walk_in_price_pesewas = 800, wholesale_price_pesewas = 733 WHERE id = ?').run(productId);
      expect(priceForUnit(db, productId, units[1].id, 'WHOLESALE')).toBe(4123); // 4500 × 733 / 800 = 4123.125
    } finally { db.close(); }
  }, 20000);
}
