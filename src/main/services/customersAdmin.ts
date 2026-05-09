// Customers administration. Counter staff can create + edit; only
// SUPERVISOR/OWNER/FOUNDER can block/unblock credit.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../db/audit.js';
import { normalizePhone } from '../../shared/lib/phone.js';

const SUPERVISOR_ROLES = new Set(['SUPERVISOR', 'OWNER', 'FOUNDER']);

const VALID_TYPES = new Set(['WALK_IN_REGULAR', 'WHOLESALE', 'ROUTE', 'STAFF_FAMILY']);

function requireSupervisor(db: DB, actorId: string): void {
  const w = db
    .prepare('SELECT role, active, deleted_at, terminated_at FROM workers WHERE id = ?')
    .get(actorId) as
    | { role: string; active: number; deleted_at: string | null; terminated_at: string | null }
    | undefined;
  if (!w || w.active !== 1 || w.deleted_at || w.terminated_at) {
    throw new Error('actor not active');
  }
  if (!SUPERVISOR_ROLES.has(w.role)) {
    throw new Error(`role ${w.role} not permitted (SUPERVISOR/OWNER/FOUNDER required)`);
  }
}

export interface CreateCustomerInput {
  displayName: string;
  phone: string;
  customerType?: 'WALK_IN_REGULAR' | 'WHOLESALE' | 'ROUTE' | 'STAFF_FAMILY';
  alternatePhone?: string | null;
  businessName?: string | null;
  locationDescription?: string | null;
  geoLat?: number | null;
  geoLng?: number | null;
  creditLimitPesewas?: number;
  creditTermsDays?: number;
  preferredChannel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
  notes?: string | null;
  actorWorkerId: string;
  deviceId: string;
}

export interface CreateCustomerResult {
  customerId: string;
  /** True if a customer with this phone already existed; we returned that one. */
  alreadyExisted: boolean;
}

/**
 * Create a customer. If one already exists at the same normalized phone,
 * return that existing customer's id with `alreadyExisted = true` rather
 * than failing — the sale flow can pick them up smoothly.
 */
export function createCustomer(
  db: DB, input: CreateCustomerInput,
): CreateCustomerResult {
  if (!input.displayName.trim()) throw new Error('displayName required');
  const phone = normalizePhone(input.phone);
  if (!phone) throw new Error(`invalid phone '${input.phone}'`);

  if (input.alternatePhone) {
    const altOk = normalizePhone(input.alternatePhone);
    if (!altOk) throw new Error(`invalid alternatePhone '${input.alternatePhone}'`);
  }
  const ctype = input.customerType ?? 'WALK_IN_REGULAR';
  if (!VALID_TYPES.has(ctype)) throw new Error(`invalid customerType '${ctype}'`);

  const credit = input.creditLimitPesewas ?? 0;
  if (!Number.isInteger(credit) || credit < 0) {
    throw new Error('creditLimitPesewas must be a non-negative integer');
  }
  const terms = input.creditTermsDays ?? 0;
  if (!Number.isInteger(terms) || terms < 0) {
    throw new Error('creditTermsDays must be a non-negative integer');
  }

  // Dedup on normalized phone.
  const existing = db
    .prepare('SELECT id FROM customers WHERE phone = ? AND deleted_at IS NULL')
    .get(phone) as { id: string } | undefined;
  if (existing) {
    return { customerId: existing.id, alreadyExisted: true };
  }

  const customerId = `cust-${uuidv4()}`;
  const altPhone = input.alternatePhone ? normalizePhone(input.alternatePhone) : null;

  db.prepare(
    `INSERT INTO customers (
      id, display_name, phone, alternate_phone, customer_type,
      business_name, location_description, geo_lat, geo_lng,
      credit_limit_pesewas, credit_terms_days, preferred_channel, notes,
      created_by, updated_by, device_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    customerId,
    input.displayName.trim(),
    phone,
    altPhone,
    ctype,
    input.businessName ?? null,
    input.locationDescription ?? null,
    input.geoLat ?? null,
    input.geoLng ?? null,
    credit,
    terms,
    input.preferredChannel ?? null,
    input.notes ?? null,
    input.actorWorkerId,
    input.actorWorkerId,
    input.deviceId,
  );

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'CUSTOMER_CREATED',
    entityType: 'customers',
    entityId: customerId,
    afterValue: { displayName: input.displayName, phone, customerType: ctype, creditLimitPesewas: credit },
    deviceId: input.deviceId,
  });

  return { customerId, alreadyExisted: false };
}

export interface UpdateCustomerInput {
  customerId: string;
  fields: Partial<{
    displayName: string;
    alternatePhone: string | null;
    customerType: 'WALK_IN_REGULAR' | 'WHOLESALE' | 'ROUTE' | 'STAFF_FAMILY';
    businessName: string | null;
    locationDescription: string | null;
    geoLat: number | null;
    geoLng: number | null;
    creditLimitPesewas: number;
    creditTermsDays: number;
    preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
    notes: string | null;
  }>;
  actorWorkerId: string;
  deviceId: string;
}

export function updateCustomer(db: DB, input: UpdateCustomerInput): void {
  const existing = db
    .prepare(
      `SELECT id, display_name, alternate_phone, customer_type, business_name,
              location_description, geo_lat, geo_lng, credit_limit_pesewas,
              credit_terms_days, preferred_channel, notes
         FROM customers WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(input.customerId) as Record<string, unknown> | undefined;
  if (!existing) throw new Error(`customer ${input.customerId} not found`);

  if (input.fields.customerType && !VALID_TYPES.has(input.fields.customerType)) {
    throw new Error(`invalid customerType '${input.fields.customerType}'`);
  }

  const colMap: Record<string, string> = {
    displayName: 'display_name', alternatePhone: 'alternate_phone',
    customerType: 'customer_type', businessName: 'business_name',
    locationDescription: 'location_description',
    geoLat: 'geo_lat', geoLng: 'geo_lng',
    creditLimitPesewas: 'credit_limit_pesewas',
    creditTermsDays: 'credit_terms_days',
    preferredChannel: 'preferred_channel',
    notes: 'notes',
  };
  const setParts: string[] = [];
  const params: unknown[] = [];
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(input.fields) as Array<[keyof typeof colMap, unknown]>) {
    const col = colMap[key];
    if (!col) continue;
    let value: unknown = raw;
    if (key === 'alternatePhone' && typeof value === 'string') {
      const norm = normalizePhone(value);
      if (!norm) throw new Error(`invalid alternatePhone '${value}'`);
      value = norm;
    }
    if (key === 'creditLimitPesewas' || key === 'creditTermsDays') {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        throw new Error(`${key} must be a non-negative integer`);
      }
    }
    if (key === 'preferredChannel' && value !== null && value !== undefined &&
        !['WALK_IN', 'WHOLESALE', 'ROUTE'].includes(value as string)) {
      throw new Error(`invalid preferredChannel '${value}'`);
    }
    setParts.push(`${col} = ?`);
    params.push(value);
    before[key] = existing[col];
    after[key] = value;
  }
  if (setParts.length === 0) return;

  setParts.push('updated_at = ?');
  setParts.push('updated_by = ?');
  params.push(new Date().toISOString());
  params.push(input.actorWorkerId);
  params.push(input.customerId);

  db.prepare(`UPDATE customers SET ${setParts.join(', ')} WHERE id = ?`).run(...params);

  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'CUSTOMER_UPDATED',
    entityType: 'customers',
    entityId: input.customerId,
    beforeValue: before,
    afterValue: after,
    deviceId: input.deviceId,
  });
}

export function blockCustomer(
  db: DB, customerId: string, reason: string, actorId: string, deviceId: string,
): void {
  requireSupervisor(db, actorId);
  if (!reason.trim()) throw new Error('block reason required');
  const c = db.prepare('SELECT blocked FROM customers WHERE id = ? AND deleted_at IS NULL').get(customerId) as { blocked: number } | undefined;
  if (!c) throw new Error(`customer ${customerId} not found`);
  if (c.blocked === 1) throw new Error('customer already blocked');
  db.prepare('UPDATE customers SET blocked = 1, blocked_reason = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(reason, new Date().toISOString(), actorId, customerId);
  logAudit(db, {
    workerId: actorId, action: 'CUSTOMER_BLOCKED',
    entityType: 'customers', entityId: customerId,
    afterValue: { reason }, deviceId,
  });
}

export function unblockCustomer(
  db: DB, customerId: string, actorId: string, deviceId: string,
): void {
  requireSupervisor(db, actorId);
  const c = db.prepare('SELECT blocked FROM customers WHERE id = ? AND deleted_at IS NULL').get(customerId) as { blocked: number } | undefined;
  if (!c) throw new Error(`customer ${customerId} not found`);
  if (c.blocked === 0) throw new Error('customer not blocked');
  db.prepare('UPDATE customers SET blocked = 0, blocked_reason = NULL, updated_at = ?, updated_by = ? WHERE id = ?').run(new Date().toISOString(), actorId, customerId);
  logAudit(db, {
    workerId: actorId, action: 'CUSTOMER_UNBLOCKED',
    entityType: 'customers', entityId: customerId, deviceId,
  });
}
