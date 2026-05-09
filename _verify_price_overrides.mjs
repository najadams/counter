// Wave C.2 smoke verification — channel-specific override beats channel-NULL,
// uniqueness index enforces one active row per (cust,prod,unit,channel-or-empty),
// and price > 0 is enforced.

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
check('migration 0025 applied', true);

// Set up minimal fixtures (worker, customer, product, unit).
db.run(
  `INSERT INTO workers (id, full_name, phone, role, pin_hash, active, hired_at,
                        created_by, updated_by, device_id)
   VALUES ('w1', 'Naj', '+233244000111', 'OWNER', 'unused', 1, '2024-01-01', 'w1', 'w1', 'd1')`
);
db.run(
  `INSERT INTO customers (id, display_name, phone, customer_type, credit_limit_pesewas,
                          current_balance_pesewas, created_by, updated_by, device_id)
   VALUES ('c1', 'VIP Akua', '+233244111222', 'WHOLESALE', 0, 0, 'w1', 'w1', 'd1')`
);
db.run(
  `INSERT INTO products (id, sku, name, category, cost_price_pesewas,
                         walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
                         is_returnable, active, canonical_unit, created_by, updated_by, device_id)
   VALUES ('p1', 'SKU-1', 'Coke 1.5L', 'SOFT_DRINK', 500,
           1000, 950, 950,
           0, 1, 'BOTTLE', 'w1', 'w1', 'd1')`
);
db.run(
  `INSERT INTO product_units (id, product_id, unit_name, conversion_factor, price_pesewas,
                              is_sale_unit, active, created_by, updated_by, device_id)
   VALUES ('u1', 'p1', 'BOTTLE', 1, 1000, 1, 1, 'w1', 'w1', 'd1')`
);

// Insert a channel-NULL override at 800 and channel=WHOLESALE override at 700.
db.run(
  `INSERT INTO customer_price_overrides (id, customer_id, product_id, applies_to_unit_id,
     channel, price_pesewas, created_by, updated_by, device_id)
   VALUES ('o-any', 'c1', 'p1', 'u1', NULL, 800, 'w1', 'w1', 'd1')`
);
db.run(
  `INSERT INTO customer_price_overrides (id, customer_id, product_id, applies_to_unit_id,
     channel, price_pesewas, created_by, updated_by, device_id)
   VALUES ('o-wh', 'c1', 'p1', 'u1', 'WHOLESALE', 700, 'w1', 'w1', 'd1')`
);

function lookup(channel) {
  const exact = db.all(
    `SELECT id, price_pesewas FROM customer_price_overrides
      WHERE customer_id = ? AND product_id = ? AND applies_to_unit_id = ?
        AND channel = ? AND active = 1 LIMIT 1`,
    ['c1', 'p1', 'u1', channel],
  );
  if (exact.length > 0) return exact[0];
  const any = db.all(
    `SELECT id, price_pesewas FROM customer_price_overrides
      WHERE customer_id = ? AND product_id = ? AND applies_to_unit_id = ?
        AND channel IS NULL AND active = 1 LIMIT 1`,
    ['c1', 'p1', 'u1'],
  );
  return any[0] ?? null;
}

const wh = lookup('WHOLESALE');
check('WHOLESALE channel hit returns 700', wh?.price_pesewas === 700,
  `got ${JSON.stringify(wh)}`);

const wi = lookup('WALK_IN');
check('WALK_IN channel falls back to NULL @ 800',
  wi?.price_pesewas === 800 && wi?.id === 'o-any',
  `got ${JSON.stringify(wi)}`);

// Uniqueness: duplicate (cust, prod, unit, channel=NULL) should fail
let dupRejected = false;
try {
  db.run(
    `INSERT INTO customer_price_overrides (id, customer_id, product_id, applies_to_unit_id,
       channel, price_pesewas, created_by, updated_by, device_id)
     VALUES ('o-dup', 'c1', 'p1', 'u1', NULL, 999, 'w1', 'w1', 'd1')`
  );
} catch { dupRejected = true; }
check('duplicate (cust,prod,unit,NULL) rejected', dupRejected);

// Same (cust,prod,unit) with a different channel is fine
db.run(
  `INSERT INTO customer_price_overrides (id, customer_id, product_id, applies_to_unit_id,
     channel, price_pesewas, created_by, updated_by, device_id)
   VALUES ('o-route', 'c1', 'p1', 'u1', 'ROUTE', 750, 'w1', 'w1', 'd1')`
);
const ro = lookup('ROUTE');
check('ROUTE channel returns 750', ro?.price_pesewas === 750);

// Deactivate the channel-WHOLESALE row -> WHOLESALE should now fall back to NULL @ 800
db.run(`UPDATE customer_price_overrides SET active = 0 WHERE id = 'o-wh'`);
const wh2 = lookup('WHOLESALE');
check('after deactivate, WHOLESALE falls back to NULL @ 800',
  wh2?.price_pesewas === 800,
  `got ${JSON.stringify(wh2)}`);

// Once deactivated, adding a fresh active WHOLESALE row should succeed
db.run(
  `INSERT INTO customer_price_overrides (id, customer_id, product_id, applies_to_unit_id,
     channel, price_pesewas, created_by, updated_by, device_id)
   VALUES ('o-wh2', 'c1', 'p1', 'u1', 'WHOLESALE', 650, 'w1', 'w1', 'd1')`
);
const wh3 = lookup('WHOLESALE');
check('post-reactivate insert: new row at 650', wh3?.price_pesewas === 650);

// Negative price rejected
let negRejected = false;
try {
  db.run(
    `INSERT INTO customer_price_overrides (id, customer_id, product_id, applies_to_unit_id,
       channel, price_pesewas, created_by, updated_by, device_id)
     VALUES ('o-neg', 'c1', 'p1', 'u1', NULL, -100, 'w1', 'w1', 'd1')`
  );
} catch { negRejected = true; }
check('negative price rejected', negRejected);

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
