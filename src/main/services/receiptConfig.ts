// Receipt customization — header lines, footer message, paper width,
// margins, density, weight, visibility toggles. Stored as a JSON blob in
// device_config under key `receipt_config`; shop_name / shop_subtitle stay
// in their own keys (owned by the first-run wizard) and are merged into
// the response so the renderer fetches once.

import type { Database as DB } from 'better-sqlite3';

export type ReceiptDensity = 'compact' | 'normal' | 'spacious';
export type ReceiptPaperWidth = 58 | 80;

export interface ReceiptConfig {
  shopName: string;
  shopSubtitle: string | null;
  headerLine3: string | null;
  headerLine4: string | null;
  footerText: string;
  paperWidthMm: ReceiptPaperWidth;
  sideMarginMm: number;
  density: ReceiptDensity;
  bold: boolean;
  showCashier: boolean;
  showChannel: boolean;
  showCustomer: boolean;
}

export const DEFAULT_RECEIPT_CONFIG: Omit<ReceiptConfig, 'shopName' | 'shopSubtitle'> = {
  headerLine3: null,
  headerLine4: null,
  footerText: 'Thank you. Come again.',
  paperWidthMm: 80,
  sideMarginMm: 2,
  density: 'normal',
  bold: true,
  showCashier: true,
  showChannel: true,
  showCustomer: true,
};

const RECEIPT_KEY = 'receipt_config';

export function getReceiptConfig(db: DB): ReceiptConfig {
  const rows = db
    .prepare(`SELECT key, value FROM device_config WHERE key IN ('shop_name', 'shop_subtitle', ?)`)
    .all(RECEIPT_KEY) as Array<{ key: string; value: string }>;
  const map = new Map(rows.map((r) => [r.key, r.value]));

  let stored: Partial<ReceiptConfig> = {};
  const raw = map.get(RECEIPT_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<ReceiptConfig>;
      if (parsed && typeof parsed === 'object') stored = parsed;
    } catch {
      // Corrupt blob — fall through to defaults; next save will overwrite.
    }
  }

  return {
    shopName: map.get('shop_name') ?? 'COUNTER SHOP',
    shopSubtitle: map.get('shop_subtitle') ?? null,
    headerLine3: normalizeOptional(stored.headerLine3) ?? DEFAULT_RECEIPT_CONFIG.headerLine3,
    headerLine4: normalizeOptional(stored.headerLine4) ?? DEFAULT_RECEIPT_CONFIG.headerLine4,
    footerText: typeof stored.footerText === 'string' && stored.footerText.length > 0
      ? stored.footerText
      : DEFAULT_RECEIPT_CONFIG.footerText,
    paperWidthMm: stored.paperWidthMm === 58 || stored.paperWidthMm === 80
      ? stored.paperWidthMm
      : DEFAULT_RECEIPT_CONFIG.paperWidthMm,
    sideMarginMm: clampMargin(stored.sideMarginMm),
    density: isDensity(stored.density) ? stored.density : DEFAULT_RECEIPT_CONFIG.density,
    bold: typeof stored.bold === 'boolean' ? stored.bold : DEFAULT_RECEIPT_CONFIG.bold,
    showCashier: typeof stored.showCashier === 'boolean' ? stored.showCashier : DEFAULT_RECEIPT_CONFIG.showCashier,
    showChannel: typeof stored.showChannel === 'boolean' ? stored.showChannel : DEFAULT_RECEIPT_CONFIG.showChannel,
    showCustomer: typeof stored.showCustomer === 'boolean' ? stored.showCustomer : DEFAULT_RECEIPT_CONFIG.showCustomer,
  };
}

export interface ReceiptConfigInput {
  shopName: string;
  shopSubtitle: string | null;
  headerLine3: string | null;
  headerLine4: string | null;
  footerText: string;
  paperWidthMm: ReceiptPaperWidth;
  sideMarginMm: number;
  density: ReceiptDensity;
  bold: boolean;
  showCashier: boolean;
  showChannel: boolean;
  showCustomer: boolean;
}

export function setReceiptConfig(db: DB, input: ReceiptConfigInput): ReceiptConfig {
  const shopName = input.shopName.trim();
  if (!shopName) throw new Error('Shop name cannot be empty.');
  if (shopName.length > 60) throw new Error('Shop name is too long (max 60 characters).');

  const shopSubtitle = trimOrNull(input.shopSubtitle, 60, 'Subtitle');
  const headerLine3 = trimOrNull(input.headerLine3, 60, 'Header line 3');
  const headerLine4 = trimOrNull(input.headerLine4, 60, 'Header line 4');

  const footerText = (input.footerText ?? '').trim();
  if (!footerText) throw new Error('Footer text cannot be empty.');
  if (footerText.length > 120) throw new Error('Footer text is too long (max 120 characters).');

  if (input.paperWidthMm !== 58 && input.paperWidthMm !== 80) {
    throw new Error(`Paper width must be 58 or 80mm, got '${input.paperWidthMm}'.`);
  }
  if (!isDensity(input.density)) {
    throw new Error(`Density must be compact|normal|spacious, got '${input.density}'.`);
  }
  const sideMarginMm = clampMargin(input.sideMarginMm);

  const blob: Omit<ReceiptConfig, 'shopName' | 'shopSubtitle'> = {
    headerLine3,
    headerLine4,
    footerText,
    paperWidthMm: input.paperWidthMm,
    sideMarginMm,
    density: input.density,
    bold: !!input.bold,
    showCashier: !!input.showCashier,
    showChannel: !!input.showChannel,
    showCustomer: !!input.showCustomer,
  };

  const upsert = db.prepare(
    `INSERT INTO device_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                    set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );
  const tx = db.transaction(() => {
    upsert.run('shop_name', shopName);
    if (shopSubtitle) upsert.run('shop_subtitle', shopSubtitle);
    else db.prepare(`DELETE FROM device_config WHERE key = 'shop_subtitle'`).run();
    upsert.run(RECEIPT_KEY, JSON.stringify(blob));
  });
  tx();

  return getReceiptConfig(db);
}

function trimOrNull(value: string | null | undefined, max: number, label: string): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new Error(`${label} is too long (max ${max} characters).`);
  return trimmed;
}

function normalizeOptional(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function isDensity(v: unknown): v is ReceiptDensity {
  return v === 'compact' || v === 'normal' || v === 'spacious';
}

function clampMargin(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return DEFAULT_RECEIPT_CONFIG.sideMarginMm;
  return Math.max(0, Math.min(6, Math.round(n)));
}
