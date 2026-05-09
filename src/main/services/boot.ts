// Boot-time reconciliation jobs. Run once at app startup, after migrations,
// before the renderer mounts. Healing actions taken here are silent —
// users never see the warning that would otherwise surface.
//
// Currently:
//  1. Customer balance drift — recompute current_balance_pesewas from truth.
//
// Future: stocktake re-anchors, shift_summary backfill, cash drop deltas, etc.

import type { Database as DB } from 'better-sqlite3';
import { reconcileCustomerBalance } from './customerCredit.js';
import { logAudit } from '../db/audit.js';

const SYSTEM_ID = 'sys-system';

export interface BootReconcileResult {
  customersScanned: number;
  customersHealed: number;
  totalDriftPesewas: number;
  details: Array<{
    customerId: string;
    displayName: string;
    previousPesewas: number;
    newPesewas: number;
    driftPesewas: number;
  }>;
}

/** Walk every active customer and reconcile their cached balance against
 *  the canonical computed truth. Drift > 0 means cached was higher than
 *  truth (we showed them owing more than they actually do); drift < 0
 *  means the cache understated the debt. */
export function reconcileAllCustomersOnBoot(
  db: DB,
  deviceId: string,
): BootReconcileResult {
  const customers = db.prepare(
    `SELECT id, display_name, current_balance_pesewas
       FROM customers
       WHERE deleted_at IS NULL`,
  ).all() as Array<{ id: string; display_name: string; current_balance_pesewas: number }>;

  let healed = 0;
  let totalDrift = 0;
  const details: BootReconcileResult['details'] = [];

  const tx = db.transaction(() => {
    for (const c of customers) {
      const r = reconcileCustomerBalance(db, c.id);
      if (r.driftPesewas !== 0) {
        healed++;
        totalDrift += Math.abs(r.driftPesewas);
        details.push({
          customerId: c.id,
          displayName: c.display_name,
          previousPesewas: r.previousCached,
          newPesewas: r.newCached,
          driftPesewas: r.driftPesewas,
        });
        logAudit(db, {
          workerId: SYSTEM_ID,
          action: 'CUSTOMER_RECONCILED_AUTO',
          entityType: 'customers',
          entityId: c.id,
          beforeValue: { currentBalancePesewas: r.previousCached },
          afterValue: {
            currentBalancePesewas: r.newCached,
            driftPesewas: r.driftPesewas,
            trigger: 'boot',
          },
          deviceId,
        });
      }
    }
  });
  tx();

  return {
    customersScanned: customers.length,
    customersHealed: healed,
    totalDriftPesewas: totalDrift,
    details,
  };
}
