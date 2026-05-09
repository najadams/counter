// customerPriceOverrides.ts — Wave C.2 per-customer hand-shaken pricing.
//
// At sale time, when a customer is attached, the line price lookup checks
// this table FIRST. Channel-specific override beats channel-NULL override
// for the same customer/product/unit. If neither matches, falls through to
// tier pricing and then to the unit's default price.
//
// The price stored here is per-display-unit (in pesewas), matching how
// product_units.price_pesewas is stored. Conversion to canonical happens
// at the call site if needed.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';

type DB = Database;

export type SaleChannel = 'WALK_IN' | 'WHOLESALE' | 'ROUTE';

export interface CustomerPriceOverrideRow {
  id: string;
  customerId: string;
  productId: string;
  productName: string;
  appliesToUnitId: string;
  unitName: string;
  channel: SaleChannel | null;
  pricePesewas: number;
  active: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Find the best matching override for a sale line. Returns price in pesewas
 *  per display unit, or null if no override applies. Channel-specific wins
 *  over channel-NULL for the same customer/product/unit. */
export function findBestOverride(
  db: DB,
  customerId: string,
  productId: string,
  unitId: string,
  channel: SaleChannel,
): { id: string; pricePesewas: number } | null {
  // Channel-specific match.
  const exact = db
    .prepare(
      `SELECT id, price_pesewas AS pricePesewas
         FROM customer_price_overrides
        WHERE customer_id = ? AND product_id = ? AND applies_to_unit_id = ?
          AND channel = ? AND active = 1
        LIMIT 1`,
    )
    .get(customerId, productId, unitId, channel) as
    | { id: string; pricePesewas: number }
    | undefined;
  if (exact) return exact;

  // Channel-null fallback.
  const any = db
    .prepare(
      `SELECT id, price_pesewas AS pricePesewas
         FROM customer_price_overrides
        WHERE customer_id = ? AND product_id = ? AND applies_to_unit_id = ?
          AND channel IS NULL AND active = 1
        LIMIT 1`,
    )
    .get(customerId, productId, unitId) as
    | { id: string; pricePesewas: number }
    | undefined;
  return any ?? null;
}

/** List active overrides for a customer (admin UI). */
export function listOverridesForCustomer(
  db: DB,
  customerId: string,
): CustomerPriceOverrideRow[] {
  return db
    .prepare(
      `SELECT cpo.id, cpo.customer_id AS customerId,
              cpo.product_id AS productId, p.name AS productName,
              cpo.applies_to_unit_id AS appliesToUnitId,
              pu.unit_name AS unitName,
              cpo.channel, cpo.price_pesewas AS pricePesewas,
              cpo.active, cpo.notes,
              cpo.created_at AS createdAt, cpo.updated_at AS updatedAt
         FROM customer_price_overrides cpo
         JOIN products p ON p.id = cpo.product_id
         JOIN product_units pu ON pu.id = cpo.applies_to_unit_id
        WHERE cpo.customer_id = ? AND cpo.active = 1
        ORDER BY p.name ASC, pu.unit_name ASC`,
    )
    .all(customerId)
    .map((r: any) => ({ ...r, active: !!r.active })) as CustomerPriceOverrideRow[];
}

export interface AddOverrideInput {
  customerId: string;
  productId: string;
  appliesToUnitId: string;
  channel: SaleChannel | null;
  pricePesewas: number;
  notes?: string | null;
  workerId: string;
  deviceId: string;
}

export function addOverride(db: DB, input: AddOverrideInput): { id: string } {
  if (!Number.isInteger(input.pricePesewas) || input.pricePesewas <= 0) {
    throw new Error('addOverride: pricePesewas must be a positive integer');
  }
  // Honour the partial unique index — guard against races above SQLite by
  // checking first; the index will still catch any concurrent insert.
  const existing = db
    .prepare(
      `SELECT id FROM customer_price_overrides
        WHERE customer_id = ? AND product_id = ? AND applies_to_unit_id = ?
          AND COALESCE(channel, '') = COALESCE(?, '') AND active = 1`,
    )
    .get(
      input.customerId, input.productId, input.appliesToUnitId, input.channel,
    ) as { id: string } | undefined;
  if (existing) {
    throw new Error('An active override already exists for this customer/product/unit/channel.');
  }

  const id = `cpo-${uuidv4()}`;
  db.prepare(
    `INSERT INTO customer_price_overrides
       (id, customer_id, product_id, applies_to_unit_id, channel, price_pesewas,
        active, notes, created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    id, input.customerId, input.productId, input.appliesToUnitId,
    input.channel, input.pricePesewas, input.notes ?? null,
    input.workerId, input.workerId, input.deviceId,
  );
  return { id };
}

export interface UpdateOverrideInput {
  id: string;
  pricePesewas?: number;
  notes?: string | null;
  workerId: string;
  deviceId: string;
}

export function updateOverride(db: DB, input: UpdateOverrideInput): void {
  const fields: string[] = [];
  const args: unknown[] = [];
  if (input.pricePesewas !== undefined) {
    if (!Number.isInteger(input.pricePesewas) || input.pricePesewas <= 0) {
      throw new Error('updateOverride: pricePesewas must be a positive integer');
    }
    fields.push('price_pesewas = ?');
    args.push(input.pricePesewas);
  }
  if (input.notes !== undefined) {
    fields.push('notes = ?');
    args.push(input.notes);
  }
  if (fields.length === 0) return;
  fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
  fields.push('updated_by = ?');
  args.push(input.workerId);
  args.push(input.id);
  const r = db.prepare(
    `UPDATE customer_price_overrides SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...args);
  if (r.changes === 0) throw new Error(`updateOverride: ${input.id} not found`);
}

export function deactivateOverride(
  db: DB, id: string, workerId: string,
): void {
  const r = db.prepare(
    `UPDATE customer_price_overrides
        SET active = 0,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_by = ?
      WHERE id = ? AND active = 1`,
  ).run(workerId, id);
  if (r.changes === 0) {
    throw new Error(`deactivateOverride: ${id} not found or already inactive`);
  }
}
