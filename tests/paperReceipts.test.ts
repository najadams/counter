import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import { openShift } from '../src/main/services/shifts';
import {
  createPaperReceiptDraft,
  discardPaperReceiptDraft,
  getPaperReceiptDraft,
  listPaperReceiptDrafts,
  markPaperReceiptDraftPostedFromTill,
  openPaperReceiptDraftAtTill,
  postPaperReceiptDraft,
  resolvePaperReceiptDraftForCart,
} from '../src/main/services/paperReceipts';
import { completeSale } from '../src/main/services/sales';
import { _resetPrinter, _setPrinter } from '../src/main/printer/printer';

const __filename = fileURLToPath(import.meta.url);
const migrationsDir = path.resolve(path.dirname(__filename), '../migrations');

let db: ReturnType<typeof Database>;
let tmpDir: string;
let shiftId: string;

const W = 'dev-counter-1';
const L = 'loc-main-counter';
const D = 'test-device';

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-paper-receipts-'));
  const products = db.prepare('SELECT id, cost_price_pesewas FROM products').all() as Array<{ id: string; cost_price_pesewas: number }>;
  for (const p of products) {
    db.prepare(
      `INSERT INTO stock_movements (id, product_id, location_id, quantity, reason_code,
         worker_id, unit_cost_pesewas, total_value_pesewas, supervisor_approval_id,
         created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, 'RECEIVED_FROM_SUPPLIER', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`sm-paper-${p.id}`, p.id, L, 24, W, p.cost_price_pesewas, 24 * p.cost_price_pesewas, W, W, W, D);
  }
  shiftId = openShift(db, { workerId: W, locationId: L, shiftType: 'COUNTER', openingCashPesewas: 5000, deviceId: D }).shiftId;
  _setPrinter({ async print() { return { ok: true } as const; } });
});

afterEach(() => {
  delete process.env.COUNTER_OCR_COMMAND;
  delete process.env.COUNTER_OCR_COMMAND_ARGS;
  _resetPrinter();
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('paper receipt imports', () => {
  it('creates a photo-backed draft and parses known products', async () => {
    const r = await createPaperReceiptDraft(db, {
      shiftId,
      workerId: W,
      locationId: L,
      photoBytes: Buffer.from('fake image bytes'),
      photoExtension: 'jpg',
      userDataDir: tmpDir,
      ocrText: '2 STAR-330 9.00\n1 VOLTIC-1L 5.00',
      channel: 'WALK_IN',
      paymentMethod: 'CASH',
      deviceId: D,
    });
    const draft = getPaperReceiptDraft(db, r.draftId, tmpDir);
    expect(draft.photoDataUri).toMatch(/^data:image\/jpeg;base64,/);
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines[0]?.productSku).toBe('STAR-330');
    expect(draft.lines[0]?.quantity).toBe(2);
    expect(draft.lines[0]?.unitPricePesewas).toBe(900);
    expect(draft.totalPesewas).toBe(2300);
  });

  it('does not treat a lone quantity as a price', async () => {
    const r = await createPaperReceiptDraft(db, {
      shiftId,
      workerId: W,
      locationId: L,
      photoBytes: Buffer.from('fake image bytes'),
      photoExtension: 'jpg',
      userDataDir: tmpDir,
      ocrText: '2 STAR-330',
      channel: 'WALK_IN',
      paymentMethod: 'CASH',
      deviceId: D,
    });
    const draft = getPaperReceiptDraft(db, r.draftId, tmpDir);
    expect(draft.lines[0]?.quantity).toBe(2);
    expect(draft.lines[0]?.unitPricePesewas).toBe(800);
  });

  it('can create suggestions from a local OCR command', async () => {
    const ocrScript = path.join(tmpDir, 'receipt-ocr.cjs');
    fs.writeFileSync(ocrScript, `
      process.stdout.write(JSON.stringify({
        rawText: '2 STAR-330 8.00',
        lines: [{
          rawText: '2 STAR-330 8.00',
          productText: 'STAR-330',
          unitText: null,
          quantity: 2,
          unitPricePesewas: 800,
          confidence: 92
        }]
      }));
    `);
    process.env.COUNTER_OCR_COMMAND = process.execPath;
    process.env.COUNTER_OCR_COMMAND_ARGS = `"${ocrScript}" {image}`;

    const r = await createPaperReceiptDraft(db, {
      shiftId,
      workerId: W,
      locationId: L,
      photoBytes: Buffer.from('fake image bytes'),
      photoExtension: 'jpg',
      userDataDir: tmpDir,
      ocrText: '',
      channel: 'WALK_IN',
      paymentMethod: 'CASH',
      deviceId: D,
    });
    const draft = getPaperReceiptDraft(db, r.draftId, tmpDir);
    expect(draft.ocrText).toBe('2 STAR-330 8.00');
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]?.productSku).toBe('STAR-330');
    expect(draft.lines[0]?.quantity).toBe(2);
    expect(draft.lines[0]?.unitPricePesewas).toBe(800);
    expect(draft.lines[0]?.confidence).toBeGreaterThan(90);
  });

  it('fills quantity and default unit from OCR raw handwritten row format', async () => {
    const ocrScript = path.join(tmpDir, 'receipt-ocr-raw-format.cjs');
    fs.writeFileSync(ocrScript, `
      process.stdout.write(JSON.stringify({
        rawText: '4 STAR-330',
        lines: [{
          rawText: '4 STAR-330',
          productText: 'STAR-330',
          unitText: null,
          quantity: null,
          unitPricePesewas: null,
          confidence: 68
        }]
      }));
    `);
    process.env.COUNTER_OCR_COMMAND = process.execPath;
    process.env.COUNTER_OCR_COMMAND_ARGS = `"${ocrScript}" {image}`;

    const r = await createPaperReceiptDraft(db, {
      shiftId,
      workerId: W,
      locationId: L,
      photoBytes: Buffer.from('fake image bytes'),
      photoExtension: 'jpg',
      userDataDir: tmpDir,
      ocrText: '',
      channel: 'WALK_IN',
      paymentMethod: 'CASH',
      deviceId: D,
    });
    const draft = getPaperReceiptDraft(db, r.draftId, tmpDir);
    expect(draft.lines[0]?.productSku).toBe('STAR-330');
    expect(draft.lines[0]?.quantity).toBe(4);
    expect(draft.lines[0]?.unitName).toBe('UNIT');
    expect(draft.lines[0]?.unitPricePesewas).toBe(800);
    expect(draft.totalPesewas).toBe(3200);

    const cart = resolvePaperReceiptDraftForCart(db, r.draftId, L);
    expect(cart.channel).toBe('WALK_IN');
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]).toMatchObject({
      productId: draft.lines[0]?.productId,
      sku: 'STAR-330',
      name: 'Star Beer 330ml',
      unitName: 'UNIT',
      factor: 1,
      unitPricePesewas: 800,
      quantity: 4,
    });
  });

  it('posts a reviewed draft through the normal sale path', async () => {
    const r = await createPaperReceiptDraft(db, {
      shiftId,
      workerId: W,
      locationId: L,
      photoBytes: Buffer.from('fake image bytes'),
      photoExtension: 'jpg',
      userDataDir: tmpDir,
      ocrText: '2 STAR-330 8.00',
      channel: 'WALK_IN',
      paymentMethod: 'CASH',
      cashGivenPesewas: 1600,
      deviceId: D,
    });
    const posted = await postPaperReceiptDraft(db, {
      draftId: r.draftId,
      workerId: W,
      workerName: 'Counter Worker',
      shopName: 'TEST',
      deviceId: D,
    });
    expect(posted.saleId).toMatch(/^sa-/);
    expect(posted.totalPesewas).toBe(1600);
    const draft = db.prepare('SELECT status, posted_sale_id FROM paper_receipt_imports WHERE id = ?').get(r.draftId) as
      { status: string; posted_sale_id: string };
    expect(draft.status).toBe('POSTED');
    expect(draft.posted_sale_id).toBe(posted.saleId);
    const auditActions = db.prepare('SELECT action FROM audit_log WHERE entity_id = ? ORDER BY created_at').all(r.draftId)
      .map((row) => (row as { action: string }).action);
    expect(auditActions).toContain('PAPER_RECEIPT_IMPORTED');
    expect(auditActions).toContain('PAPER_RECEIPT_POSTED');
  });

  it('tracks receipts opened at till and marks them posted after checkout', async () => {
    const r = await createPaperReceiptDraft(db, {
      shiftId,
      workerId: W,
      locationId: L,
      photoBytes: Buffer.from('fake image bytes'),
      photoExtension: 'jpg',
      userDataDir: tmpDir,
      ocrText: '2 STAR-330 8.00',
      channel: 'WALK_IN',
      paymentMethod: 'CASH',
      deviceId: D,
    });

    const cart = openPaperReceiptDraftAtTill(db, r.draftId, L, W, D);
    expect(cart.lines).toHaveLength(1);
    const opened = getPaperReceiptDraft(db, r.draftId, tmpDir);
    expect(opened.status).toBe('REVIEW');
    expect(opened.tillOpenedAt).toBeTruthy();
    expect(opened.tillOpenedByName).toBe('Dev Counter');

    const sale = await completeSale(db, {
      shiftId,
      workerId: W,
      workerName: 'Dev Counter',
      locationId: L,
      channel: cart.channel,
      lines: cart.lines.map((line) => ({
        productId: line.productId,
        unitId: line.unitId,
        quantity: line.quantity,
        unitPricePesewas: line.unitPricePesewas,
      })),
      paymentMethod: 'CASH',
      cashGivenPesewas: 1600,
      deviceId: D,
      shopName: 'TEST',
    });
    markPaperReceiptDraftPostedFromTill(db, r.draftId, sale.saleId, W, D);

    const posted = getPaperReceiptDraft(db, r.draftId, tmpDir);
    expect(posted.status).toBe('POSTED');
    expect(posted.postedSaleId).toBe(sale.saleId);
    expect(posted.tillOpenedAt).toBe(opened.tillOpenedAt);
    const auditActions = db.prepare('SELECT action FROM audit_log WHERE entity_id = ? ORDER BY created_at').all(r.draftId)
      .map((row) => (row as { action: string }).action);
    expect(auditActions).toContain('PAPER_RECEIPT_OPENED_AT_TILL');
    expect(auditActions).toContain('PAPER_RECEIPT_POSTED_FROM_TILL');
  });

  it('clears completed receipts from the queue after 24 hours', async () => {
    const now = new Date('2026-07-17T10:00:00.000Z');
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const recent = new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString();

    const oldPosted = await createPaperReceiptDraft(db, {
      shiftId,
      workerId: W,
      locationId: L,
      photoBytes: Buffer.from('fake image bytes'),
      photoExtension: 'jpg',
      userDataDir: tmpDir,
      ocrText: '1 STAR-330 8.00',
      channel: 'WALK_IN',
      paymentMethod: 'CASH',
      cashGivenPesewas: 800,
      deviceId: D,
    });
    await postPaperReceiptDraft(db, {
      draftId: oldPosted.draftId,
      workerId: W,
      workerName: 'Dev Counter',
      shopName: 'TEST',
      deviceId: D,
    });
    db.prepare('UPDATE paper_receipt_imports SET updated_at = ?, created_at = ? WHERE id = ?').run(old, old, oldPosted.draftId);

    const recentDiscarded = await createPaperReceiptDraft(db, {
      shiftId,
      workerId: W,
      locationId: L,
      photoBytes: Buffer.from('fake image bytes'),
      photoExtension: 'jpg',
      userDataDir: tmpDir,
      ocrText: '1 STAR-330 8.00',
      channel: 'WALK_IN',
      paymentMethod: 'CASH',
      deviceId: D,
    });
    discardPaperReceiptDraft(db, recentDiscarded.draftId, 'duplicate', W, D);
    db.prepare('UPDATE paper_receipt_imports SET updated_at = ?, created_at = ? WHERE id = ?').run(recent, recent, recentDiscarded.draftId);

    const oldReview = await createPaperReceiptDraft(db, {
      shiftId,
      workerId: W,
      locationId: L,
      photoBytes: Buffer.from('fake image bytes'),
      photoExtension: 'jpg',
      userDataDir: tmpDir,
      ocrText: '1 STAR-330 8.00',
      channel: 'WALK_IN',
      paymentMethod: 'CASH',
      deviceId: D,
    });
    db.prepare('UPDATE paper_receipt_imports SET updated_at = ?, created_at = ? WHERE id = ?').run(old, old, oldReview.draftId);

    const visibleIds = listPaperReceiptDrafts(db, 50, now).map((draft) => draft.id);
    expect(visibleIds).not.toContain(oldPosted.draftId);
    expect(visibleIds).toContain(recentDiscarded.draftId);
    expect(visibleIds).toContain(oldReview.draftId);
  });
});
