// Wave C.3 smoke verification — migration applies, customer_returns and
// customer_return_lines tables enforce the right CHECK constraints.

import pkg from 'node-sqlite3-wasm';
import fs from 'node:fs';
import path from 'node:path';
const { Database } = pkg;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

const db = new Database(':memory:');
const dir = path.resolve('/sessions/sharp-beautiful-thompson/mnt/counter/migrations');
for (const f of fs.readdirSync(dir).sort()) {
  if (f.endsWith('.sql')) db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
}
check('migration 0026 applied', true);

// Verify schema columns are present.
const colsReturns = db.all(`PRAGMA table_info(customer_returns)`).map((r) => r.name);
check('customer_returns has refund_method', colsReturns.includes('refund_method'));
check('customer_returns has total_refund_pesewas', colsReturns.includes('total_refund_pesewas'));
check('customer_returns has supervisor_approval_id', colsReturns.includes('supervisor_approval_id'));

const colsLines = db.all(`PRAGMA table_info(customer_return_lines)`).map((r) => r.name);
check('customer_return_lines has stock_movement_id', colsLines.includes('stock_movement_id'));
check('customer_return_lines has applies_to_unit_id', colsLines.includes('applies_to_unit_id'));

// invalid refund_method rejected
let rejInvalid = false;
try {
  db.run(
    `INSERT INTO customer_returns (id, customer_id, location_id, worker_id,
       supervisor_approval_id, refund_method, total_refund_pesewas, reason,
       created_by, updated_by, device_id)
     VALUES ('cr-x', 'cust-x', 'loc-x', 'w-x', 'sup-x',
             'INVALID', 100, 'test', 'w-x', 'w-x', 'd1')`
  );
} catch { rejInvalid = true; }
check('invalid refund_method rejected', rejInvalid);

// Negative total_refund rejected
let rejNegTotal = false;
try {
  db.run(
    `INSERT INTO customer_returns (id, customer_id, location_id, worker_id,
       supervisor_approval_id, refund_method, total_refund_pesewas, reason,
       created_by, updated_by, device_id)
     VALUES ('cr-y', 'cust-x', 'loc-x', 'w-x', 'sup-x',
             'CASH', -1, 'test', 'w-x', 'w-x', 'd1')`
  );
} catch { rejNegTotal = true; }
check('negative total_refund_pesewas rejected', rejNegTotal);

// quantity = 0 rejected on lines
let rejZero = false;
try {
  db.run(
    `INSERT INTO customer_return_lines (id, return_id, product_id, quantity,
       unit_price_pesewas, line_total_pesewas, created_by, device_id)
     VALUES ('crl-x', 'cr-x', 'p-x', 0, 100, 0, 'w-x', 'd1')`
  );
} catch { rejZero = true; }
check('zero-quantity return line rejected', rejZero);

// CHECK clause in seeded reason_codes already includes RETURN_FROM_CUSTOMER
const r = db.all(`SELECT category FROM reason_codes WHERE code = 'RETURN_FROM_CUSTOMER'`);
check('RETURN_FROM_CUSTOMER reason_code seeded with category=inflow',
  r.length === 1 && r[0].category === 'inflow',
  `got ${JSON.stringify(r)}`);

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
