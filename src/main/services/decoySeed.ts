// Automatic seed for the "Counters" decoy build.
//
// This runs only when COUNTERS_DECOY=1. It creates a separate, plausible,
// low-volume database inside the Counters app identity so the UI looks like the
// real Counter app without copying production transactions.

import type { Database as DB } from 'better-sqlite3';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import fs from 'node:fs';
import path from 'node:path';
import { PIN_BCRYPT_ROUNDS, DEFAULT_LOCATION_ID } from '../../shared/lib/constants.js';
import { createFirstOwner, needsOwnerSetup } from './setup.js';
import { addProduct } from './productsAdmin.js';
import { receiveStock } from './stockReceipts.js';
import { computeAndCloseShift, openShift, submitClosingCount } from './shifts.js';
import { completeSaleCore, type CompleteSaleLine } from './sales.js';
import { generateDailySummary } from './dailySummaries.js';

const SEED_VERSION = '6';
const CASHIER_ID = 'w-counters-cashier';
const DAILY_SALES_CAP_PESEWAS = 500_000;
const DAILY_TARGETS_PESEWAS = [285_000, 340_000, 245_000, 395_000, 310_000, 430_000, 265_000];
const MAX_SALES_PER_DAY = 12;

interface SeedProduct {
  sku: string;
  name: string;
  category: string;
  brand: string | null;
  costPesewas: number;
  walkInPesewas: number;
  wholesalePesewas: number;
  routePesewas: number;
  openingStock: number;
  units: Array<{
    unitName: string;
    conversionFactor: number;
    pricePesewas: number;
    isSaleUnit?: boolean;
    isPurchaseUnit?: boolean;
  }>;
}

interface SeededProduct extends SeedProduct {
  productId: string;
  unitIds: string[];
}

const PRODUCTS: SeedProduct[] = [
  {
    sku: 'COKE_350',
    name: 'Coca-Cola 350ml glass',
    category: 'SOFT_DRINK',
    brand: 'Coca-Cola',
    costPesewas: 500,
    walkInPesewas: 800,
    wholesalePesewas: 760,
    routePesewas: 750,
    openingStock: 72,
    units: [
      { unitName: 'BOTTLE', conversionFactor: 1, pricePesewas: 800, isSaleUnit: true, isPurchaseUnit: false },
      { unitName: 'CRATE', conversionFactor: 24, pricePesewas: 18000, isSaleUnit: true, isPurchaseUnit: true },
    ],
  },
  {
    sku: 'STAR_625',
    name: 'Star Beer 625ml',
    category: 'BEER',
    brand: 'Star',
    costPesewas: 1500,
    walkInPesewas: 2200,
    wholesalePesewas: 2100,
    routePesewas: 2050,
    openingStock: 48,
    units: [
      { unitName: 'BOTTLE', conversionFactor: 1, pricePesewas: 2200, isSaleUnit: true, isPurchaseUnit: false },
      { unitName: 'CRATE', conversionFactor: 12, pricePesewas: 25200, isSaleUnit: true, isPurchaseUnit: true },
    ],
  },
  {
    sku: 'VOLTIC_500',
    name: 'Voltic Water 500ml',
    category: 'WATER',
    brand: 'Voltic',
    costPesewas: 250,
    walkInPesewas: 500,
    wholesalePesewas: 450,
    routePesewas: 430,
    openingStock: 120,
    units: [
      { unitName: 'BOTTLE', conversionFactor: 1, pricePesewas: 500, isSaleUnit: true, isPurchaseUnit: false },
      { unitName: 'PACK', conversionFactor: 24, pricePesewas: 10500, isSaleUnit: true, isPurchaseUnit: true },
    ],
  },
  {
    sku: 'MALT_330',
    name: 'Beta Malt 330ml',
    category: 'SOFT_DRINK',
    brand: 'Beta Malt',
    costPesewas: 650,
    walkInPesewas: 1000,
    wholesalePesewas: 920,
    routePesewas: 900,
    openingStock: 60,
    units: [
      { unitName: 'BOTTLE', conversionFactor: 1, pricePesewas: 1000, isSaleUnit: true, isPurchaseUnit: false },
      { unitName: 'CRATE', conversionFactor: 24, pricePesewas: 22000, isSaleUnit: true, isPurchaseUnit: true },
    ],
  },
];

const SALE_PATTERNS: Array<Array<{ productIndex: number; quantity: number }>> = [
  [{ productIndex: 0, quantity: 2 }, { productIndex: 2, quantity: 1 }],
  [{ productIndex: 1, quantity: 1 }],
  [{ productIndex: 2, quantity: 3 }],
  [{ productIndex: 3, quantity: 2 }, { productIndex: 0, quantity: 1 }],
  [{ productIndex: 0, quantity: 1 }, { productIndex: 1, quantity: 1 }],
  [{ productIndex: 2, quantity: 2 }, { productIndex: 3, quantity: 1 }],
];

export function ensureCountersDecoySeed(db: DB, deviceId: string, countersUserDataDir: string): void {
  const current = getConfig(db, 'counters_decoy_seed_version');
  const ownerId = ensureWorkers(db, deviceId);
  setConfig(db, 'shop_name', 'COUNTER');
  setConfig(db, 'shop_subtitle', 'Adabraka Branch');

  if (current !== SEED_VERSION || shouldRebuildRollingWeek(db)) {
    resetDecoyBusinessData(db);

    const products = ensureProducts(db, ownerId, deviceId, countersUserDataDir);
    ensureOpeningStock(db, products, ownerId, deviceId);
    backdateOpeningStock(db);
    ensureSales(db, products, ownerId, deviceId);
    ensureDailySummaries(db, ownerId, deviceId);
    assertDailySalesStayQuiet(db);

    setConfig(db, 'counters_decoy_seed_version', SEED_VERSION);
    return;
  }

  refreshCountersDecoyData(db, deviceId);
}

export function refreshCountersDecoyData(db: DB, deviceId: string): void {
  const ownerId = ensureWorkers(db, deviceId);
  const products = loadSeededProductsFromDb(db);
  if (products.length === 0) return;
  ensureTodayShiftAndSales(db, products, ownerId, deviceId);
  generateDailySummary(db, {
    date: localDateString(new Date()),
    locationId: DEFAULT_LOCATION_ID,
    workerId: ownerId,
    deviceId,
  });
  assertDailySalesStayQuiet(db);
}

function ensureWorkers(db: DB, deviceId: string): string {
  let ownerId: string | null = null;
  if (needsOwnerSetup(db)) {
    ownerId = createFirstOwner(db, {
      fullName: 'Shop Owner',
      phone: '+233244000000',
      pin: '1234',
      deviceId,
    }).workerId;
  }

  if (!ownerId) {
    const owner = db.prepare(
      `SELECT id FROM workers
        WHERE role = 'OWNER' AND active = 1 AND deleted_at IS NULL AND terminated_at IS NULL
        ORDER BY created_at ASC LIMIT 1`,
    ).get() as { id: string } | undefined;
    ownerId = owner?.id ?? 'sys-system';
  }

  const cashier = db.prepare('SELECT id FROM workers WHERE id = ?').get(CASHIER_ID) as { id: string } | undefined;
  if (!cashier) {
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    db.prepare(
      `INSERT INTO workers (
        id, full_name, phone, role, pin_hash,
        base_salary_pesewas, consumption_allowance_units, active,
        hired_at, notes, created_by, updated_by, device_id
      ) VALUES (?, ?, ?, 'COUNTER', ?, 0, 8, 1, ?, NULL, ?, ?, ?)`,
    ).run(
      CASHIER_ID,
      'Counter Cashier',
      '+233244000001',
      bcrypt.hashSync('0000', PIN_BCRYPT_ROUNDS),
      today,
      ownerId,
      ownerId,
      deviceId,
    );
  }

  return ownerId;
}

function ensureProducts(db: DB, ownerId: string, deviceId: string, countersUserDataDir: string): SeededProduct[] {
  const seeded: SeededProduct[] = [];
  const catalog = loadProductionCatalogSnapshot(countersUserDataDir) ?? PRODUCTS;
  for (const p of catalog) {
    const existing = db.prepare('SELECT id FROM products WHERE sku = ?').get(p.sku) as { id: string } | undefined;
    if (existing) {
      const units = db.prepare('SELECT id FROM product_units WHERE product_id = ? ORDER BY display_order ASC')
        .all(existing.id) as Array<{ id: string }>;
      seeded.push({ ...p, productId: existing.id, unitIds: units.map((u) => u.id) });
      continue;
    }
    const result = addProduct(db, {
      sku: p.sku,
      name: p.name,
      category: p.category,
      brand: p.brand ?? null,
      packSizeUnits: p.units.at(-1)?.conversionFactor ?? 1,
      costPricePesewas: p.costPesewas,
      walkInPricePesewas: p.walkInPesewas,
      wholesalePricePesewas: p.wholesalePesewas,
      routePricePesewas: p.routePesewas,
      reorderThreshold: Math.max(12, Math.floor(p.openingStock / 4)),
      reorderQuantity: p.openingStock,
      units: p.units,
      actorWorkerId: ownerId,
      deviceId,
    });
    db.prepare('UPDATE products SET primary_sale_unit_id = ?, primary_purchase_unit_id = ? WHERE id = ?')
      .run(result.unitIds[0] ?? null, result.unitIds[1] ?? result.unitIds[0] ?? null, result.productId);
    seeded.push({ ...p, productId: result.productId, unitIds: result.unitIds });
  }
  return seeded;
}

function ensureOpeningStock(db: DB, products: SeededProduct[], ownerId: string, deviceId: string): void {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE reason_code = 'OPENING_STOCK'")
    .get() as { n: number };
  if (existing.n > 0) return;

  receiveStock(db, {
    supplierId: null,
    isOpeningStock: true,
    locationId: DEFAULT_LOCATION_ID,
    workerId: ownerId,
    supervisorApprovalId: ownerId,
    lines: products.map((p) => ({
      productId: p.productId,
      quantity: p.openingStock,
      unitCostPesewas: p.costPesewas,
      unitId: null,
    })),
    notes: 'Opening balance',
    deviceId,
  });
}

function ensureSales(
  db: DB,
  products: SeededProduct[],
  ownerId: string,
  deviceId: string,
): void {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM sales').get() as { n: number };
  if (existing.n > 0) return;

  const saleProducts = products
    .filter((p) => p.unitIds.length > 0 && preferredSaleUnit(p).pricePesewas > 0)
    .sort((a, b) => preferredSaleUnit(a).pricePesewas - preferredSaleUnit(b).pricePesewas)
    .slice(0, 24);
  if (saleProducts.length === 0) return;

  for (let day = 6; day >= 0; day--) {
    const openedAt = isoAtDaysAgo(day, 8, 10 + (day % 4) * 5);
    const closedAt = isoAtDaysAgo(day, 18, 5 + (day % 5) * 7);
    const shiftId = openShift(db, {
      workerId: ownerId,
      locationId: DEFAULT_LOCATION_ID,
      shiftType: 'COUNTER',
      openingCashPesewas: 10_000 + day * 750,
      deviceId,
    }).shiftId;
    backdateShiftOpen(db, shiftId, openedAt);

    let dailyTotal = 0;
    const target = targetForDay(day, new Date());
    for (let idx = 0; idx < MAX_SALES_PER_DAY; idx++) {
      const remaining = Math.min(
        target - dailyTotal,
        DAILY_SALES_CAP_PESEWAS - 1 - dailyTotal,
      );
      if (remaining <= 0) break;
      const plan = salePlanForCatalog(saleProducts, day, idx, remaining);
      if (!plan) break;
      const result = completeSaleCore(db, {
        shiftId,
        workerId: ownerId,
        workerName: 'Shop Owner',
        locationId: DEFAULT_LOCATION_ID,
        channel: 'WALK_IN',
        lines: plan.lines,
        paymentMethod: idx % 4 === 0 ? 'MOMO_MTN' : 'CASH',
        paymentReference: idx % 4 === 0 ? `MM${day}${idx}7421` : null,
        cashGivenPesewas: idx % 4 === 0 ? null : plan.totalPesewas,
        deviceId,
        shopName: 'COUNTER',
        shopSubtitle: 'Adabraka Branch',
      });
      const saleMinute = saleMinuteForIndex(day, idx);
      backdateSale(db, result.saleId, day, Math.floor(saleMinute / 60), saleMinute % 60);
      dailyTotal += result.totalPesewas;
    }

    const totals = shiftTotals(db, shiftId);
    db.prepare('UPDATE shifts SET total_sales_pesewas = ?, updated_at = ? WHERE id = ?')
      .run(totals.totalSalesPesewas, closedAt, shiftId);

    if (day > 0) {
      const variance = [-200, 0, 150, -100, 0, 250, -150][day % 7]!;
      submitClosingCount(db, shiftId, Math.max(0, totals.expectedCashPesewas + variance), ownerId, deviceId);
      computeAndCloseShift(db, shiftId, ownerId, deviceId);
      backdateShiftClose(db, shiftId, closedAt);
    }
  }
}

function ensureTodayShiftAndSales(
  db: DB,
  products: SeededProduct[],
  ownerId: string,
  deviceId: string,
): void {
  const today = localDateString(new Date());
  const saleProducts = products
    .filter((p) => p.unitIds.length > 0 && preferredSaleUnit(p).pricePesewas > 0)
    .sort((a, b) => preferredSaleUnit(a).pricePesewas - preferredSaleUnit(b).pricePesewas)
    .slice(0, 24);
  if (saleProducts.length === 0) return;

  const shiftId = ensureTodayOpenShift(db, ownerId, deviceId);
  const current = dailySalesTotal(db, today);
  const existingCount = dailySalesCount(db, today);
  const desired = Math.min(targetForDay(0, new Date()), DAILY_SALES_CAP_PESEWAS - 1);
  if (current >= desired || existingCount >= MAX_SALES_PER_DAY) {
    updateOpenShiftTotals(db, shiftId);
    return;
  }

  let dailyTotal = current;
  const maxNewSales = Math.min(2, MAX_SALES_PER_DAY - existingCount);
  for (let n = 0; n < maxNewSales; n++) {
    const idx = existingCount + n;
    const remaining = Math.min(desired - dailyTotal, DAILY_SALES_CAP_PESEWAS - 1 - dailyTotal);
    if (remaining <= 0) break;
    const plan = salePlanForCatalog(saleProducts, 0, idx, remaining);
    if (!plan) break;
    const result = completeSaleCore(db, {
      shiftId,
      workerId: ownerId,
      workerName: 'Shop Owner',
      locationId: DEFAULT_LOCATION_ID,
      channel: 'WALK_IN',
      lines: plan.lines,
      paymentMethod: idx % 4 === 0 ? 'MOMO_MTN' : 'CASH',
      paymentReference: idx % 4 === 0 ? `MM0${idx}${Date.now().toString().slice(-4)}` : null,
      cashGivenPesewas: idx % 4 === 0 ? null : plan.totalPesewas,
      deviceId,
      shopName: 'COUNTER',
      shopSubtitle: 'Adabraka Branch',
    });
    dailyTotal += result.totalPesewas;
  }
  updateOpenShiftTotals(db, shiftId);
}

function ensureTodayOpenShift(db: DB, ownerId: string, deviceId: string): string {
  const today = localDateString(new Date());
  const existingToday = db.prepare(
    `SELECT id FROM shifts
      WHERE worker_id = ?
        AND location_id = ?
        AND date(opened_at) = ?
      ORDER BY opened_at DESC
      LIMIT 1`,
  ).get(ownerId, DEFAULT_LOCATION_ID, today) as { id: string } | undefined;
  if (existingToday) return existingToday.id;

  const existingOpen = db.prepare(
    `SELECT id FROM shifts
      WHERE worker_id = ? AND closed_at IS NULL
      ORDER BY opened_at DESC
      LIMIT 1`,
  ).get(ownerId) as { id: string } | undefined;
  if (existingOpen) {
    const totals = shiftTotals(db, existingOpen.id);
    submitClosingCount(db, existingOpen.id, totals.expectedCashPesewas, ownerId, deviceId);
    computeAndCloseShift(db, existingOpen.id, ownerId, deviceId);
  }

  const openedAt = isoAtDaysAgo(0, 8, 10);
  const shiftId = openShift(db, {
    workerId: ownerId,
    locationId: DEFAULT_LOCATION_ID,
    shiftType: 'COUNTER',
    openingCashPesewas: 10_000,
    deviceId,
  }).shiftId;
  backdateShiftOpen(db, shiftId, openedAt);
  return shiftId;
}

function updateOpenShiftTotals(db: DB, shiftId: string): void {
  const totals = shiftTotals(db, shiftId);
  db.prepare('UPDATE shifts SET total_sales_pesewas = ?, updated_at = ? WHERE id = ?')
    .run(totals.totalSalesPesewas, new Date().toISOString(), shiftId);
}

function backdateSale(db: DB, saleId: string, daysAgo: number, hour: number, minute: number): void {
  const iso = isoAtDaysAgo(daysAgo, hour, minute);
  for (const table of ['sales', 'sale_lines', 'sale_payments', 'stock_movements']) {
    const key = table === 'sales' ? 'id' : table === 'stock_movements' ? 'sale_id' : 'sale_id';
    db.prepare(`UPDATE ${table} SET created_at = ?, updated_at = ? WHERE ${key} = ?`).run(iso, iso, saleId);
  }
}

function backdateOpeningStock(db: DB): void {
  const iso = isoAtDaysAgo(7, 7, 30);
  db.prepare(
    `UPDATE stock_movements
        SET created_at = ?, updated_at = ?
      WHERE reason_code = 'OPENING_STOCK'`,
  ).run(iso, iso);
}

function backdateShiftOpen(db: DB, shiftId: string, openedAt: string): void {
  db.prepare(
    `UPDATE shifts
        SET opened_at = ?, created_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(openedAt, openedAt, openedAt, shiftId);
  db.prepare(
    `UPDATE cash_counts
        SET created_at = ?, updated_at = ?
      WHERE shift_id = ? AND count_type = 'SHIFT_OPEN'`,
  ).run(openedAt, openedAt, shiftId);
}

function backdateShiftClose(db: DB, shiftId: string, closedAt: string): void {
  db.prepare(
    `UPDATE shifts
        SET closed_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(closedAt, closedAt, shiftId);
  db.prepare(
    `UPDATE cash_counts
        SET created_at = ?, updated_at = ?
      WHERE shift_id = ? AND count_type = 'SHIFT_CLOSE'`,
  ).run(closedAt, closedAt, shiftId);
}

function isoAtDaysAgo(daysAgo: number, hour: number, minute: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function salePatternForCatalog(productCount: number, day: number, idx: number): Array<{ productIndex: number; quantity: number }> {
  const fallback = SALE_PATTERNS[(day + idx) % SALE_PATTERNS.length]!
    .filter((line) => line.productIndex < productCount);
  if (fallback.length > 0) return fallback;
  const first = (day + idx) % productCount;
  const second = (first + 2) % productCount;
  return productCount === 1
    ? [{ productIndex: 0, quantity: 1 + ((day + idx) % 2) }]
    : [
        { productIndex: first, quantity: 1 + (idx % 2) },
        { productIndex: second, quantity: 1 },
      ];
}

function saleMinuteForIndex(day: number, idx: number): number {
  return 9 * 60 + idx * 42 + ((day + idx) % 7);
}

function targetForDay(day: number, now: Date): number {
  const fullTarget = DAILY_TARGETS_PESEWAS[(6 - day) % DAILY_TARGETS_PESEWAS.length]!;
  if (day !== 0) return fullTarget;

  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const open = 8 * 60 + 30;
  const close = 19 * 60;
  if (minutesNow <= open) return 0;
  if (minutesNow >= close) return fullTarget;

  const progress = (minutesNow - open) / (close - open);
  const shaped = Math.min(1, Math.max(0, progress));
  return Math.floor(fullTarget * shaped);
}

function dailySalesTotal(db: DB, date: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(total_pesewas), 0) AS total
       FROM sales
      WHERE voided = 0 AND date(created_at) = ?`,
  ).get(date) as { total: number };
  return row.total;
}

function dailySalesCount(db: DB, date: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS count
       FROM sales
      WHERE voided = 0 AND date(created_at) = ?`,
  ).get(date) as { count: number };
  return row.count;
}

function shouldRebuildRollingWeek(db: DB): boolean {
  const today = localDateString(new Date());
  const row = db.prepare(
    `SELECT COUNT(*) AS summaryCount,
            MAX(summary_date) AS latestSummaryDate
       FROM daily_summaries`,
  ).get() as { summaryCount: number; latestSummaryDate: string | null };
  if (row.summaryCount === 0) return true;
  return row.latestSummaryDate !== today;
}

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function loadSeededProductsFromDb(db: DB): SeededProduct[] {
  const products = db.prepare(
    `SELECT id AS productId, sku, name, category, brand,
            cost_price_pesewas AS costPesewas,
            walk_in_price_pesewas AS walkInPesewas,
            wholesale_price_pesewas AS wholesalePesewas,
            route_price_pesewas AS routePesewas,
            reorder_quantity AS openingStock
       FROM products
      WHERE active = 1 AND deleted_at IS NULL
      ORDER BY name ASC`,
  ).all() as Array<Omit<SeededProduct, 'units' | 'unitIds'>>;

  const unitsStmt = db.prepare(
    `SELECT id, unit_name AS unitName, conversion_factor AS conversionFactor,
            price_pesewas AS pricePesewas,
            is_sale_unit AS isSaleUnit,
            is_purchase_unit AS isPurchaseUnit
       FROM product_units
      WHERE product_id = ? AND active = 1
      ORDER BY display_order ASC, conversion_factor ASC`,
  );

  return products.map((p) => {
    const units = unitsStmt.all(p.productId) as Array<{
      id: string;
      unitName: string;
      conversionFactor: number;
      pricePesewas: number;
      isSaleUnit: number;
      isPurchaseUnit: number;
    }>;
    if (units.length === 0) {
      return {
        ...p,
        openingStock: p.openingStock ?? 24,
        unitIds: [],
        units: [{
          unitName: 'UNIT',
          conversionFactor: 1,
          pricePesewas: p.walkInPesewas,
          isSaleUnit: true,
          isPurchaseUnit: true,
        }],
      };
    }
    return {
      ...p,
      openingStock: p.openingStock ?? 24,
      unitIds: units.map((u) => u.id),
      units: units.map((u) => ({
        unitName: u.unitName,
        conversionFactor: u.conversionFactor,
        pricePesewas: u.pricePesewas,
        isSaleUnit: u.isSaleUnit === 1,
        isPurchaseUnit: u.isPurchaseUnit === 1,
      })),
    };
  });
}

function salePlanForCatalog(
  products: SeededProduct[],
  day: number,
  idx: number,
  remainingPesewas: number,
): { lines: CompleteSaleLine[]; totalPesewas: number } | null {
  const lines: CompleteSaleLine[] = [];
  let totalPesewas = 0;
  for (const item of salePatternForCatalog(products.length, day, idx)) {
    const product = products[item.productIndex];
    if (!product) continue;
    const unit = preferredSaleUnit(product);
    const available = remainingPesewas - totalPesewas;
    const quantity = Math.min(item.quantity, Math.floor(available / unit.pricePesewas));
    if (quantity <= 0) continue;
    lines.push({
      productId: product.productId,
      quantity,
      unitId: unit.unitId,
      unitPricePesewas: unit.pricePesewas,
    });
    totalPesewas += quantity * unit.pricePesewas;
  }

  if (lines.length === 0) {
    const product = products.find((p) => preferredSaleUnit(p).pricePesewas <= remainingPesewas);
    if (!product) return null;
    const unit = preferredSaleUnit(product);
    lines.push({
      productId: product.productId,
      quantity: 1,
      unitId: unit.unitId,
      unitPricePesewas: unit.pricePesewas,
    });
    totalPesewas = unit.pricePesewas;
  }

  return { lines, totalPesewas };
}

function preferredSaleUnit(product: SeededProduct): { unitId: string | null; pricePesewas: number } {
  let bestIndex = 0;
  for (let idx = 1; idx < product.units.length; idx++) {
    const best = product.units[bestIndex]!;
    const unit = product.units[idx]!;
    if (!unit.isSaleUnit) continue;
    if (!best.isSaleUnit || unit.conversionFactor < best.conversionFactor) bestIndex = idx;
  }
  const unit = product.units[bestIndex];
  return {
    unitId: product.unitIds[bestIndex] ?? product.unitIds[0] ?? null,
    pricePesewas: Math.max(1, unit?.pricePesewas ?? product.walkInPesewas),
  };
}

function shiftTotals(db: DB, shiftId: string): { totalSalesPesewas: number; expectedCashPesewas: number } {
  const shift = db.prepare('SELECT opening_cash_pesewas AS openingCashPesewas FROM shifts WHERE id = ?')
    .get(shiftId) as { openingCashPesewas: number };
  const sales = db.prepare(
    `SELECT COALESCE(SUM(total_pesewas), 0) AS total
       FROM sales WHERE shift_id = ? AND voided = 0`,
  ).get(shiftId) as { total: number };
  const cash = db.prepare(
    `SELECT COALESCE(SUM(sp.amount_pesewas), 0) AS total
       FROM sale_payments sp
       JOIN sales s ON s.id = sp.sale_id
      WHERE s.shift_id = ? AND s.voided = 0 AND sp.payment_method = 'CASH'`,
  ).get(shiftId) as { total: number };
  return {
    totalSalesPesewas: sales.total,
    expectedCashPesewas: shift.openingCashPesewas + cash.total,
  };
}

function ensureDailySummaries(db: DB, ownerId: string, deviceId: string): void {
  for (let day = 6; day >= 0; day--) {
    generateDailySummary(db, {
      date: isoAtDaysAgo(day, 12, 0).slice(0, 10),
      locationId: DEFAULT_LOCATION_ID,
      workerId: ownerId,
      deviceId,
    });
  }
}

function assertDailySalesStayQuiet(db: DB): void {
  const rows = db.prepare(
    `SELECT date(created_at) AS day, COALESCE(SUM(total_pesewas), 0) AS total
       FROM sales
      WHERE voided = 0
      GROUP BY date(created_at)
     HAVING total >= ?`,
  ).all(DAILY_SALES_CAP_PESEWAS) as Array<{ day: string; total: number }>;
  if (rows.length > 0) {
    throw new Error(`Counters decoy seed exceeded daily sales cap: ${rows.map((r) => `${r.day}=${r.total}`).join(', ')}`);
  }
}

function loadProductionCatalogSnapshot(countersUserDataDir: string): SeedProduct[] | null {
  const sourcePath = resolveProductionDbPath(countersUserDataDir);
  if (!sourcePath) return null;

  let source: Database.Database | null = null;
  try {
    source = new Database(sourcePath, { readonly: true, fileMustExist: true });
    const rows = source.prepare(
      `SELECT id, sku, name, category, brand,
              cost_price_pesewas, walk_in_price_pesewas,
              wholesale_price_pesewas, route_price_pesewas,
              reorder_quantity
         FROM products
        WHERE active = 1 AND deleted_at IS NULL
        ORDER BY name ASC`,
    ).all() as Array<{
      id: string;
      sku: string;
      name: string;
      category: string;
      brand: string | null;
      cost_price_pesewas: number;
      walk_in_price_pesewas: number;
      wholesale_price_pesewas: number;
      route_price_pesewas: number;
      reorder_quantity: number;
    }>;
    if (rows.length === 0) return null;

    const unitsStmt = source.prepare(
      `SELECT unit_name, conversion_factor, price_pesewas, is_sale_unit, is_purchase_unit
         FROM product_units
        WHERE product_id = ? AND active = 1
        ORDER BY display_order ASC, conversion_factor ASC`,
    );

    return rows.map((row, idx) => {
      const sourceUnits = unitsStmt.all(row.id) as Array<{
        unit_name: string;
        conversion_factor: number;
        price_pesewas: number;
        is_sale_unit: number;
        is_purchase_unit: number;
      }>;
      const units = sourceUnits.length > 0
        ? sourceUnits.map((u) => ({
            unitName: u.unit_name,
            conversionFactor: u.conversion_factor,
            pricePesewas: u.price_pesewas,
            isSaleUnit: u.is_sale_unit === 1,
            isPurchaseUnit: u.is_purchase_unit === 1,
          })).sort((a, b) => {
            if (a.isSaleUnit !== b.isSaleUnit) return a.isSaleUnit ? -1 : 1;
            return a.conversionFactor - b.conversionFactor;
          })
        : [{
            unitName: 'UNIT',
            conversionFactor: 1,
            pricePesewas: row.walk_in_price_pesewas,
            isSaleUnit: true,
            isPurchaseUnit: true,
          }];
      return {
        sku: row.sku,
        name: row.name,
        category: row.category,
        brand: row.brand,
        costPesewas: Math.max(0, Math.trunc(row.cost_price_pesewas)),
        walkInPesewas: Math.max(0, Math.trunc(row.walk_in_price_pesewas)),
        wholesalePesewas: Math.max(0, Math.trunc(row.wholesale_price_pesewas)),
        routePesewas: Math.max(0, Math.trunc(row.route_price_pesewas)),
        openingStock: fakeOpeningStock(row.reorder_quantity, idx),
        units,
      };
    });
  } catch {
    return null;
  } finally {
    source?.close();
  }
}

function resolveProductionDbPath(countersUserDataDir: string): string | null {
  const explicit = process.env['COUNTERS_CATALOG_DB'];
  if (explicit && fs.existsSync(explicit)) return explicit;

  const parent = path.dirname(countersUserDataDir);
  const candidates = [
    path.join(parent, 'Counter', 'counter.db'),
    path.join(parent, 'counter', 'counter.db'),
    path.join(process.cwd(), 'dev.db'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function fakeOpeningStock(reorderQuantity: number, idx: number): number {
  const base = Number.isInteger(reorderQuantity) && reorderQuantity > 0 ? reorderQuantity : 24;
  return Math.max(8, Math.min(144, Math.round((base * (2 + (idx % 3))) / 2)));
}

function resetDecoyBusinessData(db: DB): void {
  db.pragma('foreign_keys = OFF');
  const tables = [
    'sale_payments',
    'sale_lines',
    'customer_payment_allocations',
    'customer_payments',
    'customer_return_lines',
    'customer_returns',
    'customer_price_overrides',
    'supplier_payment_allocations',
    'supplier_payments',
    'purchase_order_lines',
    'purchase_orders',
    'sales',
    'stocktake_lines',
    'stocktake_events',
    'cash_counts',
    'petty_cash_expenses',
    'breakage_log',
    'worker_consumption_log',
    'container_movements',
    'pending_order_lines',
    'pending_orders',
    'delivery_attempts',
    'route_stops',
    'route_runs',
    'route_customer_links',
    'routes',
    'pending_receipt_reprints',
    'period_closes',
    'daily_summaries',
    'worker_monthly_performance',
    'promotions',
    'pin_attempts',
    'audit_log',
    'shifts',
    'stock_movements',
    'pricing_tiers',
    'product_units',
    'products',
    'customers',
    'suppliers',
  ];
  const tx = db.transaction(() => {
    for (const table of tables) {
      try {
        db.prepare(`DELETE FROM ${table}`).run();
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes('no such table')) throw err;
      }
    }
  });
  try {
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function getConfig(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM device_config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function setConfig(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO device_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(key, value);
}
