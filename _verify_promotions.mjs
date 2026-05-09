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
check('migration 0027 applied', true);

const promoCols = db.all(`PRAGMA table_info(promotions)`).map((r) => r.name);
check('promotions has qty_buy', promoCols.includes('qty_buy'));
check('promotions has qty_get_free', promoCols.includes('qty_get_free'));
check('promotions has supplier_id', promoCols.includes('supplier_id'));

const lineCols = db.all(`PRAGMA table_info(sale_lines)`).map((r) => r.name);
check('sale_lines has kind', lineCols.includes('kind'));
check('sale_lines has applied_promotion_id', lineCols.includes('applied_promotion_id'));

// Default kind = REGULAR
const sample = db.all(`SELECT name, dflt_value FROM pragma_table_info('sale_lines') WHERE name = 'kind'`);
check('sale_lines.kind defaults to REGULAR',
  sample.length === 1 && sample[0].dflt_value === "'REGULAR'",
  `got ${JSON.stringify(sample)}`);

// invalid kind rejected
let rejKind = false;
try {
  db.run(`INSERT INTO sale_lines (id, sale_id, product_id, quantity, unit_price_pesewas,
            unit_cost_pesewas, line_total_pesewas, margin_pesewas, kind,
            created_by, updated_by, device_id)
          VALUES ('sl-x', 'sale-x', 'p-x', 1, 0, 0, 0, 0, 'WEIRD', 'w', 'w', 'd')`);
} catch { rejKind = true; }
check('invalid sale_lines.kind rejected', rejKind);

// promotion with qty_buy = 0 rejected
let rejZero = false;
try {
  db.run(`INSERT INTO promotions (id, product_id, qty_buy, qty_get_free,
            created_by, updated_by, device_id)
          VALUES ('promo-x', 'p-x', 0, 1, 'w', 'w', 'd')`);
} catch { rejZero = true; }
check('promotions.qty_buy must be > 0', rejZero);

// invalid channel rejected
let rejChan = false;
try {
  db.run(`INSERT INTO promotions (id, product_id, channel, qty_buy, qty_get_free,
            created_by, updated_by, device_id)
          VALUES ('promo-y', 'p-x', 'BOGUS', 5, 1, 'w', 'w', 'd')`);
} catch { rejChan = true; }
check('promotions.channel CHECK rejects bogus value', rejChan);

db.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
