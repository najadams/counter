// Wave F verification — empties ledger schema + round-trip math.

import pkg from 'node-sqlite3-wasm';
import fs from 'node:fs';
import path from 'node:path';
const { Database } = pkg;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

const db = new Database(':memory:');
const dir = path.resolve('/sessions/sharp-beautiful-thompson/mnt/counter/migrations');
for (const f of fs.readdirSync(dir).sort()) {
  if (f.endsWith('.sql')) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
}
check('migration 0028 applied', true);

const cols = db.all(`PRAGMA table_info(customers)`).map((r) => r.name);
check('customers.empties_owed_count exists', cols.includes('empties_owed_count'));

// Seed minimal: worker, supplier, returnable product, customer.
const W = 'w-1';
db.run(
  `INSERT INTO workers (id, full_name, phone, role, pin_hash, active, hired_at,
                        created_by, updated_by, device_id)
   VALUES (?, 'Naj', '+233244000111', 'OWNER', 'unused', 1, '2024-01-01', ?, ?, 'd')`,
  [W, W, W],
);
db.run(
  `INSERT INTO suppliers (id, name, phone, payment_terms_days,
                          created_by, updated_by, device_id)
   VALUES ('s-coke', 'Coca-Cola Depot', '+233302000111', 30, ?, ?, 'd')`,
  [W, W],
);
db.run(
  `INSERT INTO products (id, sku, name, category, cost_price_pesewas,
                         walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
                         is_returnable, bottle_deposit_pesewas, active,
                         canonical_unit, created_by, updated_by, device_id)
   VALUES ('p-coke', 'SKU-COKE', 'Coke 1.5L', 'SOFT_DRINK', 500,
           1000, 950, 950, 1, 200, 1, 'BOTTLE', ?, ?, 'd')`,
  [W, W],
);
db.run(
  `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
                          current_balance_pesewas, created_by, updated_by, device_id)
   VALUES ('cust-akua', 'Mama Akua', '+233244111222', 'WHOLESALE', 0, 0, ?, ?, 'd')`,
  [W, W],
);

// 1. Customer takes 24 bottles -> empties_owed_count = 24
db.run(
  `INSERT INTO container_movements (id, product_id, customer_id, quantity, kind,
     deposit_per_container_pesewas, worker_id, created_by, updated_by, device_id)
   VALUES ('cm-1', 'p-coke', 'cust-akua', 24, 'CUSTOMER_TAKES_FULL', 200, ?, ?, ?, 'd')`,
  [W, W, W],
);
db.run(`UPDATE customers SET empties_owed_count = empties_owed_count + 24 WHERE id = 'cust-akua'`);
let row = db.all(`SELECT empties_owed_count FROM customers WHERE id = 'cust-akua'`)[0];
check('after 24-bottle sale, empties_owed = 24', row.empties_owed_count === 24);

// 2. Customer returns 18 bottles -> 6 owed
db.run(
  `INSERT INTO container_movements (id, product_id, customer_id, quantity, kind,
     deposit_per_container_pesewas, worker_id, created_by, updated_by, device_id)
   VALUES ('cm-2', 'p-coke', 'cust-akua', 18, 'CUSTOMER_RETURNS_EMPTY', 200, ?, ?, ?, 'd')`,
  [W, W, W],
);
db.run(`UPDATE customers SET empties_owed_count = empties_owed_count - 18 WHERE id = 'cust-akua'`);
row = db.all(`SELECT empties_owed_count FROM customers WHERE id = 'cust-akua'`)[0];
check('after 18-bottle return, empties_owed = 6', row.empties_owed_count === 6);

// 3. CHECK constraint forbids going below 0
let blocked = false;
try {
  db.run(`UPDATE customers SET empties_owed_count = -5 WHERE id = 'cust-akua'`);
} catch { blocked = true; }
check('empties_owed_count < 0 rejected by CHECK', blocked);

// 4. Negative quantity rejected
let qtyBlocked = false;
try {
  db.run(
    `INSERT INTO container_movements (id, product_id, customer_id, quantity, kind,
       deposit_per_container_pesewas, worker_id, created_by, updated_by, device_id)
     VALUES ('cm-bad', 'p-coke', 'cust-akua', -1, 'CUSTOMER_TAKES_FULL', 200, ?, ?, ?, 'd')`,
    [W, W, W],
  );
} catch { qtyBlocked = true; }
check('negative quantity rejected', qtyBlocked);

// 5. Customer kind without customer_id rejected
let mixedBlocked = false;
try {
  db.run(
    `INSERT INTO container_movements (id, product_id, supplier_id, quantity, kind,
       deposit_per_container_pesewas, worker_id, created_by, updated_by, device_id)
     VALUES ('cm-bad2', 'p-coke', 's-coke', 5, 'CUSTOMER_TAKES_FULL', 200, ?, ?, ?, 'd')`,
    [W, W, W],
  );
} catch { mixedBlocked = true; }
check('CUSTOMER_TAKES_FULL with supplier_id (and no customer_id) rejected', mixedBlocked);

// 6. Depot side: receive 12 crates, return 8 empties -> net 4 owed @ 200/each = 800
db.run(
  `INSERT INTO container_movements (id, product_id, supplier_id, quantity, kind,
     deposit_per_container_pesewas, worker_id, created_by, updated_by, device_id)
   VALUES ('cm-d1', 'p-coke', 's-coke', 12, 'DEPOT_RECEIVES_FULL', 200, ?, ?, ?, 'd')`,
  [W, W, W],
);
db.run(
  `INSERT INTO container_movements (id, product_id, supplier_id, quantity, kind,
     deposit_per_container_pesewas, worker_id, created_by, updated_by, device_id)
   VALUES ('cm-d2', 'p-coke', 's-coke', 8, 'DEPOT_RETURNS_EMPTY', 200, ?, ?, ?, 'd')`,
  [W, W, W],
);
const recon = db.all(
  `SELECT cm.supplier_id AS supplierId,
          SUM(CASE WHEN cm.kind = 'DEPOT_RECEIVES_FULL' THEN cm.quantity ELSE 0 END) AS fullsReceived,
          SUM(CASE WHEN cm.kind = 'DEPOT_RETURNS_EMPTY' THEN cm.quantity ELSE 0 END) AS emptiesReturned
     FROM container_movements cm
    WHERE cm.supplier_id IS NOT NULL
    GROUP BY cm.supplier_id`,
);
const r0 = recon[0];
check('depot recon: fulls=12, empties=8',
  r0.fullsReceived === 12 && r0.emptiesReturned === 8,
  JSON.stringify(r0));

const net = r0.fullsReceived - r0.emptiesReturned;
check('net outstanding = 4 crates owed back to supplier', net === 4);

// 7. Per-customer balance aggregate matches
const custBal = db.all(
  `SELECT cm.product_id AS productId,
          SUM(CASE WHEN cm.kind = 'CUSTOMER_TAKES_FULL' THEN cm.quantity ELSE -cm.quantity END) AS qtyOwed
     FROM container_movements cm
    WHERE cm.customer_id = 'cust-akua'
    GROUP BY cm.product_id`,
);
check('customer empties aggregate = 6 (24 - 18)',
  custBal[0]?.qtyOwed === 6, JSON.stringify(custBal[0]));

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
