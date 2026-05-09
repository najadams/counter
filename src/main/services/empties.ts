// empties.ts — Wave F empties / returnable container ledger.
//
// Two halves (single table, distinguished by `kind`):
//
//   Customer side
//   -------------
//   When a sale rings up a returnable product, the cashier flow can call
//   recordCustomerTakesFull() to bump customers.empties_owed_count and
//   write an audit row. When the customer brings empties back,
//   recordCustomerReturnsEmpty() decrements (clamped at 0) and optionally
//   refunds the deposit out of the till.
//
//   Depot side
//   -----------
//   When a supplier delivers full crates, recordDepotReceivesFull() logs
//   them. When we send empties back to the supplier,
//   recordDepotReturnsEmpty() logs that. The two together let weekly
//   reconciliation compute the net deposit settlement with the supplier.

import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'better-sqlite3';

type DB = Database;

export type ContainerKind =
  | 'CUSTOMER_TAKES_FULL'
  | 'CUSTOMER_RETURNS_EMPTY'
  | 'DEPOT_RECEIVES_FULL'
  | 'DEPOT_RETURNS_EMPTY';

interface ProductRow {
  id: string;
  is_returnable: number;
  bottle_deposit_pesewas: number;
}

function loadProduct(db: DB, productId: string): ProductRow {
  const r = db
    .prepare(`SELECT id, is_returnable, bottle_deposit_pesewas FROM products WHERE id = ?`)
    .get(productId) as ProductRow | undefined;
  if (!r) throw new Error(`empties: product ${productId} not found`);
  if (!r.is_returnable) throw new Error(`empties: product ${productId} is not returnable`);
  return r;
}

export function recordCustomerTakesFull(
  db: DB,
  input: {
    customerId: string;
    productId: string;
    quantity: number;
    relatedSaleId?: string | null;
    workerId: string;
    shiftId?: string | null;
    deviceId: string;
  },
): { id: string } {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error('recordCustomerTakesFull: quantity must be a positive integer');
  }
  const product = loadProduct(db, input.productId);
  return db.transaction(() => {
    const id = `cm-${uuidv4()}`;
    db.prepare(
      `INSERT INTO container_movements
         (id, product_id, customer_id, quantity, kind, related_sale_id,
          deposit_per_container_pesewas, shift_id, worker_id,
          created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, 'CUSTOMER_TAKES_FULL', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.productId, input.customerId, input.quantity,
      input.relatedSaleId ?? null, product.bottle_deposit_pesewas,
      input.shiftId ?? null, input.workerId,
      input.workerId, input.workerId, input.deviceId,
    );
    db.prepare(
      `UPDATE customers
          SET empties_owed_count = empties_owed_count + ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(input.quantity, input.workerId, input.customerId);
    return { id };
  })();
}

export function recordCustomerReturnsEmpty(
  db: DB,
  input: {
    customerId: string;
    productId: string;
    quantity: number;
    /** If true and shiftId set, refund the deposit from the till as a CASH_DROP. */
    refundDeposit?: boolean;
    relatedReturnId?: string | null;
    workerId: string;
    shiftId?: string | null;
    locationId: string;
    deviceId: string;
  },
): { id: string; depositRefundPesewas: number } {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error('recordCustomerReturnsEmpty: quantity must be a positive integer');
  }
  const product = loadProduct(db, input.productId);

  // Validate empties owed >= quantity.
  const current = db
    .prepare(`SELECT empties_owed_count FROM customers WHERE id = ?`)
    .get(input.customerId) as { empties_owed_count: number } | undefined;
  if (!current) throw new Error(`recordCustomerReturnsEmpty: customer ${input.customerId} not found`);
  if (current.empties_owed_count < input.quantity) {
    throw new Error(
      `recordCustomerReturnsEmpty: customer only owes ${current.empties_owed_count} bottles; cannot return ${input.quantity}`,
    );
  }

  const depositRefund = input.refundDeposit
    ? product.bottle_deposit_pesewas * input.quantity
    : 0;

  return db.transaction(() => {
    const id = `cm-${uuidv4()}`;
    db.prepare(
      `INSERT INTO container_movements
         (id, product_id, customer_id, quantity, kind, related_return_id,
          deposit_per_container_pesewas, shift_id, worker_id,
          created_by, updated_by, device_id)
       VALUES (?, ?, ?, ?, 'CUSTOMER_RETURNS_EMPTY', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.productId, input.customerId, input.quantity,
      input.relatedReturnId ?? null, product.bottle_deposit_pesewas,
      input.shiftId ?? null, input.workerId,
      input.workerId, input.workerId, input.deviceId,
    );
    db.prepare(
      `UPDATE customers
          SET empties_owed_count = empties_owed_count - ?,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              updated_by = ?
        WHERE id = ?`,
    ).run(input.quantity, input.workerId, input.customerId);

    if (depositRefund > 0) {
      if (!input.shiftId) {
        throw new Error('recordCustomerReturnsEmpty: refundDeposit requires shiftId');
      }
      db.prepare(
        `INSERT INTO cash_counts
           (id, shift_id, location_id, worker_id, count_type, counted_pesewas,
            notes, created_by, updated_by, device_id)
         VALUES (?, ?, ?, ?, 'CASH_DROP', ?, ?, ?, ?, ?)`,
      ).run(
        `cc-${uuidv4()}`, input.shiftId, input.locationId, input.workerId,
        depositRefund,
        `empties-deposit-refund:${input.customerId}:${input.productId}:${input.quantity}`,
        input.workerId, input.workerId, input.deviceId,
      );
    }
    return { id, depositRefundPesewas: depositRefund };
  })();
}

export function recordDepotReceivesFull(
  db: DB,
  input: {
    supplierId: string;
    productId: string;
    quantity: number;
    workerId: string;
    deviceId: string;
    notes?: string | null;
  },
): { id: string } {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error('recordDepotReceivesFull: quantity must be a positive integer');
  }
  const product = loadProduct(db, input.productId);
  const id = `cm-${uuidv4()}`;
  db.prepare(
    `INSERT INTO container_movements
       (id, product_id, supplier_id, quantity, kind,
        deposit_per_container_pesewas, worker_id, notes,
        created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, 'DEPOT_RECEIVES_FULL', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.productId, input.supplierId, input.quantity,
    product.bottle_deposit_pesewas, input.workerId, input.notes ?? null,
    input.workerId, input.workerId, input.deviceId,
  );
  return { id };
}

export function recordDepotReturnsEmpty(
  db: DB,
  input: {
    supplierId: string;
    productId: string;
    quantity: number;
    workerId: string;
    deviceId: string;
    notes?: string | null;
  },
): { id: string } {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error('recordDepotReturnsEmpty: quantity must be a positive integer');
  }
  const product = loadProduct(db, input.productId);
  const id = `cm-${uuidv4()}`;
  db.prepare(
    `INSERT INTO container_movements
       (id, product_id, supplier_id, quantity, kind,
        deposit_per_container_pesewas, worker_id, notes,
        created_by, updated_by, device_id)
     VALUES (?, ?, ?, ?, 'DEPOT_RETURNS_EMPTY', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.productId, input.supplierId, input.quantity,
    product.bottle_deposit_pesewas, input.workerId, input.notes ?? null,
    input.workerId, input.workerId, input.deviceId,
  );
  return { id };
}

export interface CustomerEmptiesRow {
  productId: string;
  productName: string;
  bottleDepositPesewas: number;
  qtyOwed: number;
  totalDepositPesewas: number;
}

/** Per-product empties balance for a single customer. */
export function customerEmptiesBalance(
  db: DB, customerId: string,
): CustomerEmptiesRow[] {
  return db
    .prepare(
      `SELECT cm.product_id AS productId, p.name AS productName,
              p.bottle_deposit_pesewas AS bottleDepositPesewas,
              COALESCE(SUM(CASE WHEN cm.kind = 'CUSTOMER_TAKES_FULL'
                                THEN cm.quantity ELSE -cm.quantity END), 0)
                AS qtyOwed
         FROM container_movements cm
         JOIN products p ON p.id = cm.product_id
        WHERE cm.customer_id = ?
        GROUP BY cm.product_id, p.name, p.bottle_deposit_pesewas
        HAVING qtyOwed > 0
        ORDER BY p.name ASC`,
    )
    .all(customerId)
    .map((r: any) => ({
      ...r,
      totalDepositPesewas: r.qtyOwed * r.bottleDepositPesewas,
    })) as CustomerEmptiesRow[];
}

export interface DepotReconciliationRow {
  supplierId: string;
  supplierName: string;
  productId: string;
  productName: string;
  fullsReceived: number;
  emptiesReturned: number;
  netOutstanding: number;
  depositPerContainerPesewas: number;
  netDepositValuePesewas: number;
}

/** Net empties balance per (supplier, product) for weekly settlement.
 *  Positive net = we still owe the supplier that many empties.
 *  Negative net = we returned more than we received (rare; usually means
 *  the supplier-side starting balance wasn't seeded). */
export function depotReconciliation(
  db: DB, sinceISO?: string, untilISO?: string,
): DepotReconciliationRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (sinceISO) { where.push('cm.created_at >= ?'); args.push(sinceISO); }
  if (untilISO) { where.push('cm.created_at <= ?'); args.push(untilISO); }
  const whereSql = where.length ? `AND ${where.join(' AND ')}` : '';

  return db
    .prepare(
      `SELECT cm.supplier_id AS supplierId, s.name AS supplierName,
              cm.product_id AS productId, p.name AS productName,
              p.bottle_deposit_pesewas AS depositPerContainerPesewas,
              COALESCE(SUM(CASE WHEN cm.kind = 'DEPOT_RECEIVES_FULL'
                                THEN cm.quantity ELSE 0 END), 0) AS fullsReceived,
              COALESCE(SUM(CASE WHEN cm.kind = 'DEPOT_RETURNS_EMPTY'
                                THEN cm.quantity ELSE 0 END), 0) AS emptiesReturned
         FROM container_movements cm
         JOIN products p ON p.id = cm.product_id
         JOIN suppliers s ON s.id = cm.supplier_id
        WHERE cm.supplier_id IS NOT NULL ${whereSql}
        GROUP BY cm.supplier_id, s.name, cm.product_id, p.name, p.bottle_deposit_pesewas
        ORDER BY s.name ASC, p.name ASC`,
    )
    .all(...args)
    .map((r: any) => {
      const net = r.fullsReceived - r.emptiesReturned;
      return {
        ...r,
        netOutstanding: net,
        netDepositValuePesewas: net * r.depositPerContainerPesewas,
      };
    }) as DepotReconciliationRow[];
}
