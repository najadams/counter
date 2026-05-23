// Seed data beyond what the migrations themselves embed.
//
// 0001 already seeds reason_codes, deletion_reasons, payment_methods.
// 0002 already seeds the SYSTEM worker.
// 0003 already seeds the default location (loc-main-counter).
//
// This module is the place to add dev-time fixtures (sample products, a
// test counter worker) that live OUTSIDE production migrations. Running it
// is opt-in via db:reset; it never runs on db:migrate.

import type { Database as DB } from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_LOCATION_ID,
  PIN_BCRYPT_ROUNDS,
  SYSTEM_WORKER_ID,
} from '../../shared/lib/constants.js';

export interface SeedOptions {
  /** Include sample products and a non-system counter worker for dev use. */
  includeDevFixtures: boolean;
  /** PIN for the dev counter worker. Default: '1234'. */
  devCounterPin?: string;
}

export function runSeed(db: DB, opts: SeedOptions): void {
  if (!opts.includeDevFixtures) return;

  // Idempotent: skip if the dev worker already exists.
  const existing = db
    .prepare('SELECT id FROM workers WHERE id = ?')
    .get('dev-counter-1') as { id: string } | undefined;
  if (existing) return;

  const deviceId = 'seed-dev';
  const pin = opts.devCounterPin ?? '1234';
  const pinHash = bcrypt.hashSync(pin, PIN_BCRYPT_ROUNDS);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO workers (
        id, full_name, phone, role, pin_hash,
        base_salary_pesewas, consumption_allowance_units, active,
        hired_at, created_by, updated_by, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'dev-counter-1',
      'Dev Counter',
      '+233555000001',
      'COUNTER',
      pinHash,
      150000, // GHS 1500/mo
      8,
      1,
      '2026-01-01',
      SYSTEM_WORKER_ID,
      SYSTEM_WORKER_ID,
      deviceId,
    );

    db.prepare(
      `INSERT INTO workers (
        id, full_name, phone, role, pin_hash,
        base_salary_pesewas, consumption_allowance_units, active,
        hired_at, created_by, updated_by, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'dev-supervisor-1',
      'Dev Supervisor',
      '+233555000002',
      'SUPERVISOR',
      bcrypt.hashSync('9999', PIN_BCRYPT_ROUNDS),
      300000,
      8,
      1,
      '2026-01-01',
      SYSTEM_WORKER_ID,
      SYSTEM_WORKER_ID,
      deviceId,
    );

    // Sample supplier
    const supplierId = `sup-${uuidv4()}`;
    db.prepare(
      `INSERT INTO suppliers (
        id, name, contact_person, phone, payment_terms_days,
        created_by, updated_by, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      supplierId,
      'Accra Beverage Distributors',
      'Kwame Mensah',
      '+233244111222',
      14,
      SYSTEM_WORKER_ID,
      SYSTEM_WORKER_ID,
      deviceId,
    );

    // Sample products — beverage staples
    const products: Array<[
      string, // sku
      string, // name
      string, // category
      string, // brand
      number, // pack_size
      number | null, // volume
      number, // is_returnable (0/1)
      number, // bottle_deposit
      number, // cost
      number, // walk_in
      number, // wholesale
      number, // route
      number, // reorder threshold
      number, // reorder qty
    ]> = [
      ['STAR-330',  'Star Beer 330ml',          'BEER',         'Star',   24, 330,  1, 100, 600, 800, 750, 720, 24, 96],
      ['CLUB-330',  'Club Premium 330ml',       'BEER',         'Club',   24, 330,  1, 100, 650, 850, 800, 770, 24, 96],
      ['VOLTIC-1L', 'Voltic Mineral Water 1L',  'WATER',        'Voltic', 12, 1000, 0,   0, 200, 300, 250, 240, 36, 144],
      ['COKE-330',  'Coca-Cola 330ml Can',      'SOFT_DRINK',   'Coke',   24, 330,  0,   0, 250, 400, 350, 330, 24, 96],
      ['SPRITE-50', 'Sprite 500ml PET',         'SOFT_DRINK',   'Sprite', 12, 500,  0,   0, 350, 550, 500, 480, 12, 60],
      ['MALTA-330', 'Malta Guinness 330ml',     'SOFT_DRINK',   'Malta',  24, 330,  1, 100, 500, 700, 650, 630, 24, 96],
      ['SMNF-200',  'Smirnoff Ice 275ml',       'SPIRITS',      'Smirnoff', 24, 275, 1, 100, 1100, 1500, 1400, 1350, 12, 48],
    ];

    const insertProduct = db.prepare(
      `INSERT INTO products (
        id, sku, name, category, brand, pack_size_units, unit_volume_ml,
        is_returnable, bottle_deposit_pesewas,
        cost_price_pesewas, walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
        reorder_threshold, reorder_quantity, primary_supplier_id,
        created_by, updated_by, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    // Migration 0015 backfills a canonical UNIT row for every product that
    // existed at migration time, but this seed runs AFTER migrations. New
    // seeded products therefore had no product_units row, leaving
    // defaultSaleUnit() returning null and any unit-aware test reaching
    // for a UNIT row hitting undefined. Mirror the 0015 backfill shape
    // here so every fresh seed-product starts with a valid canonical row.
    const insertUnit = db.prepare(
      `INSERT INTO product_units (
        id, product_id, unit_name, conversion_factor, price_pesewas,
        is_purchase_unit, is_sale_unit, display_order,
        created_by, updated_by, device_id
      ) VALUES (?, ?, 'UNIT', 1, ?, 1, 1, 0, ?, ?, ?)`,
    );
    for (const p of products) {
      const productId = `prod-${uuidv4()}`;
      insertProduct.run(
        productId,
        p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7],
        p[8], p[9], p[10], p[11],
        p[12], p[13],
        supplierId,
        SYSTEM_WORKER_ID, SYSTEM_WORKER_ID, deviceId,
      );
      insertUnit.run(
        `pu-default-${productId}`,
        productId,
        p[9], // price_pesewas = walk_in_price_pesewas (same as 0015 backfill)
        SYSTEM_WORKER_ID, SYSTEM_WORKER_ID, deviceId,
      );
    }
  })();

  // Mark this in the audit log so it's traceable.
  db.prepare(
    `INSERT INTO audit_log (id, worker_id, action, entity_type, entity_id, after_value, device_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    `aud-${uuidv4()}`,
    SYSTEM_WORKER_ID,
    'DEV_FIXTURES_SEEDED',
    'system',
    DEFAULT_LOCATION_ID,
    JSON.stringify({ workers: 2, products: 7, supplier: 1 }),
    deviceId,
    'Dev fixtures inserted by db:reset',
  );
}
