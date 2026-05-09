// Suppliers admin: create, update, deactivate, reactivate.
// Required for day-one operation since stock receipts need a supplier_id.
// OWNER + FOUNDER only.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { normalizePhone } from '../../shared/lib/phone.js';

const ADMIN_ROLES = new Set(['OWNER', 'FOUNDER']);

function requireAdmin(db: DB, actorId: string): void {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor worker not found or inactive');
  }
  if (!ADMIN_ROLES.has(w.role)) {
    throw new Error(`actor role ${w.role} not permitted (need OWNER or FOUNDER)`);
  }
}

export interface AdminSupplier {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  paymentTermsDays: number;
  currentBalancePesewas: number;
  notes: string | null;
  active: boolean;
}

export function listSuppliersForAdmin(db: DB): AdminSupplier[] {
  const rows = db
    .prepare(
      `SELECT id, name, contact_person AS contactPerson, phone, email,
              payment_terms_days AS paymentTermsDays,
              current_balance_pesewas AS currentBalancePesewas,
              notes, active
         FROM suppliers
         WHERE deleted_at IS NULL
         ORDER BY active DESC, name ASC`,
    )
    .all() as Array<Omit<AdminSupplier, 'active'> & { active: number }>;
  return rows.map((r) => ({ ...r, active: r.active === 1 }));
}

export interface AddSupplierInput {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  paymentTermsDays?: number;
  notes?: string | null;
  actorWorkerId: string;
  deviceId: string;
}

export function addSupplier(db: DB, input: AddSupplierInput): { supplierId: string } {
  requireAdmin(db, input.actorWorkerId);
  if (!input.name.trim()) throw new Error('name required');

  let phone: string | null = null;
  if (input.phone && input.phone.trim()) {
    phone = normalizePhone(input.phone);
    if (!phone) throw new Error(`invalid phone '${input.phone}'`);
  }

  const id = `sup-${uuidv4()}`;
  db.prepare(
    `INSERT INTO suppliers (
      id, name, contact_person, phone, email,
      payment_terms_days, current_balance_pesewas, notes, active,
      created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?)`,
  ).run(
    id,
    input.name.trim(),
    input.contactPerson?.trim() || null,
    phone,
    input.email?.trim() || null,
    input.paymentTermsDays ?? 0,
    input.notes?.trim() || null,
    input.actorWorkerId,
    input.actorWorkerId,
    input.deviceId,
  );

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'SUPPLIER_ADDED',
    entityType: 'suppliers',
    entityId: id,
    afterValue: { name: input.name.trim(), phone, paymentTermsDays: input.paymentTermsDays ?? 0 },
    deviceId: input.deviceId,
  });

  return { supplierId: id };
}

export interface UpdateSupplierInput {
  supplierId: string;
  fields: Partial<{
    name: string;
    contactPerson: string | null;
    phone: string | null;
    email: string | null;
    paymentTermsDays: number;
    notes: string | null;
  }>;
  actorWorkerId: string;
  deviceId: string;
}

export function updateSupplier(db: DB, input: UpdateSupplierInput): void {
  requireAdmin(db, input.actorWorkerId);
  const before = db
    .prepare(
      `SELECT id, name, contact_person AS contactPerson, phone, email,
              payment_terms_days AS paymentTermsDays, notes
         FROM suppliers WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(input.supplierId) as Record<string, unknown> | undefined;
  if (!before) throw new Error(`supplier ${input.supplierId} not found`);

  const f = input.fields;
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (f.name !== undefined) {
    if (!f.name.trim()) throw new Error('name cannot be empty');
    sets.push('name = ?');
    vals.push(f.name.trim());
  }
  if (f.contactPerson !== undefined) {
    sets.push('contact_person = ?');
    vals.push(f.contactPerson?.trim() || null);
  }
  if (f.phone !== undefined) {
    let p: string | null = null;
    if (f.phone && f.phone.trim()) {
      p = normalizePhone(f.phone);
      if (!p) throw new Error(`invalid phone '${f.phone}'`);
    }
    sets.push('phone = ?');
    vals.push(p);
  }
  if (f.email !== undefined) {
    sets.push('email = ?');
    vals.push(f.email?.trim() || null);
  }
  if (f.paymentTermsDays !== undefined) {
    if (!Number.isInteger(f.paymentTermsDays) || f.paymentTermsDays < 0) {
      throw new Error('paymentTermsDays must be a non-negative integer');
    }
    sets.push('payment_terms_days = ?');
    vals.push(f.paymentTermsDays);
  }
  if (f.notes !== undefined) {
    sets.push('notes = ?');
    vals.push(f.notes?.trim() || null);
  }

  if (sets.length === 0) return;

  sets.push('updated_at = ?', 'updated_by = ?');
  vals.push(new Date().toISOString(), input.actorWorkerId);
  vals.push(input.supplierId);

  db.prepare(`UPDATE suppliers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'SUPPLIER_UPDATED',
    entityType: 'suppliers',
    entityId: input.supplierId,
    beforeValue: before,
    afterValue: input.fields,
    deviceId: input.deviceId,
  });
}

export function deactivateSupplier(
  db: DB,
  supplierId: string,
  actorWorkerId: string,
  deviceId: string,
): void {
  requireAdmin(db, actorWorkerId);
  const s = db
    .prepare('SELECT id, active FROM suppliers WHERE id = ? AND deleted_at IS NULL')
    .get(supplierId) as { id: string; active: number } | undefined;
  if (!s) throw new Error(`supplier ${supplierId} not found`);
  if (s.active === 0) throw new Error('already inactive');

  db.prepare(
    'UPDATE suppliers SET active = 0, updated_at = ?, updated_by = ? WHERE id = ?',
  ).run(new Date().toISOString(), actorWorkerId, supplierId);

  logAudit(db, {
    workerId: actorWorkerId,
    action: 'SUPPLIER_DEACTIVATED',
    entityType: 'suppliers',
    entityId: supplierId,
    deviceId,
  });
}

export function reactivateSupplier(
  db: DB,
  supplierId: string,
  actorWorkerId: string,
  deviceId: string,
): void {
  requireAdmin(db, actorWorkerId);
  const s = db
    .prepare('SELECT id, active FROM suppliers WHERE id = ? AND deleted_at IS NULL')
    .get(supplierId) as { id: string; active: number } | undefined;
  if (!s) throw new Error(`supplier ${supplierId} not found`);
  if (s.active === 1) throw new Error('already active');

  db.prepare(
    'UPDATE suppliers SET active = 1, updated_at = ?, updated_by = ? WHERE id = ?',
  ).run(new Date().toISOString(), actorWorkerId, supplierId);

  logAudit(db, {
    workerId: actorWorkerId,
    action: 'SUPPLIER_REACTIVATED',
    entityType: 'suppliers',
    entityId: supplierId,
    deviceId,
  });
}
