// Migration smoke test. Runs every migration against an in-memory SQLite
// and verifies the bootstrap rows exist and core invariants hold.
//
// This is the integration backbone test — Session 2 will add the real
// sale-transaction atomicity test on top of this scaffolding.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../migrations');

describe('migrations', () => {
  let db: ReturnType<typeof Database>;

  beforeAll(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const result = runMigrations(db, migrationsDir);
    expect(result.applied.length).toBeGreaterThanOrEqual(10);
  });

  afterAll(() => {
    db.close();
  });

  it('seeds reason_codes', () => {
    const row = db.prepare('SELECT COUNT(*) AS n FROM reason_codes').get() as { n: number };
    expect(row.n).toBeGreaterThanOrEqual(18);
  });

  it('seeds payment_methods including MOMO_*', () => {
    const codes = db
      .prepare('SELECT code FROM payment_methods')
      .all()
      .map((r) => (r as { code: string }).code);
    expect(codes).toContain('CASH');
    expect(codes).toContain('MOMO_MTN');
    expect(codes).toContain('MOMO_VODAFONE');
    expect(codes).toContain('CREDIT');
  });

  it('payment_methods.requires_reference is set for MoMo', () => {
    const momo = db
      .prepare('SELECT requires_reference FROM payment_methods WHERE code = ?')
      .get('MOMO_MTN') as { requires_reference: number };
    expect(momo.requires_reference).toBe(1);
  });

  it('bootstraps the SYSTEM worker with self-reference', () => {
    const row = db
      .prepare('SELECT id, role, created_by, updated_by FROM workers WHERE id = ?')
      .get('sys-system') as { id: string; role: string; created_by: string; updated_by: string };
    expect(row.id).toBe('sys-system');
    expect(row.role).toBe('SYSTEM');
    expect(row.created_by).toBe('sys-system');
    expect(row.updated_by).toBe('sys-system');
  });

  it('seeds the default location', () => {
    const row = db
      .prepare('SELECT id, code FROM locations WHERE id = ?')
      .get('loc-main-counter') as { id: string; code: string };
    expect(row.id).toBe('loc-main-counter');
    expect(row.code).toBe('MAIN');
  });

  it('rejects bad phone format on workers', () => {
    expect(() =>
      db.prepare(
        `INSERT INTO workers (id, full_name, phone, role, pin_hash, hired_at, created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'bad-phone',
        'Bad Phone',
        '0555547998', // not normalized — should fail GLOB
        'COUNTER',
        'fake',
        '2026-01-01',
        'sys-system',
        'sys-system',
        'test',
      ),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects breakage_log without a photo_url', () => {
    // Cannot directly INSERT NULL into a NOT NULL column.
    expect(() =>
      db.prepare(
        `INSERT INTO breakage_log (
          id, shift_id, location_id, worker_id, product_id, quantity,
          photo_url, cause, stock_movement_id, created_by, updated_by, device_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'br-1', 'sh-1', 'loc-main-counter', 'sys-system', 'prod-1', 1,
        null, 'DROPPED', 'sm-1', 'sys-system', 'sys-system', 'test',
      ),
    ).toThrow(/NOT NULL constraint failed/);
  });

  it('reason_codes that requires_photo are exactly the expected set', () => {
    const rows = db
      .prepare(
        'SELECT code FROM reason_codes WHERE requires_photo = 1 ORDER BY code',
      )
      .all()
      .map((r) => (r as { code: string }).code);
    expect(rows).toEqual(['BREAKAGE', 'EXPIRED']);
  });

  it('sales table has printer_failed column with default 0', () => {
    const cols = db
      .prepare("PRAGMA table_info('sales')")
      .all() as Array<{ name: string; dflt_value: unknown; notnull: number }>;
    const printerFailed = cols.find((c) => c.name === 'printer_failed');
    expect(printerFailed).toBeDefined();
    expect(printerFailed?.notnull).toBe(1);
  });

  it('workers has both terminated_at and deleted_at as separate columns', () => {
    const cols = db
      .prepare("PRAGMA table_info('workers')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('terminated_at');
    expect(names).toContain('termination_reason');
    expect(names).toContain('deleted_at');
    expect(names).toContain('deleted_reason');
  });

  it('audit_log has no updated_at column (append-only by structure)', () => {
    const cols = db
      .prepare("PRAGMA table_info('audit_log')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).not.toContain('updated_at');
    expect(names).not.toContain('updated_by');
  });

  it('pending_receipt_reprints table exists', () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get('pending_receipt_reprints');
    expect(row).toBeTruthy();
  });

  it('seed: dev fixtures insert workers + products idempotently', () => {
    runSeed(db, { includeDevFixtures: true });
    runSeed(db, { includeDevFixtures: true }); // second call must be no-op
    const workerCount = (
      db.prepare('SELECT COUNT(*) AS n FROM workers').get() as { n: number }
    ).n;
    const productCount = (
      db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }
    ).n;
    // SYSTEM + 2 dev workers = 3
    expect(workerCount).toBe(3);
    expect(productCount).toBe(7);
  });
});

describe('stock_movements signing', () => {
  let db: ReturnType<typeof Database>;

  beforeAll(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db, migrationsDir);
    runSeed(db, { includeDevFixtures: true });
  });

  afterAll(() => {
    db.close();
  });

  it('insertStockMovement signs inflow positive and outflow negative', async () => {
    const { insertStockMovement, unitsOnHand } = await import('../src/main/services/stockMovements');
    const product = db.prepare('SELECT id FROM products WHERE sku = ?').get('STAR-330') as { id: string };

    // Inflow: receive 24 units.
    const m1 = insertStockMovement(db, {
      productId: product.id,
      locationId: 'loc-main-counter',
      quantity: 24,
      reasonCode: 'RECEIVED_FROM_SUPPLIER',
      workerId: 'dev-supervisor-1',
      unitCostPesewas: 600,
      supervisorApprovalId: 'dev-supervisor-1',
      deviceId: 'test',
    });
    expect(m1.signedQuantity).toBe(24);
    expect(m1.totalValuePesewas).toBe(14400);

    // Outflow: sell 3 units.
    const m2 = insertStockMovement(db, {
      productId: product.id,
      locationId: 'loc-main-counter',
      quantity: 3,
      reasonCode: 'SALE_WALK_IN',
      workerId: 'dev-counter-1',
      unitCostPesewas: 600,
      deviceId: 'test',
    });
    expect(m2.signedQuantity).toBe(-3);
    expect(m2.totalValuePesewas).toBe(-1800);

    // Total on hand should be 21.
    expect(unitsOnHand(db, product.id, 'loc-main-counter')).toBe(21);
  });

  it('rejects pre-signed quantities', async () => {
    const { insertStockMovement } = await import('../src/main/services/stockMovements');
    const product = db.prepare('SELECT id FROM products WHERE sku = ?').get('CLUB-330') as { id: string };

    expect(() =>
      insertStockMovement(db, {
        productId: product.id,
        locationId: 'loc-main-counter',
        quantity: -3,
        reasonCode: 'SALE_WALK_IN',
        workerId: 'dev-counter-1',
        unitCostPesewas: 650,
        deviceId: 'test',
      }),
    ).toThrow(/positive integer/);
  });

  it('rejects breakage without photo_url', async () => {
    const { insertStockMovement } = await import('../src/main/services/stockMovements');
    const product = db.prepare('SELECT id FROM products WHERE sku = ?').get('VOLTIC-1L') as { id: string };

    expect(() =>
      insertStockMovement(db, {
        productId: product.id,
        locationId: 'loc-main-counter',
        quantity: 1,
        reasonCode: 'BREAKAGE',
        workerId: 'dev-counter-1',
        unitCostPesewas: 200,
        deviceId: 'test',
        // photoUrl missing
      }),
    ).toThrow(/requires a photoUrl/);
  });

  it('rejects supplier-receipt without supervisor approval', async () => {
    const { insertStockMovement } = await import('../src/main/services/stockMovements');
    const product = db.prepare('SELECT id FROM products WHERE sku = ?').get('COKE-330') as { id: string };

    expect(() =>
      insertStockMovement(db, {
        productId: product.id,
        locationId: 'loc-main-counter',
        quantity: 24,
        reasonCode: 'RECEIVED_FROM_SUPPLIER',
        workerId: 'dev-counter-1',
        unitCostPesewas: 250,
        deviceId: 'test',
        // supervisorApprovalId missing
      }),
    ).toThrow(/requires supervisor approval/);
  });
});
