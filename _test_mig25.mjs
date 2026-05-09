import pkg from 'node-sqlite3-wasm';
import fs from 'node:fs';
import path from 'node:path';
const { Database } = pkg;
const db = new Database(':memory:');
const dir = path.resolve('/sessions/sharp-beautiful-thompson/mnt/counter/migrations');
for (const f of fs.readdirSync(dir).sort()) {
  if (!f.endsWith('.sql')) continue;
  try {
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  } catch (e) {
    console.error(`FAIL ${f}: ${e.message}`);
    process.exit(1);
  }
}
console.log('all migrations applied');

// spot-check: insert + uniqueness behaviour
db.run(`INSERT INTO customer_price_overrides
  (id, customer_id, product_id, applies_to_unit_id, channel, price_pesewas,
   created_by, updated_by, device_id)
  VALUES ('o-1', ?, ?, ?, NULL, 750, ?, ?, ?)`,
  ['cust-test', 'p-test', 'pu-test', 'sys', 'sys', 'd1']);
console.log('insert ok');

// channel=NULL is "any" — separate row for WHOLESALE-specific should be fine
db.run(`INSERT INTO customer_price_overrides
  (id, customer_id, product_id, applies_to_unit_id, channel, price_pesewas,
   created_by, updated_by, device_id)
  VALUES ('o-2', 'cust-test', 'p-test', 'pu-test', 'WHOLESALE', 600, 'sys', 'sys', 'd1')`);
console.log('channel-specific insert ok');

// duplicate of (cust, prod, unit, NULL) should fail
try {
  db.run(`INSERT INTO customer_price_overrides
    (id, customer_id, product_id, applies_to_unit_id, channel, price_pesewas,
     created_by, updated_by, device_id)
    VALUES ('o-3', 'cust-test', 'p-test', 'pu-test', NULL, 800, 'sys', 'sys', 'd1')`);
  console.log('FAIL: duplicate should have been rejected');
  process.exit(1);
} catch (e) {
  console.log('duplicate rejected as expected');
}

// negative price rejected
try {
  db.run(`INSERT INTO customer_price_overrides
    (id, customer_id, product_id, applies_to_unit_id, channel, price_pesewas,
     created_by, updated_by, device_id)
    VALUES ('o-4', 'cust-x', 'p-x', 'u-x', NULL, 0, 'sys', 'sys', 'd1')`);
  console.log('FAIL: zero price should have been rejected');
  process.exit(1);
} catch (e) {
  console.log('zero/negative price rejected as expected');
}
console.log('OK');
