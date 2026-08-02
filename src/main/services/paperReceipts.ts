import type { Database as DB } from 'better-sqlite3';
import { execFile } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { readPhotoAsDataUri, savePhoto } from '../db/photos.js';
import { completeSale, type CompleteSaleResult, type SaleChannel } from './sales.js';
import { defaultSaleUnit, getUnit, priceForUnit } from './productUnits.js';
import { unitsOnHand } from './stockMovements.js';

type PaymentMethod = 'CASH' | 'MOMO_MTN' | 'MOMO_VODAFONE' | 'MOMO_AIRTELTIGO' | 'BANK_TRANSFER' | 'CREDIT';
type ImportStatus = 'REVIEW' | 'POSTED' | 'DISCARDED';

export interface PaperReceiptLineDraft {
  id: string;
  lineNo: number;
  rawText: string;
  productId: string | null;
  productSku: string | null;
  productName: string | null;
  unitId: string | null;
  unitName: string | null;
  quantity: number | null;
  unitPricePesewas: number | null;
  confidence: number;
  reviewNote: string | null;
}

export interface PaperReceiptSummary {
  id: string;
  status: ImportStatus;
  createdAt: string;
  workerName: string;
  channel: SaleChannel;
  paymentMethod: PaymentMethod;
  lineCount: number;
  matchedLineCount: number;
  totalPesewas: number;
  postedSaleId: string | null;
  tillOpenedAt: string | null;
  tillOpenedByName: string | null;
}

export interface PaperReceiptDetail extends PaperReceiptSummary {
  ocrText: string;
  photoDataUri: string | null;
  photoBytes: number | null;
  paymentReference: string | null;
  cashGivenPesewas: number | null;
  customerId: string | null;
  customerName: string | null;
  lines: PaperReceiptLineDraft[];
}

interface ProductForMatch {
  id: string;
  sku: string;
  name: string;
}

interface OcrReceiptLine {
  rawText: string;
  productText: string;
  unitText: string | null;
  quantity: number | null;
  unitPricePesewas: number | null;
  confidence: number;
}

export interface PaperReceiptCartLine {
  productId: string;
  sku: string;
  name: string;
  unitId: string | null;
  unitName: string;
  factor: number;
  unitPricePesewas: number;
  quantity: number;
  unitsOnHand: number;
}

export interface ResolvedPaperReceiptCart {
  draftId: string;
  channel: SaleChannel;
  lines: PaperReceiptCartLine[];
}

export interface CreatePaperReceiptDraftInput {
  shiftId: string;
  workerId: string;
  locationId: string;
  photoBytes: Buffer | Uint8Array;
  photoExtension: string;
  userDataDir: string;
  ocrText: string;
  channel: SaleChannel;
  paymentMethod: PaymentMethod;
  paymentReference?: string | null;
  cashGivenPesewas?: number | null;
  customerId?: string | null;
  deviceId: string;
}

export interface UpdatePaperReceiptDraftInput {
  draftId: string;
  workerId: string;
  ocrText: string;
  channel: SaleChannel;
  paymentMethod: PaymentMethod;
  paymentReference?: string | null;
  cashGivenPesewas?: number | null;
  customerId?: string | null;
  lines: Array<{
    rawText: string;
    productId: string | null;
    unitId?: string | null;
    quantity: number | null;
    unitPricePesewas: number | null;
    confidence?: number;
    reviewNote?: string | null;
  }>;
  deviceId: string;
}

export interface PostPaperReceiptDraftInput {
  draftId: string;
  workerId: string;
  workerName: string;
  shopName: string;
  shopSubtitle?: string | null;
  deviceId: string;
  station?: 'counter' | 'door';
}

export async function createPaperReceiptDraft(
  db: DB,
  input: CreatePaperReceiptDraftInput,
): Promise<{ draftId: string }> {
  validatePaymentFields(input.paymentMethod, input.paymentReference ?? null, input.cashGivenPesewas ?? null);

  const saved = savePhoto({
    bytes: input.photoBytes,
    extension: input.photoExtension,
    kind: 'paper_receipts',
    userDataDir: input.userDataDir,
  });
  const draftId = `pri-${uuidv4()}`;
  const ocr = input.ocrText.trim()
    ? { rawText: input.ocrText, lines: null as OcrReceiptLine[] | null, provider: 'manual' }
    : await recognizePaperReceiptImage(saved.absolutePath);
  const parsed = ocr.lines && ocr.lines.length > 0
    ? matchOcrLinesToCatalog(db, ocr.lines, input.channel)
    : parsePaperReceiptText(db, ocr.rawText, input.channel);

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO paper_receipt_imports (
        id, shift_id, worker_id, location_id, status, photo_url, ocr_text,
        channel, payment_method, payment_reference, cash_given_pesewas, customer_id,
        created_by, updated_by, device_id
      ) VALUES (?, ?, ?, ?, 'REVIEW', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      draftId,
      input.shiftId,
      input.workerId,
      input.locationId,
      saved.relativePath,
      ocr.rawText,
      input.channel,
      input.paymentMethod,
      input.paymentReference ?? null,
      input.cashGivenPesewas ?? null,
      input.customerId ?? null,
      input.workerId,
      input.workerId,
      input.deviceId,
    );
    insertDraftLines(db, draftId, parsed, input.workerId, input.deviceId);
    logAudit(db, {
      workerId: input.workerId,
      action: 'PAPER_RECEIPT_IMPORTED',
      entityType: 'paper_receipt_imports',
      entityId: draftId,
      afterValue: {
        lineCount: parsed.length,
        matchedLineCount: parsed.filter((l) => l.productId).length,
        photoBytes: saved.bytes,
        ocrProvider: ocr.provider,
      },
      deviceId: input.deviceId,
    });
  });
  tx();
  return { draftId };
}

export function listPaperReceiptDrafts(db: DB, limit = 50, now = new Date()): PaperReceiptSummary[] {
  const completedCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(
    `SELECT pri.id, pri.status, pri.created_at AS createdAt, w.full_name AS workerName,
            pri.channel, pri.payment_method AS paymentMethod, pri.posted_sale_id AS postedSaleId,
            pri.till_opened_at AS tillOpenedAt, till_worker.full_name AS tillOpenedByName,
            COUNT(l.id) AS lineCount,
            SUM(CASE WHEN l.product_id IS NOT NULL AND l.quantity IS NOT NULL AND l.unit_price_pesewas IS NOT NULL THEN 1 ELSE 0 END) AS matchedLineCount,
            COALESCE(SUM(CASE WHEN l.quantity IS NOT NULL AND l.unit_price_pesewas IS NOT NULL THEN l.quantity * l.unit_price_pesewas ELSE 0 END), 0) AS totalPesewas
       FROM paper_receipt_imports pri
       JOIN workers w ON w.id = pri.worker_id
       LEFT JOIN workers till_worker ON till_worker.id = pri.till_opened_by
       LEFT JOIN paper_receipt_import_lines l ON l.import_id = pri.id
      WHERE pri.status = 'REVIEW' OR pri.updated_at >= ?
      GROUP BY pri.id
      ORDER BY pri.created_at DESC
      LIMIT ?`,
  ).all(completedCutoff, limit) as Array<{
    id: string; status: ImportStatus; createdAt: string; workerName: string;
    channel: SaleChannel; paymentMethod: PaymentMethod; lineCount: number;
    matchedLineCount: number | null; totalPesewas: number; postedSaleId: string | null;
    tillOpenedAt: string | null; tillOpenedByName: string | null;
  }>;
  return rows.map((r) => ({
    ...r,
    matchedLineCount: r.matchedLineCount ?? 0,
  }));
}

export function getPaperReceiptDraft(db: DB, draftId: string, userDataDir: string): PaperReceiptDetail {
  const row = db.prepare(
    `SELECT pri.id, pri.status, pri.created_at AS createdAt, w.full_name AS workerName,
            pri.channel, pri.payment_method AS paymentMethod, pri.payment_reference AS paymentReference,
            pri.cash_given_pesewas AS cashGivenPesewas, pri.customer_id AS customerId,
            c.display_name AS customerName, pri.posted_sale_id AS postedSaleId,
            pri.till_opened_at AS tillOpenedAt, till_worker.full_name AS tillOpenedByName,
            pri.ocr_text AS ocrText, pri.photo_url AS photoUrl
       FROM paper_receipt_imports pri
       JOIN workers w ON w.id = pri.worker_id
       LEFT JOIN workers till_worker ON till_worker.id = pri.till_opened_by
       LEFT JOIN customers c ON c.id = pri.customer_id
      WHERE pri.id = ?`,
  ).get(draftId) as
    | {
        id: string; status: ImportStatus; createdAt: string; workerName: string;
        channel: SaleChannel; paymentMethod: PaymentMethod; paymentReference: string | null;
        cashGivenPesewas: number | null; customerId: string | null; customerName: string | null;
        postedSaleId: string | null; tillOpenedAt: string | null; tillOpenedByName: string | null;
        ocrText: string; photoUrl: string;
      }
    | undefined;
  if (!row) throw new Error(`paper receipt draft ${draftId} not found`);
  const lines = listLines(db, draftId);
  const photo = readPhotoAsDataUri(userDataDir, row.photoUrl);
  return {
    ...summaryFromDetailRow(row, lines),
    ocrText: row.ocrText,
    photoDataUri: photo?.dataUri ?? null,
    photoBytes: photo?.bytes ?? null,
    paymentReference: row.paymentReference,
    cashGivenPesewas: row.cashGivenPesewas,
    customerId: row.customerId,
    customerName: row.customerName,
    lines,
  };
}

export function updatePaperReceiptDraft(db: DB, input: UpdatePaperReceiptDraftInput): void {
  validatePaymentFields(input.paymentMethod, input.paymentReference ?? null, input.cashGivenPesewas ?? null);
  const existing = db.prepare('SELECT status FROM paper_receipt_imports WHERE id = ?').get(input.draftId) as
    | { status: ImportStatus }
    | undefined;
  if (!existing) throw new Error(`paper receipt draft ${input.draftId} not found`);
  if (existing.status !== 'REVIEW') throw new Error(`paper receipt draft is ${existing.status.toLowerCase()}`);
  const lines = normalizeManualLines(db, input.lines, input.channel);
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE paper_receipt_imports
          SET ocr_text = ?, channel = ?, payment_method = ?, payment_reference = ?,
              cash_given_pesewas = ?, customer_id = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(
      input.ocrText,
      input.channel,
      input.paymentMethod,
      input.paymentReference ?? null,
      input.cashGivenPesewas ?? null,
      input.customerId ?? null,
      new Date().toISOString(),
      input.workerId,
      input.draftId,
    );
    db.prepare('DELETE FROM paper_receipt_import_lines WHERE import_id = ?').run(input.draftId);
    insertDraftLines(db, input.draftId, lines, input.workerId, input.deviceId);
    logAudit(db, {
      workerId: input.workerId,
      action: 'PAPER_RECEIPT_REVIEW_UPDATED',
      entityType: 'paper_receipt_imports',
      entityId: input.draftId,
      afterValue: { lineCount: lines.length, matchedLineCount: lines.filter((l) => l.productId).length },
      deviceId: input.deviceId,
    });
  });
  tx();
}

export function reparsePaperReceiptDraft(
  db: DB,
  input: Omit<UpdatePaperReceiptDraftInput, 'lines'>,
): void {
  const parsed = parsePaperReceiptText(db, input.ocrText, input.channel);
  updatePaperReceiptDraft(db, { ...input, lines: parsed });
}

export async function postPaperReceiptDraft(
  db: DB,
  input: PostPaperReceiptDraftInput,
): Promise<CompleteSaleResult & { draftId: string }> {
  const detail = getPaperReceiptDraft(db, input.draftId, process.cwd());
  if (detail.status !== 'REVIEW') throw new Error(`paper receipt draft is ${detail.status.toLowerCase()}`);
  const rows = db.prepare(
    `SELECT shift_id AS shiftId, location_id AS locationId, channel,
            payment_method AS paymentMethod, payment_reference AS paymentReference,
            cash_given_pesewas AS cashGivenPesewas, customer_id AS customerId
       FROM paper_receipt_imports WHERE id = ?`,
  ).get(input.draftId) as {
    shiftId: string; locationId: string; channel: SaleChannel; paymentMethod: PaymentMethod;
    paymentReference: string | null; cashGivenPesewas: number | null; customerId: string | null;
  };
  const lines = listLines(db, input.draftId)
    .filter((l) => l.productId && l.quantity != null && l.unitPricePesewas != null)
    .map((l) => ({
      productId: l.productId!,
      quantity: l.quantity!,
      unitId: l.unitId,
      unitPricePesewas: l.unitPricePesewas!,
    }));
  if (lines.length === 0) throw new Error('paper receipt has no reviewed sale lines');
  const incomplete = listLines(db, input.draftId).find((l) => !l.productId || l.quantity == null || l.unitPricePesewas == null);
  if (incomplete) throw new Error(`line ${incomplete.lineNo} still needs review`);

  const result = await completeSale(db, {
    shiftId: rows.shiftId,
    workerId: input.workerId,
    workerName: input.workerName,
    locationId: rows.locationId,
    channel: rows.channel,
    lines,
    paymentMethod: rows.paymentMethod,
    paymentReference: rows.paymentReference,
    cashGivenPesewas: rows.cashGivenPesewas,
    customerId: rows.customerId,
    deviceId: input.deviceId,
    shopName: input.shopName,
    shopSubtitle: input.shopSubtitle,
    station: input.station,
  });

  db.prepare(
    `UPDATE paper_receipt_imports
        SET status = 'POSTED', posted_sale_id = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND status = 'REVIEW'`,
  ).run(result.saleId, new Date().toISOString(), input.workerId, input.draftId);
  logAudit(db, {
    workerId: input.workerId,
    action: 'PAPER_RECEIPT_POSTED',
    entityType: 'paper_receipt_imports',
    entityId: input.draftId,
    afterValue: { saleId: result.saleId, totalPesewas: result.totalPesewas },
    deviceId: input.deviceId,
  });
  return { ...result, draftId: input.draftId };
}

export function discardPaperReceiptDraft(db: DB, draftId: string, reason: string, workerId: string, deviceId: string): void {
  if (!reason.trim()) throw new Error('discard reason is required');
  const existing = db.prepare('SELECT status FROM paper_receipt_imports WHERE id = ?').get(draftId) as
    | { status: ImportStatus }
    | undefined;
  if (!existing) throw new Error(`paper receipt draft ${draftId} not found`);
  if (existing.status !== 'REVIEW') throw new Error(`paper receipt draft is ${existing.status.toLowerCase()}`);
  db.prepare(
    `UPDATE paper_receipt_imports
        SET status = 'DISCARDED', discarded_reason = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
  ).run(reason.trim(), new Date().toISOString(), workerId, draftId);
  logAudit(db, {
    workerId,
    action: 'PAPER_RECEIPT_DISCARDED',
    entityType: 'paper_receipt_imports',
    entityId: draftId,
    afterValue: { reason: reason.trim() },
    deviceId,
  });
}

export function resolvePaperReceiptDraftForCart(
  db: DB,
  draftId: string,
  locationId: string,
): ResolvedPaperReceiptCart {
  const draft = db.prepare(
    `SELECT id, status, channel FROM paper_receipt_imports WHERE id = ?`,
  ).get(draftId) as { id: string; status: ImportStatus; channel: SaleChannel } | undefined;
  if (!draft) throw new Error(`paper receipt draft ${draftId} not found`);
  if (draft.status !== 'REVIEW') throw new Error(`paper receipt draft is ${draft.status.toLowerCase()}`);

  const lines = listLines(db, draftId);
  const incomplete = lines.find((line) => !line.productId || line.quantity == null || line.unitPricePesewas == null);
  if (incomplete) {
    throw new Error(`line ${incomplete.lineNo} is incomplete; match product, quantity, and price before opening at till`);
  }

  return {
    draftId,
    channel: draft.channel,
    lines: lines.map((line) => {
      const product = db.prepare(
        `SELECT sku, name FROM products WHERE id = ? AND active = 1 AND deleted_at IS NULL`,
      ).get(line.productId) as { sku: string; name: string } | undefined;
      if (!product) throw new Error(`line ${line.lineNo}: product is no longer active`);

      let unitId = line.unitId;
      let unitName = line.unitName ?? 'UNIT';
      let factor = 1;
      if (unitId) {
        const unit = getUnit(db, unitId);
        if (!unit || !unit.active || !unit.isSaleUnit || unit.productId !== line.productId) {
          throw new Error(`line ${line.lineNo}: unit is no longer active`);
        }
        unitName = unit.unitName;
        factor = unit.conversionFactor;
      } else {
        const unit = defaultSaleUnit(db, line.productId!);
        if (unit) {
          unitId = unit.id;
          unitName = unit.unitName;
          factor = unit.conversionFactor;
        }
      }

      return {
        productId: line.productId!,
        sku: product.sku,
        name: product.name,
        unitId,
        unitName,
        factor,
        unitPricePesewas: line.unitPricePesewas!,
        quantity: line.quantity!,
        unitsOnHand: unitsOnHand(db, line.productId!, locationId),
      };
    }),
  };
}

export function openPaperReceiptDraftAtTill(
  db: DB,
  draftId: string,
  locationId: string,
  workerId: string,
  deviceId: string,
): ResolvedPaperReceiptCart {
  const resolved = resolvePaperReceiptDraftForCart(db, draftId, locationId);
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE paper_receipt_imports
        SET till_opened_at = COALESCE(till_opened_at, ?),
            till_opened_by = COALESCE(till_opened_by, ?),
            updated_at = ?,
            updated_by = ?
      WHERE id = ? AND status = 'REVIEW'`,
  ).run(now, workerId, now, workerId, draftId);
  if (result.changes > 0) {
    logAudit(db, {
      workerId,
      action: 'PAPER_RECEIPT_OPENED_AT_TILL',
      entityType: 'paper_receipt_imports',
      entityId: draftId,
      afterValue: { lineCount: resolved.lines.length },
      deviceId,
    });
  }
  return resolved;
}

export function markPaperReceiptDraftPostedFromTill(
  db: DB,
  draftId: string,
  saleId: string,
  workerId: string,
  deviceId: string,
): void {
  const existing = db.prepare('SELECT status, posted_sale_id AS postedSaleId FROM paper_receipt_imports WHERE id = ?').get(draftId) as
    | { status: ImportStatus; postedSaleId: string | null }
    | undefined;
  if (!existing) throw new Error(`paper receipt draft ${draftId} not found`);
  if (existing.status === 'POSTED') {
    if (existing.postedSaleId === saleId) return;
    throw new Error(`paper receipt draft is already posted as ${existing.postedSaleId ?? 'another sale'}`);
  }
  if (existing.status !== 'REVIEW') throw new Error(`paper receipt draft is ${existing.status.toLowerCase()}`);

  const result = db.prepare(
    `UPDATE paper_receipt_imports
        SET status = 'POSTED', posted_sale_id = ?, updated_at = ?, updated_by = ?
      WHERE id = ? AND status = 'REVIEW'`,
  ).run(saleId, new Date().toISOString(), workerId, draftId);
  if (result.changes === 0) throw new Error('paper receipt draft was not posted');
  logAudit(db, {
    workerId,
    action: 'PAPER_RECEIPT_POSTED_FROM_TILL',
    entityType: 'paper_receipt_imports',
    entityId: draftId,
    afterValue: { saleId },
    deviceId,
  });
}

export function parsePaperReceiptText(db: DB, text: string, channel: SaleChannel): PaperReceiptLineDraft[] {
  const products = db.prepare(
    `SELECT id, sku, name FROM products
      WHERE active = 1 AND deleted_at IS NULL
      ORDER BY LENGTH(sku) DESC, LENGTH(name) DESC`,
  ).all() as ProductForMatch[];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, idx) => matchLine(db, line, idx + 1, products, channel));
}

function matchOcrLinesToCatalog(db: DB, lines: OcrReceiptLine[], channel: SaleChannel): PaperReceiptLineDraft[] {
  const products = db.prepare(
    `SELECT id, sku, name FROM products
      WHERE active = 1 AND deleted_at IS NULL
      ORDER BY LENGTH(sku) DESC, LENGTH(name) DESC`,
  ).all() as ProductForMatch[];
  return lines.map((line, idx) => {
    const searchable = [line.productText, line.rawText].filter(Boolean).join(' ');
    const product = findProduct(normalize(searchable), products);
    let unit = product ? findUnitInLine(db, product.id, normalize([line.unitText ?? '', line.rawText].join(' '))) : null;
    if (product && !unit) unit = defaultSaleUnit(db, product.id);
    const quantity = line.quantity ?? extractQuantity(line.rawText) ?? (product ? 1 : null);
    const catalogPrice = product ? priceForUnit(db, product.id, unit?.id ?? null, channel) : null;
    const productConfidence = product ? 35 : 0;
    return {
      id: `ocr-line-${idx + 1}`,
      lineNo: idx + 1,
      rawText: line.rawText || line.productText,
      productId: product?.id ?? null,
      productSku: product?.sku ?? null,
      productName: product?.name ?? null,
      unitId: unit?.id ?? null,
      unitName: unit?.unitName ?? null,
      quantity,
      unitPricePesewas: line.unitPricePesewas ?? catalogPrice,
      confidence: Math.max(0, Math.min(100, Math.round((line.confidence * 0.65) + productConfidence))),
      reviewNote: product ? null : 'OCR could not match this product',
    };
  });
}

function matchLine(
  db: DB,
  rawText: string,
  lineNo: number,
  products: ProductForMatch[],
  channel: SaleChannel,
): PaperReceiptLineDraft {
  const normalized = normalize(rawText);
  const qty = extractQuantity(rawText);
  const product = findProduct(normalized, products);
  let unit = product ? findUnitInLine(db, product.id, normalized) : null;
  if (product && !unit) unit = defaultSaleUnit(db, product.id);
  const price = extractLastMoney(rawText, qty);
  const catalogPrice = product ? priceForUnit(db, product.id, unit?.id ?? null, channel) : null;
  const confidence =
    (product ? 55 : 0) +
    (qty != null ? 15 : 0) +
    (price != null ? 15 : 0) +
    (unit ? 10 : 0) +
    (product && normalized.includes(normalize(product.sku)) ? 5 : 0);
  return {
    id: `draft-line-${lineNo}`,
    lineNo,
    rawText,
    productId: product?.id ?? null,
    productSku: product?.sku ?? null,
    productName: product?.name ?? null,
    unitId: unit?.id ?? null,
    unitName: unit?.unitName ?? null,
    quantity: qty ?? (product ? 1 : null),
    unitPricePesewas: price ?? catalogPrice,
    confidence: Math.min(confidence, 100),
    reviewNote: product ? null : 'No product match',
  };
}

function normalizeManualLines(
  db: DB,
  lines: UpdatePaperReceiptDraftInput['lines'],
  channel: SaleChannel,
): PaperReceiptLineDraft[] {
  return lines.map((line, idx) => {
    const product = line.productId
      ? db.prepare('SELECT id, sku, name FROM products WHERE id = ? AND active = 1 AND deleted_at IS NULL').get(line.productId) as ProductForMatch | undefined
      : undefined;
    if (line.productId && !product) throw new Error(`line ${idx + 1}: product not found or inactive`);
    let unit = line.unitId ? getUnit(db, line.unitId) : null;
    if (line.unitId && (!unit || !unit.active || !unit.isSaleUnit || unit.productId !== line.productId)) {
      throw new Error(`line ${idx + 1}: invalid sale unit`);
    }
    if (product && !unit) unit = defaultSaleUnit(db, product.id);
    const qty = line.quantity ?? extractQuantity(line.rawText) ?? (product ? 1 : null);
    const price = line.unitPricePesewas ?? (product ? priceForUnit(db, product.id, unit?.id ?? null, channel) : null);
    if (qty != null && (!Number.isInteger(qty) || qty <= 0)) throw new Error(`line ${idx + 1}: quantity must be positive`);
    if (price != null && (!Number.isInteger(price) || price < 0)) throw new Error(`line ${idx + 1}: price must be non-negative`);
    return {
      id: `draft-line-${idx + 1}`,
      lineNo: idx + 1,
      rawText: line.rawText,
      productId: product?.id ?? null,
      productSku: product?.sku ?? null,
      productName: product?.name ?? null,
      unitId: unit?.id ?? null,
      unitName: unit?.unitName ?? null,
      quantity: qty,
      unitPricePesewas: price,
      confidence: line.confidence ?? (product ? 80 : 0),
      reviewNote: line.reviewNote ?? (product ? null : 'No product match'),
    };
  });
}

function insertDraftLines(db: DB, draftId: string, lines: PaperReceiptLineDraft[], workerId: string, deviceId: string): void {
  const stmt = db.prepare(
    `INSERT INTO paper_receipt_import_lines (
      id, import_id, line_no, raw_text, product_id, product_sku_snapshot,
      product_name_snapshot, unit_id, unit_name_snapshot, quantity,
      unit_price_pesewas, confidence, review_note,
      created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const line of lines) {
    stmt.run(
      `pril-${uuidv4()}`,
      draftId,
      line.lineNo,
      line.rawText,
      line.productId,
      line.productSku,
      line.productName,
      line.unitId,
      line.unitName,
      line.quantity,
      line.unitPricePesewas,
      line.confidence,
      line.reviewNote,
      workerId,
      workerId,
      deviceId,
    );
  }
}

function listLines(db: DB, draftId: string): PaperReceiptLineDraft[] {
  return db.prepare(
    `SELECT id, line_no AS lineNo, raw_text AS rawText, product_id AS productId,
            product_sku_snapshot AS productSku, product_name_snapshot AS productName,
            unit_id AS unitId, unit_name_snapshot AS unitName, quantity,
            unit_price_pesewas AS unitPricePesewas, confidence, review_note AS reviewNote
       FROM paper_receipt_import_lines
      WHERE import_id = ?
      ORDER BY line_no ASC`,
  ).all(draftId) as PaperReceiptLineDraft[];
}

function summaryFromDetailRow(
  row: {
    id: string; status: ImportStatus; createdAt: string; workerName: string;
    channel: SaleChannel; paymentMethod: PaymentMethod; postedSaleId: string | null;
    tillOpenedAt: string | null; tillOpenedByName: string | null;
  },
  lines: PaperReceiptLineDraft[],
): PaperReceiptSummary {
  const matched = lines.filter((l) => l.productId && l.quantity != null && l.unitPricePesewas != null);
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    workerName: row.workerName,
    channel: row.channel,
    paymentMethod: row.paymentMethod,
    lineCount: lines.length,
    matchedLineCount: matched.length,
    totalPesewas: lines.reduce((sum, l) => sum + ((l.quantity ?? 0) * (l.unitPricePesewas ?? 0)), 0),
    postedSaleId: row.postedSaleId,
    tillOpenedAt: row.tillOpenedAt,
    tillOpenedByName: row.tillOpenedByName,
  };
}

function validatePaymentFields(method: PaymentMethod, reference: string | null, cashGivenPesewas: number | null): void {
  if (method.startsWith('MOMO_') && !reference?.trim()) {
    throw new Error('MoMo payment requires a transaction reference');
  }
  if (cashGivenPesewas != null && (!Number.isInteger(cashGivenPesewas) || cashGivenPesewas < 0)) {
    throw new Error('cash given must be a non-negative integer');
  }
}

function findProduct(normalizedLine: string, products: ProductForMatch[]): ProductForMatch | null {
  let best: { product: ProductForMatch; score: number } | null = null;
  for (const product of products) {
    const sku = normalize(product.sku);
    const name = normalize(product.name);
    let score = 0;
    if (normalizedLine.includes(sku)) score = 100 + sku.length;
    else if (normalizedLine.includes(name)) score = 80 + name.length;
    else {
      const words = name.split(' ').filter((w) => w.length >= 3);
      const hits = words.filter((w) => normalizedLine.includes(w)).length;
      if (hits > 0) score = 40 + hits * 10;
    }
    if (score > 0 && (!best || score > best.score)) best = { product, score };
  }
  return best?.product ?? null;
}

function findUnitInLine(db: DB, productId: string, normalizedLine: string): ReturnType<typeof defaultSaleUnit> {
  const units = db.prepare(
    `SELECT id, product_id AS productId, unit_name AS unitName,
            conversion_factor AS conversionFactor, price_pesewas AS pricePesewas,
            is_purchase_unit AS isPurchaseUnit, is_sale_unit AS isSaleUnit,
            display_order AS displayOrder, active, notes
       FROM product_units
      WHERE product_id = ? AND active = 1 AND is_sale_unit = 1`,
  ).all(productId) as Array<{
    id: string; productId: string; unitName: string; conversionFactor: number;
    pricePesewas: number; isPurchaseUnit: number; isSaleUnit: number;
    displayOrder: number; active: number; notes: string | null;
  }>;
  const found = units.find((u) => normalizedLine.includes(normalize(u.unitName)));
  if (!found) return null;
  return {
    ...found,
    isPurchaseUnit: found.isPurchaseUnit === 1,
    isSaleUnit: found.isSaleUnit === 1,
    active: found.active === 1,
  };
}

function extractQuantity(raw: string): number | null {
  const m = raw.match(/(?:^|\s)(?:x\s*)?(\d{1,4})(?=\s|$)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function extractLastMoney(raw: string, qty: number | null): number | null {
  const matches = [...raw.matchAll(/(?:^|\s)(GHS|GH¢|₵)?\s*(\d{1,6}(?:[,.]\d{1,2})?)(?=\s|$)/gi)];
  if (matches.length === 0) return null;
  const last = matches[matches.length - 1]!;
  const value = last[2]!.replace(',', '.');
  const hasCurrency = Boolean(last[1]);
  const hasDecimal = /[,.]/.test(value);
  if (matches.length === 1 && !hasCurrency && !hasDecimal && qty != null && Number(value) === qty) {
    return null;
  }
  const [whole, dec = ''] = value.split('.');
  const pesewas = Number(whole) * 100 + Number((dec + '00').slice(0, 2));
  return Number.isInteger(pesewas) && pesewas >= 0 ? pesewas : null;
}

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

async function recognizePaperReceiptImage(
  imagePath: string,
): Promise<{ rawText: string; lines: OcrReceiptLine[] | null; provider: string }> {
  const command = process.env['COUNTER_OCR_COMMAND']?.trim();
  if (command) {
    const args = localOcrArgsForImage(imagePath);
    const stdout = await runOcrCommand(command, args, imagePath, true);
    return parseLocalOcrOutput(stdout, `local:${commandName(command)}`);
  }

  const tesseractBin = process.env['TESSERACT_BIN']?.trim() || 'tesseract';
  const stdout = await runOcrCommand(tesseractBin, [imagePath, 'stdout', '--psm', '6'], imagePath, false);
  if (!stdout.trim()) return { rawText: '', lines: null, provider: 'none' };
  return parseLocalOcrOutput(stdout, 'local:tesseract');
}

function localOcrArgsForImage(imagePath: string): string[] {
  const template = process.env['COUNTER_OCR_COMMAND_ARGS']?.trim();
  if (!template) return [imagePath];
  const parts = splitCommandArgs(template);
  const hasImageToken = parts.some((part) => part.includes('{image}'));
  const args = parts.map((part) => part.replace(/\{image\}/g, imagePath));
  return hasImageToken ? args : [...args, imagePath];
}

async function runOcrCommand(
  command: string,
  args: string[],
  imagePath: string,
  required: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      env: { ...process.env, COUNTER_RECEIPT_IMAGE: imagePath },
      timeout: ocrCommandTimeoutMs(),
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        if (!required) {
          resolve('');
          return;
        }
        const childError = error as Error & { killed?: boolean; signal?: string | null };
        const detail = String(stderr || error.message || '').trim();
        reject(new Error(`paper receipt OCR command failed: ${summarizeOcrFailure(detail || command, childError)}`));
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

function ocrCommandTimeoutMs(): number {
  const raw = Number(process.env['COUNTER_OCR_TIMEOUT_MS']);
  return Number.isInteger(raw) && raw >= 5_000 ? raw : 120_000;
}

function summarizeOcrFailure(
  detail: string,
  error?: { killed?: boolean; signal?: string | null },
): string {
  if (error?.killed || error?.signal === 'SIGTERM') {
    return `the local OCR model took too long to answer. Try again, or set COUNTER_OCR_TIMEOUT_MS higher than ${ocrCommandTimeoutMs()}.`;
  }
  if (/exceed(?:s|ed)?(?:_| )context(?:_| )size|available context size|n_ctx/i.test(detail)) {
    return 'the receipt photo was too large for the local model. Try a closer crop, or increase COUNTER_OLLAMA_NUM_CTX.';
  }
  if (/ECONNREFUSED|fetch failed|connection refused/i.test(detail)) {
    return 'the local Ollama model server is not running.';
  }
  return detail.length > 220 ? `${detail.slice(0, 217)}...` : detail;
}

function parseLocalOcrOutput(
  stdout: string,
  provider: string,
): { rawText: string; lines: OcrReceiptLine[] | null; provider: string } {
  const text = stdout.trim();
  if (!text) return { rawText: '', lines: null, provider };
  try {
    const parsed = JSON.parse(text) as { rawText?: unknown; lines?: unknown };
    const rawText = typeof parsed.rawText === 'string' ? parsed.rawText : '';
    const lines = Array.isArray(parsed.lines)
      ? parsed.lines.map(normalizeOcrLine).filter((line): line is OcrReceiptLine => line !== null)
      : null;
    return { rawText, lines, provider };
  } catch {
    return { rawText: text, lines: null, provider: `${provider}:text` };
  }
}

function splitCommandArgs(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (const ch of raw) {
    if ((ch === '"' || ch === "'") && !quote) {
      quote = ch;
      continue;
    }
    if (quote === ch) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (current) args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

function commandName(command: string): string {
  const parts = command.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || command;
}

function normalizeOcrLine(raw: unknown): OcrReceiptLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const rawText = typeof row.rawText === 'string' ? row.rawText.trim() : '';
  const productText = typeof row.productText === 'string' ? row.productText.trim() : rawText;
  if (!rawText && !productText) return null;
  const unitText = typeof row.unitText === 'string' && row.unitText.trim() ? row.unitText.trim() : null;
  const quantity = typeof row.quantity === 'number' && Number.isInteger(row.quantity) && row.quantity > 0 ? row.quantity : null;
  const unitPricePesewas = typeof row.unitPricePesewas === 'number' && Number.isInteger(row.unitPricePesewas) && row.unitPricePesewas >= 0
    ? row.unitPricePesewas
    : null;
  const confidence = typeof row.confidence === 'number' && Number.isFinite(row.confidence)
    ? Math.max(0, Math.min(100, Math.round(row.confidence)))
    : 0;
  return { rawText, productText, unitText, quantity, unitPricePesewas, confidence };
}
