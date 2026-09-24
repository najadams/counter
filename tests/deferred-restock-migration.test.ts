import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { setLedgerShadowMode } from '../src/main/services/ledger';
import { receiveStock } from '../src/main/services/stockReceipts';
// Two ways a till reaches 0055: straight from 0054, or from v0.4.2, which
// shipped 0056 first. Either way the history must come through untouched.
it.each([
  ['from 0054', (file: string) => file < '0055'],
  ['on a v0.4.2 install (0056 already applied)', (file: string) => file < '0055' || file.startsWith('0056')],
])('upgrades existing valuation history without changing rows or requeuing sync events (%s)', (_label, before) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'counter-before-55-'));
  const db=new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    for(const file of fs.readdirSync('migrations')) if(file.endsWith('.sql') && before(file)) fs.copyFileSync(path.join('migrations',file),path.join(dir,file));
    runMigrations(db,dir);runSeed(db,{includeDevFixtures:true});
    const owner='dev-supervisor-1';
    db.prepare("UPDATE workers SET role='OWNER' WHERE id=?").run(owner);
    setLedgerShadowMode(db,{locationId:'loc-main-counter',enabled:true,actorWorkerId:owner,pin:'9999',deviceId:'test'});
    const productId=(db.prepare('SELECT id FROM products LIMIT 1').get() as {id:string}).id;
    const supplierId=(db.prepare('SELECT id FROM suppliers LIMIT 1').get() as {id:string}).id;
    receiveStock(db,{supplierId,locationId:'loc-main-counter',workerId:'dev-counter-1',supervisorApprovalId:owner,
      lines:[{productId,quantity:3,unitCostPesewas:600}],allowLargeCostSwing:true,deviceId:'test'});
    const rows=db.prepare('SELECT * FROM inventory_valuation_movements ORDER BY rowid').all();
    expect(rows.length).toBeGreaterThan(0);
    const queue=db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get();
    // Anything newer than 0055 still pending applies after it.
    expect(runMigrations(db,path.resolve('migrations')).applied[0]).toBe('0055_deferred_restock_valuation.sql');
    expect(db.prepare('SELECT * FROM inventory_valuation_movements ORDER BY rowid').all()).toEqual(rows);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_outbox').get()).toEqual(queue);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally { db.close();fs.rmSync(dir,{recursive:true,force:true}); }
});
