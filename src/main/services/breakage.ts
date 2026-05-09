// Breakage reporting. Invariant 8: every breakage row has a photo on disk,
// referenced by photo_url. The photo is saved BEFORE the row is inserted
// — the row CANNOT exist without the photo (DB-level NOT NULL + the
// service contract here).

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { insertStockMovement } from './stockMovements.js';
import { savePhoto, type PhotoKind } from '../db/photos.js';
import { assertNotSealed } from './periods.js';

export type BreakageCause =
  | 'DROPPED' | 'CUSTOMER_ACCIDENT' | 'TRANSPORT' | 'EXPIRED_LEAK' | 'UNKNOWN' | 'OTHER';

export interface ReportBreakageInput {
  shiftId: string;
  workerId: string;
  locationId: string;
  productId: string;
  quantity: number;
  cause: BreakageCause;
  causeDescription?: string | null;
  /** raw photo bytes — service writes them to disk first. */
  photoBytes: Buffer | Uint8Array;
  photoExtension: string;
  /** root for photos directory; main passes app.getPath('userData') */
  userDataDir: string;
  deductedFromWages?: boolean;
  supervisorApprovalId?: string | null;
  deviceId: string;
}

export interface ReportBreakageResult {
  breakageId: string;
  stockMovementId: string;
  photoRelativePath: string;
  photoBytes: number;
  totalLossPesewas: number;
}

/**
 * Report a breakage. Saves photo to disk, then in one transaction inserts:
 *   - stock_movements row (BREAKAGE, signed -qty, photoUrl set, references breakage_log_id)
 *   - breakage_log row (photo_url required by DB)
 *   - audit_log BREAKAGE_REPORTED
 */
export function reportBreakage(
  db: DB,
  input: ReportBreakageInput,
): ReportBreakageResult {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error(`reportBreakage: quantity must be a positive integer`);
  }
  // EXPIRED is its own reason (see reason_codes), but the breakage_log
  // schema supports the 6 causes above. Keep them aligned.

  // Day-lock guard: today's date at this location cannot be sealed when
  // reporting a new breakage.
  const todayISO = new Date().toISOString().slice(0, 10);
  assertNotSealed(db, input.locationId, todayISO, 'reporting a breakage');

  const product = db
    .prepare(
      `SELECT cost_price_pesewas, name
         FROM products WHERE id = ? AND active = 1 AND deleted_at IS NULL`,
    )
    .get(input.productId) as { cost_price_pesewas: number; name: string } | undefined;
  if (!product) throw new Error(`reportBreakage: product not found or inactive`);

  // Save photo BEFORE writing rows. If this throws, no row exists.
  const saved = savePhoto({
    bytes: input.photoBytes,
    extension: input.photoExtension,
    kind: 'breakage' as PhotoKind,
    userDataDir: input.userDataDir,
  });

  const breakageId = `br-${uuidv4()}`;
  const totalLoss = product.cost_price_pesewas * input.quantity;
  let stockMovementId = '';

  const tx = db.transaction(() => {
    // We want breakage_log.id known by stock_movements (breakage_log_id col)
    // — insert the stock_movement first with breakageLogId set, then the
    // breakage_log row pointing back via stock_movement_id.
    const sm = insertStockMovement(db, {
      productId: input.productId,
      locationId: input.locationId,
      quantity: input.quantity,
      reasonCode: 'BREAKAGE',
      shiftId: input.shiftId,
      workerId: input.workerId,
      breakageLogId: breakageId,
      unitCostPesewas: product.cost_price_pesewas,
      photoUrl: saved.relativePath,
      supervisorApprovalId: input.supervisorApprovalId ?? null,
      notes: input.causeDescription ?? null,
      deviceId: input.deviceId,
    });
    stockMovementId = sm.id;

    db.prepare(
      `INSERT INTO breakage_log (
        id, shift_id, location_id, worker_id, product_id, quantity,
        photo_url, cause, cause_description,
        deducted_from_wages, supervisor_approval_id, stock_movement_id,
        created_by, updated_by, device_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      breakageId,
      input.shiftId,
      input.locationId,
      input.workerId,
      input.productId,
      input.quantity,
      saved.relativePath,
      input.cause,
      input.causeDescription ?? null,
      input.deductedFromWages ? 1 : 0,
      input.supervisorApprovalId ?? null,
      sm.id,
      input.workerId,
      input.workerId,
      input.deviceId,
    );

    logAudit(db, {
      workerId: input.workerId,
      action: 'BREAKAGE_REPORTED',
      entityType: 'breakage_log',
      entityId: breakageId,
      afterValue: {
        productId: input.productId,
        productName: product.name,
        quantity: input.quantity,
        cause: input.cause,
        totalLossPesewas: totalLoss,
        photoBytes: saved.bytes,
        deductedFromWages: input.deductedFromWages ?? false,
      },
      deviceId: input.deviceId,
    });
  });

  tx();

  return {
    breakageId,
    stockMovementId,
    photoRelativePath: saved.relativePath,
    photoBytes: saved.bytes,
    totalLossPesewas: totalLoss,
  };
}

export interface BreakageRow {
  id: string;
  productName: string;
  productSku: string;
  quantity: number;
  cause: string;
  workerName: string;
  createdAt: string;
  photoRelativePath: string;
  totalLossPesewas: number;
}

export function listRecentBreakage(db: DB, limit = 25): BreakageRow[] {
  const rows = db
    .prepare(
      `SELECT b.id, b.quantity, b.cause, b.photo_url, b.created_at,
              p.name AS productName, p.sku AS productSku, p.cost_price_pesewas AS cost,
              w.full_name AS workerName
         FROM breakage_log b
         JOIN products p ON p.id = b.product_id
         JOIN workers w ON w.id = b.worker_id
         ORDER BY b.created_at DESC
         LIMIT ?`,
    )
    .all(limit) as Array<{
      id: string; quantity: number; cause: string; photo_url: string;
      created_at: string; productName: string; productSku: string;
      cost: number; workerName: string;
    }>;
  return rows.map((r) => ({
    id: r.id,
    productName: r.productName,
    productSku: r.productSku,
    quantity: r.quantity,
    cause: r.cause,
    workerName: r.workerName,
    createdAt: r.created_at,
    photoRelativePath: r.photo_url,
    totalLossPesewas: r.cost * r.quantity,
  }));
}

// --- Session 12: review surface ------------------------------------------

const REVIEWER_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

function requireReviewer(db: DB, actorId: string): void {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor worker not found or inactive');
  }
  if (!REVIEWER_ROLES.has(w.role)) {
    throw new Error(`breakage review is SUPERVISOR/OWNER/FOUNDER only — your role is ${w.role}`);
  }
}

export interface BreakageReviewFilters {
  workerId?: string | null;
  cause?: string | null;
  productId?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  limit?: number;
  offset?: number;
}

export interface BreakageReviewRow {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  quantity: number;
  cause: string;
  causeDescription: string | null;
  workerId: string;
  workerName: string;
  workerRole: string;
  photoRelativePath: string;
  totalLossPesewas: number;
  deductedFromWages: boolean;
  supervisorApprovalId: string | null;
  createdAt: string;
}

export function listBreakageForReview(
  db: DB,
  actorId: string,
  filters: BreakageReviewFilters,
): { rows: BreakageReviewRow[]; totalCount: number; totalLossPesewas: number } {
  requireReviewer(db, actorId);

  const where: string[] = [];
  const params: unknown[] = [];

  if (filters.workerId) { where.push('b.worker_id = ?'); params.push(filters.workerId); }
  if (filters.cause) { where.push('b.cause = ?'); params.push(filters.cause); }
  if (filters.productId) { where.push('b.product_id = ?'); params.push(filters.productId); }
  if (filters.fromDate) { where.push('b.created_at >= ?'); params.push(filters.fromDate); }
  if (filters.toDate) { where.push('b.created_at <= ?'); params.push(filters.toDate + 'T23:59:59.999Z'); }

  const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const summary = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(b.quantity * p.cost_price_pesewas), 0) AS loss
       FROM breakage_log b JOIN products p ON p.id = b.product_id ${wc}`,
  ).get(...params) as { n: number; loss: number };

  const limit = Math.min(Math.max(1, filters.limit ?? 50), 500);
  const offset = Math.max(0, filters.offset ?? 0);

  const rows = db.prepare(
    `SELECT b.id, b.product_id AS productId, p.name AS productName, p.sku AS productSku,
            b.quantity, b.cause, b.cause_description AS causeDescription,
            b.worker_id AS workerId, w.full_name AS workerName, w.role AS workerRole,
            b.photo_url AS photoRelativePath,
            (b.quantity * p.cost_price_pesewas) AS totalLossPesewas,
            b.deducted_from_wages AS deductedFromWages,
            b.supervisor_approval_id AS supervisorApprovalId,
            b.created_at AS createdAt
       FROM breakage_log b
       JOIN products p ON p.id = b.product_id
       JOIN workers w ON w.id = b.worker_id
       ${wc}
       ORDER BY b.created_at DESC
       LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as Array<BreakageReviewRow & { deductedFromWages: number }>;

  return {
    rows: rows.map((r) => ({ ...r, deductedFromWages: r.deductedFromWages === 1 })),
    totalCount: summary.n,
    totalLossPesewas: summary.loss,
  };
}

export function listBreakageDistinctCauses(db: DB, actorId: string): string[] {
  requireReviewer(db, actorId);
  const rows = db.prepare(`SELECT DISTINCT cause FROM breakage_log ORDER BY cause`).all() as Array<{ cause: string }>;
  return rows.map((r) => r.cause);
}
