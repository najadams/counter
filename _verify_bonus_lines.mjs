// Wave D verification — computeBonusLines logic. We run the SQL it uses
// against a stub schema, then re-implement the picker in JS with the same
// rules (greedy on largest qty_buy) and confirm the multiplier maths.

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

const W = 'w-1';
db.run(
  `INSERT INTO workers (id, full_name, phone, role, pin_hash, active, hired_at,
                        created_by, updated_by, device_id)
   VALUES (?, 'Naj', '+233244000111', 'OWNER', 'unused', 1, '2024-01-01', ?, ?, ?)`,
  [W, W, W, 'd'],
);
db.run(
  `INSERT INTO products (id, sku, name, category, cost_price_pesewas,
                         walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
                         is_returnable, active, canonical_unit, created_by, updated_by, device_id)
   VALUES ('p-coke', 'SKU-COKE', 'Coke 1.5L', 'SOFT_DRINK', 500,
           1000, 950, 950, 0, 1, 'BOTTLE', ?, ?, 'd')`,
  [W, W],
);
db.run(
  `INSERT INTO product_units (id, product_id, unit_name, conversion_factor, price_pesewas,
                              is_sale_unit, active, created_by, updated_by, device_id)
   VALUES ('u-bottle', 'p-coke', 'BOTTLE', 1, 1000, 1, 1, ?, ?, 'd')`,
  [W, W],
);
db.run(
  `INSERT INTO product_units (id, product_id, unit_name, conversion_factor, price_pesewas,
                              is_sale_unit, active, created_by, updated_by, device_id)
   VALUES ('u-crate', 'p-coke', 'CRATE', 24, 22000, 1, 1, ?, ?, 'd')`,
  [W, W],
);

// Two promos: buy-6-get-1 and buy-12-get-3 (both crate-level)
db.run(
  `INSERT INTO promotions (id, product_id, applies_to_unit_id, channel,
     qty_buy, qty_get_free, valid_from, valid_to, supplier_id, active,
     created_by, updated_by, device_id)
   VALUES ('promo-6', 'p-coke', 'u-crate', NULL, 6, 1, NULL, NULL, NULL, 1, ?, ?, 'd')`,
  [W, W],
);
db.run(
  `INSERT INTO promotions (id, product_id, applies_to_unit_id, channel,
     qty_buy, qty_get_free, valid_from, valid_to, supplier_id, active,
     created_by, updated_by, device_id)
   VALUES ('promo-12', 'p-coke', 'u-crate', NULL, 12, 3, NULL, NULL, NULL, 1, ?, ?, 'd')`,
  [W, W],
);

// Re-implement the picker in JS — same SQL the service uses.
function findActive(productId, unitId, channel, today) {
  return db.all(
    `SELECT id, qty_buy AS qtyBuy, qty_get_free AS qtyGetFree
       FROM promotions
      WHERE active = 1 AND product_id = ?
        AND (channel IS NULL OR channel = ?)
        AND (applies_to_unit_id IS NULL OR applies_to_unit_id = ?)
        AND (valid_from IS NULL OR valid_from <= ?)
        AND (valid_to IS NULL OR valid_to >= ?)
      ORDER BY qty_buy DESC`,
    [productId, channel, unitId, today, today],
  );
}

function compute(productId, unitId, qty, channel) {
  const today = new Date().toISOString().slice(0, 10);
  const promos = findActive(productId, unitId, channel, today);
  for (const p of promos) {
    const m = Math.floor(qty / p.qtyBuy);
    if (m > 0) return { promotionId: p.id, bonusQty: m * p.qtyGetFree };
  }
  return null;
}

// 6 crates -> picks promo-12? No, 12 doesn't fit; picks promo-6 -> 1 free
let r = compute('p-coke', 'u-crate', 6, 'WHOLESALE');
check('6 crates -> 1 free via promo-6',
  r && r.promotionId === 'promo-6' && r.bonusQty === 1, JSON.stringify(r));

// 12 crates -> promo-12 fits -> 3 free (greedy on biggest threshold)
r = compute('p-coke', 'u-crate', 12, 'WHOLESALE');
check('12 crates -> 3 free via promo-12',
  r && r.promotionId === 'promo-12' && r.bonusQty === 3, JSON.stringify(r));

// 18 crates -> promo-12 fits 1x -> 3 free (NOT 6 free via stacking promo-6)
r = compute('p-coke', 'u-crate', 18, 'WHOLESALE');
check('18 crates -> 3 free via promo-12 (greedy, not stacked)',
  r && r.promotionId === 'promo-12' && r.bonusQty === 3, JSON.stringify(r));

// 24 crates -> promo-12 fits 2x -> 6 free
r = compute('p-coke', 'u-crate', 24, 'WHOLESALE');
check('24 crates -> 6 free via promo-12 (multiplier=2)',
  r && r.promotionId === 'promo-12' && r.bonusQty === 6, JSON.stringify(r));

// 5 crates -> nothing fires
r = compute('p-coke', 'u-crate', 5, 'WHOLESALE');
check('5 crates -> no bonus (under both thresholds)', r === null);

// Bottle qty 30 -> nothing (crate-level promos don't match BOTTLE unit)
r = compute('p-coke', 'u-bottle', 30, 'WHOLESALE');
check('bottle-unit purchase ignores crate-only promos', r === null);

// Channel filter: deactivate promo-12 and add a WALK_IN-only promo-6
db.run(`UPDATE promotions SET active = 0 WHERE id = 'promo-12'`);
db.run(
  `INSERT INTO promotions (id, product_id, applies_to_unit_id, channel,
     qty_buy, qty_get_free, valid_from, valid_to, supplier_id, active,
     created_by, updated_by, device_id)
   VALUES ('promo-walkin', 'p-coke', 'u-crate', 'WALK_IN', 4, 1, NULL, NULL, NULL, 1, ?, ?, 'd')`,
  [W, W],
);

r = compute('p-coke', 'u-crate', 4, 'WALK_IN');
check('4 crates WALK_IN -> 1 free via promo-walkin',
  r && r.promotionId === 'promo-walkin' && r.bonusQty === 1, JSON.stringify(r));

r = compute('p-coke', 'u-crate', 4, 'WHOLESALE');
check('4 crates WHOLESALE -> no bonus (channel filtered)', r === null);

// Date window: add an expired promo
db.run(
  `INSERT INTO promotions (id, product_id, applies_to_unit_id, channel,
     qty_buy, qty_get_free, valid_from, valid_to, supplier_id, active,
     created_by, updated_by, device_id)
   VALUES ('promo-old', 'p-coke', 'u-bottle', NULL, 5, 1, '2020-01-01', '2020-12-31', NULL, 1, ?, ?, 'd')`,
  [W, W],
);
r = compute('p-coke', 'u-bottle', 10, 'WHOLESALE');
check('expired promo does not fire (date window)', r === null);

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
