// Wave C.1 smoke verification — exercises the SQL queries used by
// buildCustomerStatement() against a minimal in-memory schema. We don't
// need the full migration set; we just need the columns the service
// touches. better-sqlite3 native binary doesn't load in the sandbox so
// we use node-sqlite3-wasm instead.

import pkg from 'node-sqlite3-wasm';
const { Database } = pkg;

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? ` -- ${detail}` : ''}`);
  if (ok) pass++; else fail++;
}

const db = new Database(':memory:');

// Minimal schema: only what buildCustomerStatement reads.
db.exec(`
  CREATE TABLE workers (
    id TEXT PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT NOT NULL,
    role TEXT NOT NULL, active INTEGER NOT NULL,
    deleted_at TEXT, terminated_at TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE customers (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, phone TEXT NOT NULL,
    customer_type TEXT NOT NULL, credit_limit_pesewas INTEGER NOT NULL,
    blocked INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT
  );
  CREATE TABLE sales (
    id TEXT PRIMARY KEY, customer_id TEXT, total_pesewas INTEGER NOT NULL,
    is_credit INTEGER NOT NULL, voided INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE customer_payments (
    id TEXT PRIMARY KEY, customer_id TEXT NOT NULL,
    amount_pesewas INTEGER NOT NULL, payment_method TEXT NOT NULL,
    payment_reference TEXT, received_at TEXT NOT NULL
  );
  CREATE TABLE customer_payment_allocations (
    sale_id TEXT NOT NULL, amount_pesewas INTEGER NOT NULL
  );
  CREATE TABLE device_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO device_config VALUES ('shop_name', 'JK Beverages'),
                                   ('shop_subtitle', 'Tema, Ghana');
`);

const W = 'w-owner';
const C = 'cust-1';
db.run(
  `INSERT INTO workers VALUES (?, 'Naj', '+233244000111', 'OWNER', 1, NULL, NULL, '2024-01-01')`,
  [W],
);
db.run(
  `INSERT INTO customers VALUES (?, 'Mama Akua', '+233244111222', 'WHOLESALE', 50000, 0, NULL)`,
  [C],
);

// Four credit sales at varying ages.
const sales = [
  { id: 's-cur',  age: 5,   total: 1000 },
  { id: 's-3060', age: 45,  total: 2000 },
  { id: 's-6090', age: 75,  total: 3000 },
  { id: 's-90',   age: 120, total: 4000 },
];
for (const s of sales) {
  const iso = new Date(Date.now() - s.age * 86400_000).toISOString();
  db.run(
    `INSERT INTO sales VALUES (?, ?, ?, 1, 0, ?)`,
    [s.id, C, s.total, iso],
  );
}

// listOpenSalesForCustomer query.
const openRows = db.all(
  `SELECT s.id, s.created_at AS createdAt, s.total_pesewas AS totalPesewas,
          COALESCE((SELECT SUM(amount_pesewas) FROM customer_payment_allocations
                      WHERE sale_id = s.id), 0) AS paidPesewas
     FROM sales s
     WHERE s.customer_id = ? AND s.is_credit = 1 AND s.voided = 0
     ORDER BY s.created_at ASC`,
  [C],
);
check('open sales: 4 rows', openRows.length === 4, `got ${openRows.length}`);
check('open sales: oldest first', openRows[0]?.id === 's-90');

// Aging bucket aggregation.
const now = Date.now();
const buckets = { b0_30: 0, b31_60: 0, b61_90: 0, b90: 0 };
for (const r of openRows) {
  const ageDays = Math.max(0, Math.floor((now - new Date(r.createdAt).getTime()) / 86400_000));
  const out = r.totalPesewas - r.paidPesewas;
  if (ageDays <= 30) buckets.b0_30 += out;
  else if (ageDays <= 60) buckets.b31_60 += out;
  else if (ageDays <= 90) buckets.b61_90 += out;
  else buckets.b90 += out;
}
check('aging: 0-30 = 1000', buckets.b0_30 === 1000, `got ${buckets.b0_30}`);
check('aging: 31-60 = 2000', buckets.b31_60 === 2000, `got ${buckets.b31_60}`);
check('aging: 61-90 = 3000', buckets.b61_90 === 3000, `got ${buckets.b61_90}`);
check('aging: 90+ = 4000',  buckets.b90 === 4000,  `got ${buckets.b90}`);
check('aging: total = 10000', (buckets.b0_30 + buckets.b31_60 + buckets.b61_90 + buckets.b90) === 10000);

// Voided sale exclusion.
db.run(`UPDATE sales SET voided = 1 WHERE id = 's-cur'`);
const openAfter = db.all(
  `SELECT id FROM sales WHERE customer_id = ? AND is_credit = 1 AND voided = 0`,
  [C],
);
check('voided sale excluded from open invoices', openAfter.length === 3);

// Recent payments + history-window cutoff.
db.run(
  `INSERT INTO customer_payments VALUES ('p-1', ?, 1500, 'CASH', NULL, ?)`,
  [C, new Date(Date.now() - 5 * 86400_000).toISOString()],
);
db.run(
  `INSERT INTO customer_payments VALUES ('p-old', ?, 999, 'CASH', NULL, ?)`,
  [C, new Date(Date.now() - 8 * 30 * 86400_000).toISOString()],
);
const cutoff = new Date(Date.now() - 6 * 30 * 86400_000).toISOString();
const recent = db.all(
  `SELECT id FROM customer_payments WHERE customer_id = ? AND received_at >= ?
    ORDER BY received_at DESC`,
  [C, cutoff],
);
check('payments: 6-month window keeps only recent',
  recent.length === 1 && recent[0]?.id === 'p-1',
  `got ${JSON.stringify(recent.map((r) => r.id))}`);

// Shop header read.
const cfg = db.all(`SELECT key, value FROM device_config WHERE key IN ('shop_name', 'shop_subtitle')`);
const cfgMap = new Map(cfg.map((r) => [r.key, r.value]));
check('shop_name resolved', cfgMap.get('shop_name') === 'JK Beverages');
check('shop_subtitle resolved', cfgMap.get('shop_subtitle') === 'Tema, Ghana');

// Owner phone read.
const owner = db.all(
  `SELECT phone FROM workers WHERE role IN ('OWNER', 'FOUNDER') AND active = 1
                              AND deleted_at IS NULL AND terminated_at IS NULL
   ORDER BY created_at ASC LIMIT 1`,
);
check('owner phone resolvable', owner[0]?.phone === '+233244000111');

// Partial-payment subtraction (allocation reduces outstanding).
db.run(`INSERT INTO customer_payment_allocations VALUES ('s-3060', 500)`);
const after = db.all(
  `SELECT s.id,
          (s.total_pesewas - COALESCE((SELECT SUM(amount_pesewas) FROM
            customer_payment_allocations WHERE sale_id = s.id), 0)) AS outstanding
     FROM sales s WHERE s.id = 's-3060'`,
);
check('allocation reduces outstanding', after[0]?.outstanding === 1500,
  `got ${after[0]?.outstanding}`);

db.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
