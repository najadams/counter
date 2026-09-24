import { afterEach, beforeEach, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { completeSaleCore } from '../src/main/services/sales';
import { receiveStock } from '../src/main/services/stockReceipts';
import { openShift } from '../src/main/services/shifts';
import { addUnit } from '../src/main/services/productUnits';
import { unitsOnHand } from '../src/main/services/stockMovements';
import { setLedgerShadowMode } from '../src/main/services/ledger';
import { voidSale } from '../src/main/services/voids';
const W='dev-counter-1', OWNER='dev-supervisor-1', L='loc-main-counter', D='deferred-test';
let dir: string, db: Database.Database, second: Database.Database, productId: string, supplierId: string, shiftId: string, crate: string, bottle: string;
beforeEach(() => {
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'counter-deferred-'));
  db=new Database(path.join(dir,'test.db')); db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL');
  runMigrations(db,path.resolve('migrations')); runSeed(db,{includeDevFixtures:true});
  db.prepare("UPDATE workers SET role='OWNER' WHERE id=?").run(OWNER);
  productId=(db.prepare("SELECT id FROM products WHERE sku='STAR-330'").get() as {id:string}).id;
  bottle=(db.prepare("SELECT id FROM product_units WHERE product_id=? AND conversion_factor=1 LIMIT 1").get(productId) as {id:string}).id;
  supplierId=(db.prepare('SELECT id FROM suppliers LIMIT 1').get() as {id:string}).id;
  crate=addUnit(db,{productId,unitName:'CRATE',conversionFactor:24,pricePesewas:18000,isPurchaseUnit:true,isSaleUnit:true,actorWorkerId:OWNER,deviceId:D}).unitId;
  shiftId=openShift(db,{workerId:W,locationId:L,shiftType:'COUNTER',openingCashPesewas:50000,deviceId:D}).shiftId;
  second=new Database(path.join(dir,'test.db')); second.pragma('foreign_keys=ON');
});
afterEach(()=>{second?.close();db?.close();fs.rmSync(dir,{recursive:true,force:true});});
function sale(connection=db, allowUnrecordedStock=false, quantity=1) {
  return completeSaleCore(connection,{shiftId,workerId:W,workerName:'Test',locationId:L,channel:'WALK_IN',
    lines:[{productId,unitId:bottle,quantity,unitPricePesewas:800}],paymentMethod:'CASH',cashGivenPesewas:800*quantity,
    allowUnrecordedStock,deviceId:D,shopName:'Test'});
}
function receive(quantity:number,cost=600) { return receiveStock(db,{supplierId,locationId:L,workerId:W,supervisorApprovalId:OWNER,
  lines:[{productId,quantity,unitCostPesewas:cost}],allowLargeCostSwing:true,deviceId:D}); }
for(const ledger of [false,true]) {
  it(`two tills cannot sell the same last bottle without acknowledgement (ledger=${ledger})`,()=>{
    if(ledger) setLedgerShadowMode(db,{locationId:L,enabled:true,actorWorkerId:OWNER,pin:'9999',deviceId:D});
    receive(1);
    // Both tills have already displayed the same stock; save must read afresh under the write lock.
    expect(unitsOnHand(db,productId,L)).toBe(1); expect(unitsOnHand(second,productId,L)).toBe(1);
    sale(db);
    expect(()=>sale(second)).toThrow(/Restock not recorded yet/);
    expect(unitsOnHand(second,productId,L)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sales').get()).toEqual({n:1});
    sale(second,true); expect(unitsOnHand(db,productId,L)).toBe(-1);
    receive(24); expect(unitsOnHand(db,productId,L)).toBe(23);
  });
  it(`checks mixed rows in aggregate and rolls back without payment writes (ledger=${ledger})`,()=>{
    if(ledger) setLedgerShadowMode(db,{locationId:L,enabled:true,actorWorkerId:OWNER,pin:'9999',deviceId:D});
    receive(24);
    expect(()=>completeSaleCore(db,{shiftId,workerId:W,workerName:'Test',locationId:L,channel:'WALK_IN',
      lines:[{productId,unitId:crate,quantity:1,unitPricePesewas:18000},{productId,unitId:bottle,quantity:1,unitPricePesewas:800}],
      paymentMethod:'CASH',cashGivenPesewas:18800,deviceId:D,shopName:'Test'})).toThrow(/25 needed/);
    expect(unitsOnHand(db,productId,L)).toBe(24);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sale_payments').get()).toEqual({n:0});
  });
}
it('cancelling an acknowledged shortfall restores zero without waiting for restock',()=>{
  setLedgerShadowMode(db,{locationId:L,enabled:true,actorWorkerId:OWNER,pin:'9999',deviceId:D});
  const result=sale(db,true,6);
  expect(unitsOnHand(db,productId,L)).toBe(-6);
  voidSale(db,{saleId:result.saleId,reason:'customer cancelled',supervisorWorkerId:OWNER,supervisorPin:'9999',workerId:W,deviceId:D});
  expect(unitsOnHand(db,productId,L)).toBe(0);
  expect(db.prepare('SELECT balance_quantity AS q,balance_value_pesewas AS v FROM inventory_valuation_movements ORDER BY rowid DESC LIMIT 1').get()).toEqual({q:0,v:0});
});
it('a receipt that exactly covers the missing stock leaves zero quantity and zero value',()=>{
  setLedgerShadowMode(db,{locationId:L,enabled:true,actorWorkerId:OWNER,pin:'9999',deviceId:D});
  sale(db,true,6); receive(6,417);
  expect(db.prepare('SELECT balance_quantity AS q,balance_value_pesewas AS v FROM inventory_valuation_movements ORDER BY rowid DESC LIMIT 1').get()).toEqual({q:0,v:0});
  expect(db.prepare("SELECT COUNT(*) AS n FROM journal_entries WHERE posting_type='LATE_RESTOCK_COST'").get()).toEqual({n:1});
});
it('a receipt-less return can clear a shortfall at a different cost without double-booking its adjustment',async()=>{
  const { recordCustomerReturn }=await import('../src/main/services/customerReturns');
  setLedgerShadowMode(db,{locationId:L,enabled:true,actorWorkerId:OWNER,pin:'9999',deviceId:D});
  db.prepare(`INSERT INTO customers(id,display_name,phone,customer_type,current_balance_pesewas,credit_limit_pesewas,
    blocked,empties_owed_count,created_by,updated_by,device_id) VALUES('returner','Returner','+233240000001','WALK_IN_REGULAR',0,0,0,0,?,?,?)`).run(W,W,D);
  sale(db,true,6);
  db.prepare('UPDATE products SET cost_price_pesewas=700 WHERE id=?').run(productId);
  recordCustomerReturn(db,{customerId:'returner',locationId:L,workerId:W,shiftId,supervisorWorkerId:OWNER,
    supervisorPin:'9999',refundMethod:'CASH',reason:'no receipt; supervisor checked goods',
    lines:[{productId,quantity:6,unitPricePesewas:800}],deviceId:D});
  expect(unitsOnHand(db,productId,L)).toBe(0);
  expect(db.prepare(`SELECT SUM(jl.debit_pesewas-jl.credit_pesewas) AS v FROM journal_lines jl
    JOIN journal_entries je ON je.id=jl.journal_entry_id JOIN ledger_accounts a ON a.id=jl.ledger_account_id
    WHERE a.code='INVENTORY' AND je.status='POSTED'`).get()).toEqual({v:0});
});
