// One-off E2E smoke test for the catalog export/import services.
//
// Path:
//   1. Build a SOURCE in-memory DB, run migrations, seed it
//   2. Export the catalog to a JSON file in /tmp
//   3. Build a TARGET in-memory DB, run migrations, plant a minimal OWNER
//   4. Import the file (dry-run first, then real apply)
//   5. Compare row counts between source and target
//
// Run with: npx tsx scripts/test-catalog-transfer.ts

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/main/db/migrations.js';
import { runSeed } from '../src/main/db/seed.js';
import { exportCatalog } from '../src/main/services/catalogExport.js';
import { applyCatalogImport } from '../src/main/services/catalogImport.js';
import type { CatalogExportPayload } from '../src/shared/types/ipc.js';

const migrationsDir = path.join(process.cwd(), 'migrations');

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  return db;
}

function counts(db: Database.Database): Record<string, number> {
  const tables = [
    'suppliers', 'products', 'product_units',
    'pricing_tiers', 'customers', 'customer_price_overrides',
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
    out[t] = r.n;
  }
  return out;
}

function header(label: string): void {
  console.log('');
  console.log('═══ ' + label + ' ' + '═'.repeat(Math.max(0, 60 - label.length)));
}

function plantOwner(db: Database.Database): string {
  // Create a minimal OWNER worker we can use as the actor for imports. The
  // schema needs a created_by FK; for a fresh target DB we need to insert
  // someone with role OWNER first.
  const id = 'owner-test-actor';
  db.prepare(
    `INSERT INTO workers (
       id, full_name, phone, role, pin_hash,
       base_salary_pesewas, consumption_allowance_units, active,
       hired_at, created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, 0, 0, 1, '2026-01-01', ?, ?, ?)`,
  ).run(id, 'Test Owner', '+233555000099', 'OWNER', 'no-pin', 'sys-system', 'sys-system', 'test');
  return id;
}

function main(): void {
  header('1. Build SOURCE database + seed');
  const source = buildDb();
  runSeed(source, { includeDevFixtures: true });
  // Add a customer and a pricing tier and an override so we can verify
  // those tables ship across too — the seed doesn't include any of those.
  augmentSource(source);
  const srcCounts = counts(source);
  console.log('Source counts:', srcCounts);

  header('2. Export to JSON file');
  const payload = exportCatalog(source, {
    deviceId: 'test-source',
    shopName: 'Test Shop',
    appVersion: '0.1.0',
  });
  const tmpFile = path.join(os.tmpdir(), `counter-catalog-test-${Date.now()}.json`);
  const json = JSON.stringify(payload, null, 2);
  fs.writeFileSync(tmpFile, json, 'utf8');
  console.log('Wrote', tmpFile, '·', json.length, 'bytes');
  console.log('Payload per-table counts:');
  for (const [k, v] of Object.entries(payload.tables)) {
    console.log('  ' + k + ': ' + (v as unknown[]).length);
  }

  header('3. Build TARGET database (fresh, empty)');
  const target = buildDb();
  const actorId = plantOwner(target);
  const beforeTarget = counts(target);
  console.log('Target counts (before):', beforeTarget);

  header('4. Run dry-run import');
  const dry = applyCatalogImport(target, payload, {
    dryRun: true,
    updateExisting: false,
    actorWorkerId: actorId,
    deviceId: 'test-target',
  });
  for (const r of dry.report) {
    console.log(
      `  ${r.table.padEnd(24)} inFile=${r.inFile} toInsert=${r.toInsert} ` +
      `toUpdate=${r.toUpdate} matched=${r.matched} skipped=${r.skipped}`,
    );
    for (const w of r.warnings) console.log('    ! ' + w);
  }
  const dryTargetCounts = counts(target);
  const dryUnchanged = JSON.stringify(beforeTarget) === JSON.stringify(dryTargetCounts);
  console.log('Target unchanged after dry-run?', dryUnchanged ? 'YES ✓' : 'NO ✗');

  header('5. Apply for real');
  const reread = JSON.parse(fs.readFileSync(tmpFile, 'utf8')) as CatalogExportPayload;
  const applied = applyCatalogImport(target, reread, {
    dryRun: false,
    updateExisting: false,
    actorWorkerId: actorId,
    deviceId: 'test-target',
  });
  for (const r of applied.report) {
    console.log(
      `  ${r.table.padEnd(24)} inFile=${r.inFile} inserted=${r.toInsert} ` +
      `updated=${r.toUpdate} matched=${r.matched} skipped=${r.skipped}`,
    );
    for (const w of r.warnings) console.log('    ! ' + w);
  }
  const afterTarget = counts(target);
  console.log('Target counts (after):', afterTarget);

  header('6. Compare source vs target');
  let allMatch = true;
  for (const t of Object.keys(srcCounts)) {
    const a = srcCounts[t]!;
    const b = afterTarget[t]!;
    const ok = a === b;
    if (!ok) allMatch = false;
    console.log(`  ${t.padEnd(28)} source=${a} target=${b} ${ok ? '✓' : '✗ MISMATCH'}`);
  }
  console.log('');

  header('7. Re-apply (idempotency check)');
  const second = applyCatalogImport(target, reread, {
    dryRun: false,
    updateExisting: false,
    actorWorkerId: actorId,
    deviceId: 'test-target',
  });
  let extraInserts = 0;
  for (const r of second.report) {
    extraInserts += r.toInsert;
    console.log(
      `  ${r.table.padEnd(24)} inserted=${r.toInsert} ` +
      `matched=${r.matched} skipped=${r.skipped}`,
    );
  }
  const finalTarget = counts(target);
  const noGrowth = JSON.stringify(afterTarget) === JSON.stringify(finalTarget);
  console.log('Row counts unchanged on second apply?', noGrowth ? 'YES ✓' : 'NO ✗');
  console.log('Inserts attempted on second pass:', extraInserts, extraInserts === 0 ? '✓' : '✗');

  header('8. Spot-check FK resolution');
  // Pick the first product that had a primary supplier in the source and
  // confirm the same product in the target points at a supplier with the
  // same name.
  const probe = source.prepare(
    `SELECT p.sku, s.name AS supplierName
       FROM products p JOIN suppliers s ON s.id = p.primary_supplier_id
       LIMIT 1`,
  ).get() as { sku: string; supplierName: string } | undefined;
  if (probe) {
    const matched = target.prepare(
      `SELECT s.name AS supplierName
         FROM products p JOIN suppliers s ON s.id = p.primary_supplier_id
         WHERE p.sku = ?`,
    ).get(probe.sku) as { supplierName: string } | undefined;
    if (!matched) {
      console.log(`✗ product ${probe.sku} has no supplier on the target`);
      allMatch = false;
    } else if (matched.supplierName !== probe.supplierName) {
      console.log(`✗ product ${probe.sku}: source supplier '${probe.supplierName}' != target '${matched.supplierName}'`);
      allMatch = false;
    } else {
      console.log(`✓ product ${probe.sku}: supplier '${probe.supplierName}' carried across`);
    }
  }
  // Probe a customer price override
  const override = source.prepare(
    `SELECT c.phone, p.sku, pu.unit_name AS unitName, cpo.price_pesewas AS price
       FROM customer_price_overrides cpo
       JOIN customers c ON c.id = cpo.customer_id
       JOIN products p ON p.id = cpo.product_id
       JOIN product_units pu ON pu.id = cpo.applies_to_unit_id
       LIMIT 1`,
  ).get() as { phone: string; sku: string; unitName: string; price: number } | undefined;
  if (override) {
    const tgt = target.prepare(
      `SELECT cpo.price_pesewas AS price
         FROM customer_price_overrides cpo
         JOIN customers c ON c.id = cpo.customer_id
         JOIN products p ON p.id = cpo.product_id
         JOIN product_units pu ON pu.id = cpo.applies_to_unit_id
         WHERE c.phone = ? AND p.sku = ? AND pu.unit_name = ?`,
    ).get(override.phone, override.sku, override.unitName) as { price: number } | undefined;
    if (!tgt) {
      console.log(`✗ override ${override.phone}/${override.sku}/${override.unitName} missing on target`);
      allMatch = false;
    } else if (tgt.price !== override.price) {
      console.log(`✗ override price mismatch: source=${override.price} target=${tgt.price}`);
      allMatch = false;
    } else {
      console.log(`✓ price override ${override.phone}/${override.sku}/${override.unitName} = ${tgt.price}`);
    }
  }

  header('9. Primary unit FK resolved across instances');
  const primary = source.prepare(
    `SELECT p.sku, ppu.unit_name AS purchaseUnit, psu.unit_name AS saleUnit
       FROM products p
       LEFT JOIN product_units ppu ON ppu.id = p.primary_purchase_unit_id
       LEFT JOIN product_units psu ON psu.id = p.primary_sale_unit_id
       WHERE p.primary_purchase_unit_id IS NOT NULL LIMIT 1`,
  ).get() as { sku: string; purchaseUnit: string; saleUnit: string } | undefined;
  if (primary) {
    const tgt = target.prepare(
      `SELECT ppu.unit_name AS purchaseUnit, psu.unit_name AS saleUnit
         FROM products p
         LEFT JOIN product_units ppu ON ppu.id = p.primary_purchase_unit_id
         LEFT JOIN product_units psu ON psu.id = p.primary_sale_unit_id
         WHERE p.sku = ?`,
    ).get(primary.sku) as { purchaseUnit: string | null; saleUnit: string | null } | undefined;
    const ok = tgt
      && tgt.purchaseUnit === primary.purchaseUnit
      && tgt.saleUnit === primary.saleUnit;
    console.log((ok ? '✓ ' : '✗ ') +
      `${primary.sku}: primary purchase=${primary.purchaseUnit} sale=${primary.saleUnit} ` +
      `→ target purchase=${tgt?.purchaseUnit} sale=${tgt?.saleUnit}`);
    if (!ok) allMatch = false;
  } else {
    console.log('(no products with primary unit set in source — skipping)');
  }

  header('10. updateExisting=true overwrites fields');
  // Change a product price on the SOURCE, re-export, apply with
  // updateExisting=true and confirm the change lands.
  source.prepare(`UPDATE products SET walk_in_price_pesewas = 999 WHERE sku = 'STAR-330'`).run();
  const payload2 = exportCatalog(source, {
    deviceId: 'test-source-v2', shopName: 'Test Shop', appVersion: '0.1.0',
  });
  const r2 = applyCatalogImport(target, payload2, {
    dryRun: false, updateExisting: true,
    actorWorkerId: actorId, deviceId: 'test-target',
  });
  const productsReport = r2.report.find((x) => x.table === 'products');
  console.log(`products report: updated=${productsReport?.toUpdate} matched=${productsReport?.matched}`);
  const newPrice = target.prepare(
    `SELECT walk_in_price_pesewas AS price FROM products WHERE sku = 'STAR-330'`,
  ).get() as { price: number };
  console.log((newPrice.price === 999 ? '✓ ' : '✗ ') + `STAR-330 walk-in price after update = ${newPrice.price} (expected 999)`);
  if (newPrice.price !== 999) allMatch = false;

  // Cleanup temp file
  fs.unlinkSync(tmpFile);
  source.close();
  target.close();

  console.log('');
  console.log(allMatch && noGrowth && dryUnchanged && extraInserts === 0
    ? '✓✓✓  ALL CHECKS PASSED'
    : '✗✗✗  AT LEAST ONE CHECK FAILED');
  if (!(allMatch && noGrowth && dryUnchanged && extraInserts === 0)) process.exit(1);
}

// Plant extra data the seed doesn't include so we exercise every table.
function augmentSource(db: Database.Database): void {
  const { v4: uuidv4 } = require('uuid');
  const actor = 'dev-supervisor-1';

  // A customer
  const custId = `cust-${uuidv4()}`;
  db.prepare(
    `INSERT INTO customers (
       id, display_name, phone, customer_type,
       credit_limit_pesewas, credit_terms_days,
       created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(custId, 'Auntie Akua', '+233555123456', 'WHOLESALE',
    500000, 7, actor, actor, 'seed-dev');

  const star = db.prepare(`SELECT id FROM products WHERE sku = 'STAR-330'`).get() as { id: string } | undefined;
  if (!star) return;

  // Two product_units for Star: BOTTLE (canonical, factor 1) and CRATE (24 bottles).
  const bottleId = `pu-${uuidv4()}`;
  const crateId = `pu-${uuidv4()}`;
  db.prepare(
    `INSERT INTO product_units (
       id, product_id, unit_name, conversion_factor, price_pesewas,
       is_purchase_unit, is_sale_unit, display_order,
       created_by, updated_by, device_id
     ) VALUES (?, ?, 'BOTTLE', 1, 800, 1, 1, 0, ?, ?, ?)`,
  ).run(bottleId, star.id, actor, actor, 'seed-dev');
  db.prepare(
    `INSERT INTO product_units (
       id, product_id, unit_name, conversion_factor, price_pesewas,
       is_purchase_unit, is_sale_unit, display_order,
       created_by, updated_by, device_id
     ) VALUES (?, ?, 'CRATE', 24, 18000, 1, 1, 1, ?, ?, ?)`,
  ).run(crateId, star.id, actor, actor, 'seed-dev');

  // Pricing tier: 12+ bottles at WHOLESALE = 750
  db.prepare(
    `INSERT INTO pricing_tiers (
       id, product_id, channel, min_quantity, unit_price_pesewas,
       priority, applies_to_unit_id, created_by, updated_by, device_id
     ) VALUES (?, ?, 'WHOLESALE', 12, 750, 10, ?, ?, ?, ?)`,
  ).run(`pt-${uuidv4()}`, star.id, bottleId, actor, actor, 'seed-dev');

  // Customer price override for Auntie Akua on Star BOTTLE
  db.prepare(
    `INSERT INTO customer_price_overrides (
       id, customer_id, product_id, applies_to_unit_id, channel,
       price_pesewas, created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, 'WHOLESALE', 700, ?, ?, ?)`,
  ).run(`cpo-${uuidv4()}`, custId, star.id, bottleId, actor, actor, 'seed-dev');

  // Mark Star's primary sale + purchase unit so the second-pass FK
  // resolution actually has something to resolve.
  db.prepare(
    `UPDATE products SET primary_sale_unit_id = ?, primary_purchase_unit_id = ?
       WHERE id = ?`,
  ).run(bottleId, crateId, star.id);
}

main();
