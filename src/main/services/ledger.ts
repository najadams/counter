// Owner Management Pack accounting foundation.
//
// This is deliberately a small, system-posted management ledger rather than
// a user-editable accounting package. Operational services call the posting
// helpers inside their existing SQLite transactions. Money is always integer
// pesewas; posted journals are immutable and corrections are reversals.

import type { Database as DB } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_LOCATION_ID } from '../../shared/lib/constants.js';
import { logAudit } from '../db/audit.js';
import { assertNotSealed, isDateSealed } from './periods.js';
import { verifyPin } from './workers.js';
import { vatForSale } from '../../shared/lib/vat.js';
import { maybeOpenFinancialAccountVarianceCase } from './varianceCases.js';

export type LedgerAccountClass = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'COGS' | 'EXPENSE';
export type FinancialAccountKind = 'TILL' | 'SAFE' | 'BANK' | 'MOMO' | 'OTHER_CASH';

export const LEDGER_CODES = {
  AR: 'AR',
  INVENTORY: 'INVENTORY',
  DEPOSITS_PREPAIDS: 'DEPOSITS_PREPAIDS',
  FIXED_ASSETS: 'FIXED_ASSETS',
  ACCUM_DEPRECIATION: 'ACCUM_DEPRECIATION',
  AP_TRADE: 'AP_TRADE',
  AP_BILLS: 'AP_BILLS',
  TAX_PAYABLE: 'TAX_PAYABLE',
  CUSTOMER_CREDITS: 'CUSTOMER_CREDITS',
  LOANS_PAYABLE: 'LOANS_PAYABLE',
  OWNER_CAPITAL: 'OWNER_CAPITAL',
  RETAINED_EARNINGS: 'RETAINED_EARNINGS',
  OWNER_DRAWINGS: 'OWNER_DRAWINGS',
  OPENING_EQUITY: 'OPENING_EQUITY',
  SALES_NET: 'SALES_NET',
  DELIVERY_INCOME: 'DELIVERY_INCOME',
  OTHER_INCOME: 'OTHER_INCOME',
  INVENTORY_GAIN: 'INVENTORY_GAIN',
  COGS: 'COGS',
  BAD_DEBT: 'BAD_DEBT',
  INTEREST_EXPENSE: 'INTEREST_EXPENSE',
  DEPRECIATION_EXPENSE: 'DEPRECIATION_EXPENSE',
  INCOME_TAX_EXPENSE: 'INCOME_TAX_EXPENSE',
  CASH_OVER_SHORT: 'CASH_OVER_SHORT',
  GAIN_ASSET_DISPOSAL: 'GAIN_ASSET_DISPOSAL',
  LOSS_ASSET_DISPOSAL: 'LOSS_ASSET_DISPOSAL',
} as const;

const EXPENSE_ACCOUNT_BY_CATEGORY: Record<string, string> = {
  RENT: 'EXP_RENT',
  UTILITIES: 'EXP_UTILITIES',
  TRANSPORT: 'EXP_TRANSPORT',
  SUPPLIES: 'EXP_SUPPLIES',
  COMMS: 'EXP_COMMS',
  REPAIRS: 'EXP_REPAIRS',
  BANK_FEES: 'EXP_BANK_FEES',
  STAFF_WAGES: 'EXP_STAFF_WAGES',
  STAFF_ADVANCE: 'EXP_STAFF_ADVANCE',
  COMMISSION: 'EXP_COMMISSION',
  STAFF_WELFARE: 'EXP_STAFF_WELFARE',
  OTHER: 'EXP_OTHER',
  INTEREST: LEDGER_CODES.INTEREST_EXPENSE,
  DEPRECIATION: LEDGER_CODES.DEPRECIATION_EXPENSE,
  INCOME_TAX: LEDGER_CODES.INCOME_TAX_EXPENSE,
};

const LOSS_ACCOUNT_BY_REASON: Record<string, string> = {
  BREAKAGE: 'LOSS_BREAKAGE',
  EXPIRED: 'LOSS_EXPIRY',
  THEFT_CONFIRMED: 'LOSS_THEFT',
  STOCKTAKE_VARIANCE_LOSS: 'LOSS_SHRINKAGE',
  WORKER_CONSUMED_FREE: 'LOSS_CONSUMPTION',
  WORKER_CONSUMED_PAID: 'LOSS_CONSUMPTION',
};

interface WorkerAccess {
  id: string;
  role: string;
}

function requireOwnerFounder(db: DB, actorWorkerId: string): WorkerAccess {
  const row = db.prepare(
    `SELECT id, role, active, deleted_at, terminated_at
       FROM workers WHERE id = ?`,
  ).get(actorWorkerId) as {
    id: string; role: string; active: number;
    deleted_at: string | null; terminated_at: string | null;
  } | undefined;
  if (!row || row.active !== 1 || row.deleted_at || row.terminated_at) {
    throw new Error('financial management: actor not active');
  }
  if (row.role !== 'OWNER' && row.role !== 'FOUNDER') {
    throw new Error('financial management requires OWNER or FOUNDER');
  }
  return { id: row.id, role: row.role };
}

function requireOwnerPin(
  db: DB,
  actorWorkerId: string,
  pin: string,
  deviceId: string,
): WorkerAccess {
  const actor = requireOwnerFounder(db, actorWorkerId);
  const result = verifyPin(db, actorWorkerId, pin, deviceId);
  if (!result.ok) {
    throw new Error(
      result.reason === 'LOCKED_OUT'
        ? `financial management locked out until ${result.lockedUntil}`
        : `financial management PIN check failed (${result.reason})`,
    );
  }
  return actor;
}

export function authorizeFinancialAccess(
  db: DB,
  actorWorkerId: string,
  pin: string,
  deviceId: string,
): void {
  requireOwnerPin(db, actorWorkerId, pin, deviceId);
}

function assertDateOnly(label: string, value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
}

function businessDate(occurredAt: string): string {
  const out = occurredAt.slice(0, 10);
  assertDateOnly('businessDate', out);
  return out;
}

function accountByCode(db: DB, locationId: string, code: string): {
  id: string;
  code: string;
  name: string;
  accountClass: LedgerAccountClass;
  normalBalance: 'DEBIT' | 'CREDIT';
} {
  const row = db.prepare(
    `SELECT id, code, name, account_class AS accountClass,
            normal_balance AS normalBalance
       FROM ledger_accounts
      WHERE location_id = ? AND code = ? AND active = 1`,
  ).get(locationId, code) as {
    id: string; code: string; name: string;
    accountClass: LedgerAccountClass; normalBalance: 'DEBIT' | 'CREDIT';
  } | undefined;
  if (!row) throw new Error(`ledger account ${code} is not available at ${locationId}`);
  return row;
}

function financialAccount(db: DB, id: string): {
  id: string;
  locationId: string;
  ledgerAccountId: string;
  name: string;
  kind: FinancialAccountKind;
  active: boolean;
} {
  const row = db.prepare(
    `SELECT id, location_id AS locationId, ledger_account_id AS ledgerAccountId,
            name, kind, active
       FROM financial_accounts WHERE id = ?`,
  ).get(id) as {
    id: string; locationId: string; ledgerAccountId: string;
    name: string; kind: FinancialAccountKind; active: number;
  } | undefined;
  if (!row || row.active !== 1) throw new Error(`financial account ${id} not found or inactive`);
  return { ...row, active: true };
}

export function isLedgerActive(db: DB, locationId = DEFAULT_LOCATION_ID): boolean {
  return !!db.prepare(
    `SELECT 1 FROM financial_cutovers
      WHERE location_id = ? AND status = 'ACTIVE' LIMIT 1`,
  ).get(locationId);
}

export function isLedgerPostingEnabled(db: DB, locationId = DEFAULT_LOCATION_ID): boolean {
  if (isLedgerActive(db, locationId)) return true;
  return !!db.prepare(
    `SELECT 1 FROM management_ledger_settings
      WHERE location_id = ? AND shadow_enabled = 1 LIMIT 1`,
  ).get(locationId);
}

export interface LedgerShadowVerification {
  enabled: boolean;
  startedAt: string | null;
  status: 'NOT_RUNNING' | 'PASS' | 'FAIL';
  issues: Array<{ code: string; message: string; differencePesewas?: number }>;
  salesChecked: number;
  stockMovementsChecked: number;
}

export function setLedgerShadowMode(
  db: DB,
  input: {
    locationId?: string;
    enabled: boolean;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): LedgerShadowVerification {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  if (isLedgerActive(db, locationId) && input.enabled) {
    throw new Error('shadow mode is unnecessary after financial cutover');
  }
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO management_ledger_settings (
       location_id, shadow_enabled, shadow_started_at, shadow_started_by,
       updated_at, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(location_id) DO UPDATE SET
       shadow_enabled = excluded.shadow_enabled,
       shadow_started_at = CASE WHEN excluded.shadow_enabled = 1
                                THEN excluded.shadow_started_at ELSE shadow_started_at END,
       shadow_started_by = CASE WHEN excluded.shadow_enabled = 1
                                THEN excluded.shadow_started_by ELSE shadow_started_by END,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by,
       device_id = excluded.device_id`,
  ).run(
    locationId, input.enabled ? 1 : 0, input.enabled ? now : null,
    input.enabled ? input.actorWorkerId : null, now, input.actorWorkerId, input.deviceId,
  );
  if (input.enabled) {
    const opening = db.prepare(
      `SELECT p.id AS productId, p.cost_price_pesewas AS unitCostPesewas,
              COALESCE(SUM(sm.quantity), 0) AS quantity
         FROM products p
         LEFT JOIN stock_movements sm ON sm.product_id = p.id AND sm.location_id = ?
        WHERE p.active = 1 AND p.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM inventory_valuation_movements ivm
             WHERE ivm.product_id = p.id AND ivm.location_id = ?
          )
        GROUP BY p.id HAVING quantity > 0`,
    ).all(locationId, locationId) as Array<{
      productId: string; unitCostPesewas: number; quantity: number;
    }>;
    const insert = db.prepare(
      `INSERT INTO inventory_valuation_movements (
         id, stock_movement_id, product_id, location_id, quantity_delta,
         value_delta_pesewas, balance_quantity, balance_value_pesewas,
         average_unit_cost_pesewas, occurred_at, created_by, device_id
       ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of opening) {
      const value = item.quantity * item.unitCostPesewas;
      insert.run(
        `ivm-shadow-${uuidv4()}`, item.productId, locationId, item.quantity, value,
        item.quantity, value, item.unitCostPesewas, now, input.actorWorkerId, input.deviceId,
      );
    }
  }
  logAudit(db, {
    workerId: input.actorWorkerId,
    action: input.enabled ? 'LEDGER_SHADOW_STARTED' : 'LEDGER_SHADOW_STOPPED',
    entityType: 'management_ledger_settings', entityId: locationId,
    afterValue: { enabled: input.enabled, at: now }, deviceId: input.deviceId,
  });
  return verifyLedgerShadow(db, locationId);
}

export function verifyLedgerShadow(
  db: DB,
  locationId = DEFAULT_LOCATION_ID,
): LedgerShadowVerification {
  const setting = db.prepare(
    `SELECT shadow_enabled AS enabled, shadow_started_at AS startedAt
       FROM management_ledger_settings WHERE location_id = ?`,
  ).get(locationId) as { enabled: number; startedAt: string | null } | undefined;
  if (!setting?.startedAt) {
    return { enabled: false, startedAt: null, status: 'NOT_RUNNING', issues: [], salesChecked: 0, stockMovementsChecked: 0 };
  }
  const issues: LedgerShadowVerification['issues'] = [];
  const sales = db.prepare(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(s.total_pesewas - s.vat_pesewas - s.nhil_pesewas - s.getfund_pesewas), 0) AS operationalSales,
            COALESCE(SUM((SELECT SUM(jl.credit_pesewas - jl.debit_pesewas)
                            FROM journal_entries je
                            JOIN journal_lines jl ON jl.journal_entry_id = je.id
                            JOIN ledger_accounts la ON la.id = jl.ledger_account_id
                           WHERE je.location_id = s.location_id AND je.source_type = 'SALE'
                             AND je.source_id = s.id AND je.posting_type = 'SALE_COMPLETE'
                             AND je.status = 'POSTED' AND la.code = 'SALES_NET')), 0) AS ledgerSales,
            COALESCE(SUM((SELECT SUM(jl.debit_pesewas - jl.credit_pesewas)
                            FROM journal_entries je
                            JOIN journal_lines jl ON jl.journal_entry_id = je.id
                            JOIN ledger_accounts la ON la.id = jl.ledger_account_id
                           WHERE je.location_id = s.location_id AND je.source_type = 'SALE'
                             AND je.source_id = s.id AND je.posting_type = 'SALE_COMPLETE'
                             AND je.status = 'POSTED' AND la.code = 'COGS')), 0) AS ledgerCogs,
            COALESCE(SUM((SELECT SUM(CASE WHEN sl.line_cogs_pesewas > 0
                                         THEN sl.line_cogs_pesewas
                                         ELSE sl.unit_cost_pesewas * sl.quantity END)
                            FROM sale_lines sl WHERE sl.sale_id = s.id)), 0) AS operationalCogs,
            COALESCE(SUM(CASE WHEN NOT EXISTS (
              SELECT 1 FROM journal_entries je WHERE je.location_id = s.location_id
               AND je.source_type = 'SALE' AND je.source_id = s.id
               AND je.posting_type = 'SALE_COMPLETE' AND je.status = 'POSTED'
            ) THEN 1 ELSE 0 END), 0) AS missing
       FROM sales s
      WHERE s.location_id = ? AND s.voided = 0 AND s.created_at >= ?`,
  ).get(locationId, setting.startedAt) as {
    count: number; operationalSales: number; ledgerSales: number;
    operationalCogs: number; ledgerCogs: number; missing: number;
  };
  if (sales.missing > 0) issues.push({ code: 'SHADOW_SALE_MISSING', message: `${sales.missing} shadow sale(s) have no journal.` });
  if (sales.operationalSales !== sales.ledgerSales) issues.push({
    code: 'SHADOW_SALES_DIFFERENCE', message: 'Shadow net sales do not match operational sales.',
    differencePesewas: sales.ledgerSales - sales.operationalSales,
  });
  if (sales.operationalCogs !== sales.ledgerCogs) issues.push({
    code: 'SHADOW_COGS_DIFFERENCE', message: 'Shadow COGS does not match sale-line cost snapshots.',
    differencePesewas: sales.ledgerCogs - sales.operationalCogs,
  });
  const stock = db.prepare(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN ivm.id IS NULL THEN 1 ELSE 0 END), 0) AS missing
       FROM stock_movements sm
       LEFT JOIN inventory_valuation_movements ivm ON ivm.stock_movement_id = sm.id
      WHERE sm.location_id = ? AND sm.created_at >= ?`,
  ).get(locationId, setting.startedAt) as { count: number; missing: number };
  if (stock.missing > 0) issues.push({
    code: 'SHADOW_STOCK_VALUE_MISSING', message: `${stock.missing} shadow stock movement(s) lack exact valuation.`,
  });
  return {
    enabled: setting.enabled === 1,
    startedAt: setting.startedAt,
    status: issues.length > 0 ? 'FAIL' : 'PASS',
    issues,
    salesChecked: sales.count,
    stockMovementsChecked: stock.count,
  };
}

export interface JournalLineInput {
  accountCode?: string;
  ledgerAccountId?: string;
  debitPesewas?: number;
  creditPesewas?: number;
  memo?: string | null;
  counterpartyType?: string | null;
  counterpartyId?: string | null;
}

export interface PostJournalInput {
  locationId: string;
  businessDate: string;
  occurredAt: string;
  sourceType: string;
  sourceId: string;
  postingType: string;
  description: string;
  lines: JournalLineInput[];
  actorWorkerId: string;
  deviceId: string;
  reversalOfId?: string | null;
  allowSealedDate?: boolean;
}

export function postJournal(db: DB, input: PostJournalInput): { journalEntryId: string; created: boolean } {
  assertDateOnly('businessDate', input.businessDate);
  if (!input.sourceType.trim() || !input.sourceId.trim() || !input.postingType.trim()) {
    throw new Error('journal source and posting type are required');
  }
  if (!input.allowSealedDate) {
    assertNotSealed(db, input.locationId, input.businessDate, `posting ${input.postingType}`);
  }

  const existing = db.prepare(
    `SELECT id, status FROM journal_entries
      WHERE location_id = ? AND source_type = ? AND source_id = ? AND posting_type = ?`,
  ).get(input.locationId, input.sourceType, input.sourceId, input.postingType) as
    { id: string; status: string } | undefined;
  if (existing) {
    if (existing.status !== 'POSTED') {
      throw new Error(`journal ${existing.id} exists but is ${existing.status}`);
    }
    return { journalEntryId: existing.id, created: false };
  }

  if (input.lines.length < 2) throw new Error('a journal requires at least two lines');
  let debitTotal = 0;
  let creditTotal = 0;
  const resolved = input.lines.map((line) => {
    const debit = line.debitPesewas ?? 0;
    const credit = line.creditPesewas ?? 0;
    if (!Number.isInteger(debit) || !Number.isInteger(credit) || debit < 0 || credit < 0) {
      throw new Error('journal amounts must be non-negative integer pesewas');
    }
    if ((debit > 0) === (credit > 0)) {
      throw new Error('each journal line must contain exactly one positive debit or credit');
    }
    const accountId = line.ledgerAccountId
      ?? accountByCode(db, input.locationId, line.accountCode ?? '').id;
    const belongs = db.prepare(
      'SELECT 1 FROM ledger_accounts WHERE id = ? AND location_id = ? AND active = 1',
    ).get(accountId, input.locationId);
    if (!belongs) throw new Error(`journal account ${accountId} does not belong to ${input.locationId}`);
    debitTotal += debit;
    creditTotal += credit;
    return { ...line, accountId, debit, credit };
  });
  if (debitTotal <= 0 || debitTotal !== creditTotal) {
    throw new Error(`unbalanced journal: debits ${debitTotal}, credits ${creditTotal}`);
  }

  const journalEntryId = `je-${uuidv4()}`;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO journal_entries (
         id, location_id, business_date, occurred_at, source_type, source_id,
         posting_type, description, status, reversal_of_id,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    ).run(
      journalEntryId, input.locationId, input.businessDate, input.occurredAt,
      input.sourceType, input.sourceId, input.postingType, input.description,
      input.reversalOfId ?? null, input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
    const insertLine = db.prepare(
      `INSERT INTO journal_lines (
         id, journal_entry_id, ledger_account_id, debit_pesewas, credit_pesewas,
         memo, counterparty_type, counterparty_id, created_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const line of resolved) {
      insertLine.run(
        `jl-${uuidv4()}`, journalEntryId, line.accountId, line.debit, line.credit,
        line.memo?.trim() || null, line.counterpartyType?.trim() || null,
        line.counterpartyId?.trim() || null, input.actorWorkerId, input.deviceId,
      );
    }
    db.prepare(
      `UPDATE journal_entries
          SET status = 'POSTED', updated_at = ?, updated_by = ?
        WHERE id = ? AND status = 'DRAFT'`,
    ).run(new Date().toISOString(), input.actorWorkerId, journalEntryId);
  })();
  return { journalEntryId, created: true };
}

export function reverseJournal(
  db: DB,
  input: {
    journalEntryId: string;
    sourceType: string;
    sourceId: string;
    reason: string;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
    occurredAt?: string;
  },
): { reversalJournalEntryId: string } {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  if (!input.reason.trim()) throw new Error('reversal reason is required');
  const original = db.prepare(
    `SELECT id, location_id AS locationId, business_date AS businessDate,
            description, status
       FROM journal_entries WHERE id = ?`,
  ).get(input.journalEntryId) as {
    id: string; locationId: string; businessDate: string; description: string; status: string;
  } | undefined;
  if (!original || original.status !== 'POSTED') throw new Error('posted journal not found');
  const alreadyReversed = db.prepare(
    `SELECT id FROM journal_entries WHERE reversal_of_id = ? AND status = 'POSTED' LIMIT 1`,
  ).get(original.id);
  if (alreadyReversed) throw new Error('journal has already been reversed');

  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const reversalDate = businessDate(occurredAt);
  assertNotSealed(db, original.locationId, reversalDate, 'posting a journal reversal');
  const lines = db.prepare(
    `SELECT ledger_account_id AS ledgerAccountId,
            debit_pesewas AS debitPesewas, credit_pesewas AS creditPesewas,
            memo, counterparty_type AS counterpartyType, counterparty_id AS counterpartyId
       FROM journal_lines WHERE journal_entry_id = ? ORDER BY id`,
  ).all(original.id) as Array<{
    ledgerAccountId: string; debitPesewas: number; creditPesewas: number;
    memo: string | null; counterpartyType: string | null; counterpartyId: string | null;
  }>;
  const posted = postJournal(db, {
    locationId: original.locationId,
    businessDate: reversalDate,
    occurredAt,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    postingType: 'REVERSAL',
    description: `Reverse ${original.description}: ${input.reason.trim()}`,
    actorWorkerId: input.actorWorkerId,
    deviceId: input.deviceId,
    reversalOfId: original.id,
    lines: lines.map((line) => ({
      ledgerAccountId: line.ledgerAccountId,
      debitPesewas: line.creditPesewas,
      creditPesewas: line.debitPesewas,
      memo: line.memo,
      counterpartyType: line.counterpartyType,
      counterpartyId: line.counterpartyId,
    })),
  });
  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'JOURNAL_REVERSED',
    entityType: 'journal_entries',
    entityId: original.id,
    afterValue: { reversalJournalEntryId: posted.journalEntryId, reason: input.reason.trim() },
    deviceId: input.deviceId,
  });
  return { reversalJournalEntryId: posted.journalEntryId };
}

export interface FinancialAccountRow {
  id: string;
  locationId: string;
  ledgerAccountId: string;
  ledgerCode: string;
  name: string;
  kind: FinancialAccountKind;
  provider: string | null;
  maskedIdentifier: string | null;
  allowNegative: boolean;
  active: boolean;
  balancePesewas: number;
  lastReconciledAt: string | null;
}

export interface LedgerAccountRow {
  id: string;
  code: string;
  name: string;
  accountClass: LedgerAccountClass;
  accountSubtype: string;
  normalBalance: 'DEBIT' | 'CREDIT';
}

export function listLedgerAccounts(
  db: DB,
  locationId = DEFAULT_LOCATION_ID,
): LedgerAccountRow[] {
  return db.prepare(
    `SELECT id, code, name, account_class AS accountClass,
            account_subtype AS accountSubtype, normal_balance AS normalBalance
       FROM ledger_accounts
      WHERE location_id = ? AND active = 1
      ORDER BY code`,
  ).all(locationId) as LedgerAccountRow[];
}

export function listFinancialAccounts(
  db: DB,
  locationId = DEFAULT_LOCATION_ID,
  includeInactive = false,
): FinancialAccountRow[] {
  return db.prepare(
    `SELECT fa.id, fa.location_id AS locationId, fa.ledger_account_id AS ledgerAccountId,
            la.code AS ledgerCode, fa.name, fa.kind, fa.provider,
            fa.masked_identifier AS maskedIdentifier,
            fa.allow_negative AS allowNegative, fa.active,
            COALESCE(SUM(CASE WHEN je.status = 'POSTED'
                              THEN jl.debit_pesewas - jl.credit_pesewas ELSE 0 END), 0)
              AS balancePesewas,
            fa.last_reconciled_at AS lastReconciledAt
       FROM financial_accounts fa
       JOIN ledger_accounts la ON la.id = fa.ledger_account_id
       LEFT JOIN journal_lines jl ON jl.ledger_account_id = la.id
       LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE fa.location_id = ?
        AND (? = 1 OR fa.active = 1)
      GROUP BY fa.id
      ORDER BY CASE fa.kind WHEN 'TILL' THEN 1 WHEN 'SAFE' THEN 2
                            WHEN 'BANK' THEN 3 WHEN 'MOMO' THEN 4 ELSE 5 END,
               fa.name`,
  ).all(locationId, includeInactive ? 1 : 0).map((row) => {
    const r = row as Omit<FinancialAccountRow, 'allowNegative' | 'active'> & {
      allowNegative: number; active: number;
    };
    return { ...r, allowNegative: r.allowNegative === 1, active: r.active === 1 };
  }) as FinancialAccountRow[];
}

export function createFinancialAccount(
  db: DB,
  input: {
    locationId?: string;
    name: string;
    kind: FinancialAccountKind;
    provider?: string | null;
    maskedIdentifier?: string | null;
    allowNegative?: boolean;
    actorWorkerId: string;
    deviceId: string;
  },
): FinancialAccountRow {
  requireOwnerFounder(db, input.actorWorkerId);
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  if (!input.name.trim()) throw new Error('financial account name is required');
  const now = new Date().toISOString();
  const suffix = uuidv4();
  const ledgerAccountId = `la-${suffix}`;
  const financialAccountId = `fa-${suffix}`;
  const code = `CASH_${input.kind}_${suffix.replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO ledger_accounts (
         id, location_id, code, name, account_class, account_subtype, normal_balance,
         system_managed, created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, 'ASSET', 'CASH', 'DEBIT', 1, ?, ?, ?)`,
    ).run(ledgerAccountId, locationId, code, input.name.trim(), input.actorWorkerId, input.actorWorkerId, input.deviceId);
    db.prepare(
      `INSERT INTO financial_accounts (
         id, location_id, ledger_account_id, name, kind, provider, masked_identifier,
         allow_negative, created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      financialAccountId, locationId, ledgerAccountId, input.name.trim(), input.kind,
      input.provider?.trim() || null, input.maskedIdentifier?.trim() || null,
      input.allowNegative ? 1 : 0, input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
    logAudit(db, {
      workerId: input.actorWorkerId,
      action: 'FINANCIAL_ACCOUNT_CREATED',
      entityType: 'financial_accounts',
      entityId: financialAccountId,
      afterValue: { locationId, name: input.name.trim(), kind: input.kind },
      deviceId: input.deviceId,
    });
  });
  tx();
  void now;
  return listFinancialAccounts(db, locationId, true).find((row) => row.id === financialAccountId)!;
}

export function updateFinancialAccount(
  db: DB,
  input: {
    financialAccountId: string;
    name: string;
    provider?: string | null;
    maskedIdentifier?: string | null;
    allowNegative?: boolean;
    active?: boolean;
    actorWorkerId: string;
    deviceId: string;
  },
): FinancialAccountRow {
  requireOwnerFounder(db, input.actorWorkerId);
  if (!input.name.trim()) throw new Error('financial account name is required');
  const current = db.prepare(
    `SELECT fa.id, fa.location_id AS locationId, fa.ledger_account_id AS ledgerAccountId,
            fa.active, la.name AS ledgerName
       FROM financial_accounts fa
       JOIN ledger_accounts la ON la.id = fa.ledger_account_id
      WHERE fa.id = ?`,
  ).get(input.financialAccountId) as {
    id: string; locationId: string; ledgerAccountId: string; active: number; ledgerName: string;
  } | undefined;
  if (!current) throw new Error('financial account not found');
  const nextActive = input.active ?? current.active === 1;
  if (!nextActive && current.active === 1) {
    const balance = financialAccountBalanceAsOf(db, current.id, '9999-12-31T23:59:59.999Z');
    if (balance !== 0) throw new Error('transfer or reconcile this account to zero before deactivating it');
    const openShift = db.prepare(
      'SELECT 1 FROM shifts WHERE financial_account_id = ? AND closed_at IS NULL LIMIT 1',
    ).get(current.id);
    if (openShift) throw new Error('close the shift using this till before deactivating it');
    const mapping = db.prepare(
      'SELECT 1 FROM payment_account_mappings WHERE financial_account_id = ? LIMIT 1',
    ).get(current.id);
    if (mapping) throw new Error('remap payment methods before deactivating this account');
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(
      `UPDATE financial_accounts
          SET name = ?, provider = ?, masked_identifier = ?, allow_negative = ?, active = ?,
              updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(
      input.name.trim(), input.provider?.trim() || null, input.maskedIdentifier?.trim() || null,
      input.allowNegative ? 1 : 0, nextActive ? 1 : 0, now, input.actorWorkerId, current.id,
    );
    db.prepare(
      `UPDATE ledger_accounts SET name = ?, active = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
    ).run(input.name.trim(), nextActive ? 1 : 0, now, input.actorWorkerId, current.ledgerAccountId);
    logAudit(db, {
      workerId: input.actorWorkerId,
      action: 'FINANCIAL_ACCOUNT_UPDATED',
      entityType: 'financial_accounts',
      entityId: current.id,
      beforeValue: { name: current.ledgerName, active: current.active === 1 },
      afterValue: { name: input.name.trim(), active: nextActive },
      deviceId: input.deviceId,
    });
  })();
  return listFinancialAccounts(db, current.locationId, true).find((row) => row.id === current.id)!;
}

export function setPaymentAccountMapping(
  db: DB,
  input: {
    locationId?: string;
    paymentMethod: string;
    direction: 'IN' | 'OUT';
    financialAccountId: string;
    actorWorkerId: string;
    deviceId: string;
  },
): void {
  requireOwnerFounder(db, input.actorWorkerId);
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  const account = financialAccount(db, input.financialAccountId);
  if (account.locationId !== locationId) throw new Error('financial account belongs to another location');
  const exists = db.prepare('SELECT 1 FROM payment_methods WHERE code = ? AND active = 1')
    .get(input.paymentMethod);
  if (!exists) throw new Error(`unknown payment method ${input.paymentMethod}`);
  const current = db.prepare(
    `SELECT id FROM payment_account_mappings
      WHERE location_id = ? AND payment_method = ? AND direction = ?`,
  ).get(locationId, input.paymentMethod, input.direction) as { id: string } | undefined;
  const now = new Date().toISOString();
  if (current) {
    db.prepare(
      `UPDATE payment_account_mappings
          SET financial_account_id = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(input.financialAccountId, now, input.actorWorkerId, current.id);
  } else {
    db.prepare(
      `INSERT INTO payment_account_mappings (
         id, location_id, payment_method, direction, financial_account_id,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `pam-${uuidv4()}`, locationId, input.paymentMethod, input.direction,
      input.financialAccountId, input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
  }
}

export function mappedFinancialAccount(
  db: DB,
  locationId: string,
  paymentMethod: string,
  direction: 'IN' | 'OUT',
): { financialAccountId: string; ledgerAccountId: string } {
  const row = db.prepare(
    `SELECT pam.financial_account_id AS financialAccountId,
            fa.ledger_account_id AS ledgerAccountId
       FROM payment_account_mappings pam
       JOIN financial_accounts fa ON fa.id = pam.financial_account_id
      WHERE pam.location_id = ? AND pam.payment_method = ? AND pam.direction = ?
        AND fa.active = 1`,
  ).get(locationId, paymentMethod, direction) as {
    financialAccountId: string; ledgerAccountId: string;
  } | undefined;
  if (!row) throw new Error(`no ${direction} financial account mapping for ${paymentMethod}`);
  return row;
}

export function financialAccountBalanceAsOf(
  db: DB,
  financialAccountId: string,
  asOfExclusive?: string,
): number {
  const account = financialAccount(db, financialAccountId);
  const whereDate = asOfExclusive ? 'AND je.occurred_at < ?' : '';
  const args: unknown[] = [account.ledgerAccountId];
  if (asOfExclusive) args.push(asOfExclusive);
  return (db.prepare(
    `SELECT COALESCE(SUM(jl.debit_pesewas - jl.credit_pesewas), 0) AS balance
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
      WHERE jl.ledger_account_id = ? AND je.status = 'POSTED' ${whereDate}`,
  ).get(...args) as { balance: number }).balance;
}

export function createAccountTransfer(
  db: DB,
  input: {
    locationId?: string;
    fromFinancialAccountId: string;
    toFinancialAccountId: string;
    amountPesewas: number;
    occurredAt?: string;
    reference?: string | null;
    notes?: string | null;
    actorWorkerId: string;
    deviceId: string;
  },
): { transferId: string; journalEntryId: string } {
  requireOwnerFounder(db, input.actorWorkerId);
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('transfer amount must be positive integer pesewas');
  }
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  const from = financialAccount(db, input.fromFinancialAccountId);
  const to = financialAccount(db, input.toFinancialAccountId);
  if (from.locationId !== locationId || to.locationId !== locationId) {
    throw new Error('transfer accounts must belong to the selected location');
  }
  if (from.id === to.id) throw new Error('transfer source and destination must differ');
  const available = financialAccountBalanceAsOf(db, from.id);
  if (!from.active || (available < input.amountPesewas && !db.prepare(
    'SELECT allow_negative FROM financial_accounts WHERE id = ?',
  ).pluck().get(from.id))) {
    throw new Error(`transfer exceeds available balance (${available} pesewas)`);
  }
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  const transferId = `ft-${uuidv4()}`;
  let journalEntryId = '';
  db.transaction(() => {
    journalEntryId = postJournal(db, {
      locationId,
      businessDate: businessDate(occurredAt),
      occurredAt,
      sourceType: 'ACCOUNT_TRANSFER',
      sourceId: transferId,
      postingType: 'TRANSFER',
      description: `Transfer from ${from.name} to ${to.name}`,
      actorWorkerId: input.actorWorkerId,
      deviceId: input.deviceId,
      lines: [
        { ledgerAccountId: to.ledgerAccountId, debitPesewas: input.amountPesewas },
        { ledgerAccountId: from.ledgerAccountId, creditPesewas: input.amountPesewas },
      ],
    }).journalEntryId;
    db.prepare(
      `INSERT INTO account_transfers (
         id, location_id, from_financial_account_id, to_financial_account_id,
         amount_pesewas, occurred_at, reference, notes, journal_entry_id,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transferId, locationId, from.id, to.id, input.amountPesewas, occurredAt,
      input.reference?.trim() || null, input.notes?.trim() || null, journalEntryId,
      input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
  })();
  return { transferId, journalEntryId };
}

export function recordOwnerContribution(
  db: DB,
  input: {
    financialAccountId: string;
    amountPesewas: number;
    receivedAt?: string;
    notes?: string | null;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): { contributionId: string; journalEntryId: string } {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('owner contribution must be positive integer pesewas');
  }
  const account = financialAccount(db, input.financialAccountId);
  if (!isLedgerActive(db, account.locationId)) {
    throw new Error('record opening owner capital through the cutover wizard');
  }
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const contributionId = `oc-${uuidv4()}`;
  const journalEntryId = postJournal(db, {
    locationId: account.locationId,
    businessDate: businessDate(receivedAt),
    occurredAt: receivedAt,
    sourceType: 'OWNER_CONTRIBUTION',
    sourceId: contributionId,
    postingType: 'OWNER_CONTRIBUTION',
    description: input.notes?.trim() || 'Owner capital contribution',
    actorWorkerId: input.actorWorkerId,
    deviceId: input.deviceId,
    lines: [
      { ledgerAccountId: account.ledgerAccountId, debitPesewas: input.amountPesewas },
      { accountCode: LEDGER_CODES.OWNER_CAPITAL, creditPesewas: input.amountPesewas },
    ],
  }).journalEntryId;
  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'OWNER_CONTRIBUTION_RECORDED',
    entityType: 'journal_entries',
    entityId: journalEntryId,
    afterValue: {
      contributionId,
      financialAccountId: account.id,
      amountPesewas: input.amountPesewas,
    },
    deviceId: input.deviceId,
  });
  return { contributionId, journalEntryId };
}

export function reconcileFinancialAccount(
  db: DB,
  input: {
    financialAccountId: string;
    observedPesewas: number;
    reconciledAt?: string;
    reference?: string | null;
    evidenceUrl?: string | null;
    notes?: string | null;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): { reconciliationId: string; variancePesewas: number; adjustmentJournalEntryId: string | null } {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  if (!Number.isInteger(input.observedPesewas) || input.observedPesewas < 0) {
    throw new Error('observed balance must be non-negative integer pesewas');
  }
  const account = financialAccount(db, input.financialAccountId);
  const reconciledAt = input.reconciledAt ?? new Date().toISOString();
  const expected = financialAccountBalanceAsOf(db, account.id, reconciledAt);
  const variance = input.observedPesewas - expected;
  const reconciliationId = `fr-${uuidv4()}`;
  let adjustmentJournalEntryId: string | null = null;
  db.transaction(() => {
    if (variance !== 0) {
      const amount = Math.abs(variance);
      adjustmentJournalEntryId = postJournal(db, {
        locationId: account.locationId,
        businessDate: businessDate(reconciledAt),
        occurredAt: reconciledAt,
        sourceType: 'ACCOUNT_RECONCILIATION',
        sourceId: reconciliationId,
        postingType: 'CASH_VARIANCE',
        description: `Reconcile ${account.name}`,
        actorWorkerId: input.actorWorkerId,
        deviceId: input.deviceId,
        lines: variance > 0
          ? [
              { ledgerAccountId: account.ledgerAccountId, debitPesewas: amount },
              { accountCode: LEDGER_CODES.CASH_OVER_SHORT, creditPesewas: amount },
            ]
          : [
              { accountCode: LEDGER_CODES.CASH_OVER_SHORT, debitPesewas: amount },
              { ledgerAccountId: account.ledgerAccountId, creditPesewas: amount },
            ],
      }).journalEntryId;
    }
    db.prepare(
      `INSERT INTO account_reconciliations (
         id, location_id, financial_account_id, reconciled_at,
         expected_pesewas, observed_pesewas, variance_pesewas,
         reference, evidence_url, notes, adjustment_journal_entry_id,
         approved_by, created_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      reconciliationId, account.locationId, account.id, reconciledAt,
      expected, input.observedPesewas, variance, input.reference?.trim() || null,
      input.evidenceUrl?.trim() || null, input.notes?.trim() || null,
      adjustmentJournalEntryId, input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
    db.prepare(
      `UPDATE financial_accounts
          SET last_reconciled_at = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(reconciledAt, new Date().toISOString(), input.actorWorkerId, account.id);
    maybeOpenFinancialAccountVarianceCase(db, {
      reconciliationId,
      locationId: account.locationId,
      financialAccountId: account.id,
      accountName: account.name,
      expectedPesewas: expected,
      observedPesewas: input.observedPesewas,
      variancePesewas: variance,
      adjustmentJournalEntryId,
      actorWorkerId: input.actorWorkerId,
      deviceId: input.deviceId,
      detectedAt: reconciledAt,
    });
  })();
  return { reconciliationId, variancePesewas: variance, adjustmentJournalEntryId };
}

export interface DataQualityIssue {
  code: string;
  severity: 'WARNING' | 'BLOCKING';
  message: string;
  amountPesewas?: number;
}

export interface DataQualityResult {
  status: 'COMPLETE' | 'PROVISIONAL' | 'INCOMPLETE';
  cutoverDate: string | null;
  issues: DataQualityIssue[];
}

export function getFinancialDataQuality(
  db: DB,
  input: {
    locationId?: string;
    fromDate?: string;
    toDate?: string;
    reportKind?: 'PROFIT' | 'POSITION' | 'CASH' | 'OBLIGATIONS' | 'CONCENTRATION' | 'DOWNSIDE';
    asOfDate?: string;
  } = {},
): DataQualityResult {
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  const cutover = db.prepare(
    `SELECT cutover_date AS cutoverDate, status
       FROM financial_cutovers WHERE location_id = ?`,
  ).get(locationId) as { cutoverDate: string; status: string } | undefined;
  const issues: DataQualityIssue[] = [];
  if (!cutover || cutover.status !== 'ACTIVE') {
    issues.push({
      code: 'CUTOVER_NOT_ACTIVE',
      severity: 'BLOCKING',
      message: 'The management ledger has not completed a balanced cutover.',
    });
  }

  const unmapped = (db.prepare(
    `SELECT COUNT(*) AS count
       FROM payment_methods pm
      WHERE pm.active = 1 AND pm.code NOT IN ('CREDIT','RETURN_CREDIT')
        AND NOT EXISTS (
          SELECT 1 FROM payment_account_mappings pam
           WHERE pam.location_id = ? AND pam.payment_method = pm.code
             AND pam.direction = 'IN'
        )`,
  ).get(locationId) as { count: number }).count;
  if (unmapped > 0) {
    issues.push({
      code: 'UNMAPPED_PAYMENT_METHOD',
      severity: 'BLOCKING',
      message: `${unmapped} active payment method(s) have no incoming financial account.`,
    });
  }

  const unbalanced = (db.prepare(
    `SELECT COUNT(*) AS count FROM (
       SELECT je.id
         FROM journal_entries je
         JOIN journal_lines jl ON jl.journal_entry_id = je.id
        WHERE je.location_id = ? AND je.status = 'POSTED'
        GROUP BY je.id
       HAVING SUM(jl.debit_pesewas) != SUM(jl.credit_pesewas)
     )`,
  ).get(locationId) as { count: number }).count;
  if (unbalanced > 0) {
    issues.push({
      code: 'UNBALANCED_JOURNAL',
      severity: 'BLOCKING',
      message: `${unbalanced} posted journal(s) do not balance.`,
    });
  }
  if (cutover?.status === 'ACTIVE') {
    const ledgerInventory = (db.prepare(
      `SELECT COALESCE(SUM(jl.debit_pesewas - jl.credit_pesewas), 0) AS total
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         JOIN ledger_accounts la ON la.id = jl.ledger_account_id
        WHERE je.location_id = ? AND je.status = 'POSTED' AND la.code = ?
          AND je.business_date >= ?`,
    ).get(locationId, LEDGER_CODES.INVENTORY, cutover.cutoverDate) as { total: number }).total;
    const valuationInventory = (db.prepare(
      `SELECT COALESCE(SUM(balance_value_pesewas), 0) AS total FROM (
         SELECT product_id, balance_value_pesewas,
                ROW_NUMBER() OVER (
                  PARTITION BY product_id, location_id
                  ORDER BY occurred_at DESC, created_at DESC, id DESC
                ) AS rn
           FROM inventory_valuation_movements
          WHERE location_id = ?
       ) WHERE rn = 1`,
    ).get(locationId) as { total: number }).total;
    if (ledgerInventory !== valuationInventory) {
      issues.push({
        code: 'INVENTORY_VALUE_MISMATCH',
        severity: 'BLOCKING',
        message: 'Ledger inventory does not equal the perpetual valuation ledger.',
        amountPesewas: ledgerInventory - valuationInventory,
      });
    }
    const unvalued = (db.prepare(
      `SELECT COUNT(*) AS count
         FROM stock_movements sm
        WHERE sm.location_id = ? AND date(sm.created_at) >= ?
          AND NOT EXISTS (
            SELECT 1 FROM inventory_valuation_movements ivm
             WHERE ivm.stock_movement_id = sm.id
          )`,
    ).get(locationId, cutover.cutoverDate) as { count: number }).count;
    if (unvalued > 0) {
      issues.push({
        code: 'UNVALUED_STOCK_MOVEMENT',
        severity: 'BLOCKING',
        message: `${unvalued} post-cutover stock movement(s) have no exact valuation entry.`,
      });
    }
  }

  const nowMs = Date.now();
  const accounts = listFinancialAccounts(db, locationId);
  for (const account of accounts) {
    const maxAgeDays = account.kind === 'TILL' ? 1 : 7;
    const age = account.lastReconciledAt
      ? Math.floor((nowMs - new Date(account.lastReconciledAt).getTime()) / 86_400_000)
      : null;
    if (age == null || age > maxAgeDays) {
      issues.push({
        code: 'STALE_ACCOUNT_RECONCILIATION',
        severity: 'WARNING',
        message: `${account.name} has ${age == null ? 'never been' : `not been in ${age} days`} reconciled.`,
        amountPesewas: account.balancePesewas,
      });
    }
  }

  if (input.reportKind === 'OBLIGATIONS') {
    const missingDue = (db.prepare(
      `SELECT COUNT(*) AS count FROM obligations
        WHERE location_id = ? AND status IN ('OPEN','PARTIALLY_PAID','DISPUTED')
          AND due_date IS NULL`,
    ).get(locationId) as { count: number }).count;
    if (missingDue > 0) {
      issues.push({
        code: 'MISSING_OBLIGATION_DUE_DATE',
        severity: 'BLOCKING',
        message: `${missingDue} open obligation(s) have no due date.`,
      });
    }
  }

  const latestStocktake = db.prepare(
    `SELECT MAX(completed_at) AS completedAt FROM stocktake_events
      WHERE location_id = ? AND status = 'COMPLETED'`,
  ).get(locationId) as { completedAt: string | null };
  const stocktakeAge = latestStocktake.completedAt
    ? Math.floor((nowMs - new Date(latestStocktake.completedAt).getTime()) / 86_400_000)
    : null;
  if (stocktakeAge == null || stocktakeAge > 30) {
    issues.push({
      code: 'STALE_STOCKTAKE',
      severity: 'WARNING',
      message: stocktakeAge == null
        ? 'No completed stocktake supports the inventory balance.'
        : `The latest stocktake is ${stocktakeAge} days old.`,
    });
  }

  let provisional = false;
  const throughDate = input.toDate ?? input.asOfDate;
  if (throughDate) {
    assertDateOnly('report end date', throughDate);
    const today = new Date().toISOString().slice(0, 10);
    if (throughDate >= today || !isDateSealed(db, locationId, throughDate)) {
      provisional = true;
      issues.push({
        code: 'PERIOD_NOT_SEALED',
        severity: 'WARNING',
        message: `The period through ${throughDate} is still open or unsealed.`,
      });
    }
  }

  const blocking = issues.some((issue) => issue.severity === 'BLOCKING');
  return {
    status: blocking ? 'INCOMPLETE' : provisional || issues.length > 0 ? 'PROVISIONAL' : 'COMPLETE',
    cutoverDate: cutover?.cutoverDate ?? null,
    issues,
  };
}

export interface CutoverBalanceInput {
  ledgerAccountId: string;
  amountPesewas: number;
}

export interface CutoverPreview {
  locationId: string;
  cutoverDate: string;
  debitPesewas: number;
  creditPesewas: number;
  openingEquityPesewas: number;
  balances: Array<{
    ledgerAccountId: string;
    code: string;
    name: string;
    accountClass: LedgerAccountClass;
    normalBalance: 'DEBIT' | 'CREDIT';
    amountPesewas: number;
  }>;
  issues: DataQualityIssue[];
}

export function previewFinancialCutover(
  db: DB,
  input: {
    locationId?: string;
    cutoverDate: string;
    balances: CutoverBalanceInput[];
  },
): CutoverPreview {
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  assertDateOnly('cutoverDate', input.cutoverDate);
  if (db.prepare(
    `SELECT 1 FROM financial_cutovers WHERE location_id = ? AND status = 'ACTIVE'`,
  ).get(locationId)) {
    throw new Error('financial cutover is already active');
  }
  const issues: DataQualityIssue[] = [];
  const openShifts = (db.prepare(
    'SELECT COUNT(*) AS count FROM shifts WHERE location_id = ? AND closed_at IS NULL',
  ).get(locationId) as { count: number }).count;
  if (openShifts > 0) {
    issues.push({
      code: 'OPEN_SHIFTS',
      severity: 'BLOCKING',
      message: `${openShifts} shift(s) must be closed before cutover.`,
    });
  }
  const cutover = new Date(`${input.cutoverDate}T12:00:00`);
  cutover.setDate(cutover.getDate() - 1);
  const priorDate = cutover.toISOString().slice(0, 10);
  if (!isDateSealed(db, locationId, priorDate)) {
    issues.push({
      code: 'PRIOR_DAY_NOT_SEALED',
      severity: 'BLOCKING',
      message: `Seal ${priorDate} before activating the ${input.cutoverDate} cutover.`,
    });
  }
  const latestStocktake = db.prepare(
    `SELECT MAX(completed_at) AS completedAt
       FROM stocktake_events
      WHERE location_id = ? AND status = 'COMPLETED'`,
  ).get(locationId) as { completedAt: string | null };
  const stocktakeAgeDays = latestStocktake.completedAt
    ? Math.floor(
        (new Date(`${input.cutoverDate}T00:00:00.000Z`).getTime()
          - new Date(latestStocktake.completedAt).getTime()) / 86_400_000,
      )
    : null;
  if (stocktakeAgeDays == null || stocktakeAgeDays > 30) {
    issues.push({
      code: 'RECENT_STOCKTAKE_REQUIRED',
      severity: 'BLOCKING',
      message: stocktakeAgeDays == null
        ? 'Complete a physical stocktake before activation.'
        : `The supporting stocktake is ${stocktakeAgeDays} days old; it must be within 30 days.`,
    });
  }
  const shadow = verifyLedgerShadow(db, locationId);
  if (shadow.enabled && shadow.status === 'FAIL') {
    issues.push({
      code: 'SHADOW_VERIFICATION_FAILED',
      severity: 'BLOCKING',
      message: `Shadow verification has ${shadow.issues.length} unresolved difference(s).`,
    });
  }
  const seen = new Set<string>();
  let debit = 0;
  let credit = 0;
  const balances = input.balances.map((balance) => {
    if (!Number.isInteger(balance.amountPesewas) || balance.amountPesewas < 0) {
      throw new Error('cutover balances must be non-negative integer pesewas');
    }
    if (seen.has(balance.ledgerAccountId)) throw new Error('duplicate cutover account');
    seen.add(balance.ledgerAccountId);
    const account = db.prepare(
      `SELECT id AS ledgerAccountId, code, name,
              account_class AS accountClass, normal_balance AS normalBalance
         FROM ledger_accounts
        WHERE id = ? AND location_id = ? AND active = 1`,
    ).get(balance.ledgerAccountId, locationId) as {
      ledgerAccountId: string; code: string; name: string;
      accountClass: LedgerAccountClass; normalBalance: 'DEBIT' | 'CREDIT';
    } | undefined;
    if (!account) throw new Error(`cutover ledger account ${balance.ledgerAccountId} not found`);
    if (account.normalBalance === 'DEBIT') debit += balance.amountPesewas;
    else credit += balance.amountPesewas;
    return { ...account, amountPesewas: balance.amountPesewas };
  });
  const derivedInventory = (db.prepare(
    `SELECT COALESCE(SUM(qty * cost_price_pesewas), 0) AS total
       FROM (
         SELECT p.id, p.cost_price_pesewas,
                COALESCE(SUM(CASE WHEN date(sm.created_at) <= ? THEN sm.quantity ELSE 0 END), 0) AS qty
           FROM products p
           LEFT JOIN stock_movements sm
             ON sm.product_id = p.id AND sm.location_id = ?
          WHERE p.active = 1 AND p.deleted_at IS NULL
          GROUP BY p.id
       )
      WHERE qty > 0`,
  ).get(priorDate, locationId) as { total: number }).total;
  const enteredInventory = balances.find((balance) => balance.code === LEDGER_CODES.INVENTORY)
    ?.amountPesewas ?? 0;
  if (enteredInventory !== derivedInventory) {
    issues.push({
      code: 'OPENING_INVENTORY_MISMATCH',
      severity: 'BLOCKING',
      message: `Opening inventory must equal the stock valuation of ${derivedInventory} pesewas.`,
      amountPesewas: derivedInventory - enteredInventory,
    });
  }
  const openingEquity = debit - credit;
  return {
    locationId,
    cutoverDate: input.cutoverDate,
    debitPesewas: debit + Math.max(0, -openingEquity),
    creditPesewas: credit + Math.max(0, openingEquity),
    openingEquityPesewas: openingEquity,
    balances,
    issues,
  };
}

export function activateFinancialCutover(
  db: DB,
  input: {
    locationId?: string;
    cutoverDate: string;
    balances: CutoverBalanceInput[];
    notes?: string | null;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): { cutoverId: string; openingJournalEntryId: string; openingEquityPesewas: number } {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  const preview = previewFinancialCutover(db, input);
  const blockers = preview.issues.filter((issue) => issue.severity === 'BLOCKING');
  if (blockers.length > 0) throw new Error(blockers.map((issue) => issue.message).join(' '));
  const cutoverId = `fc-${uuidv4()}`;
  const occurredAt = `${input.cutoverDate}T00:00:00.000Z`;
  let openingJournalEntryId = '';
  db.transaction(() => {
    const lines: JournalLineInput[] = preview.balances
      .filter((balance) => balance.amountPesewas > 0)
      .map((balance) => ({
        ledgerAccountId: balance.ledgerAccountId,
        debitPesewas: balance.normalBalance === 'DEBIT' ? balance.amountPesewas : 0,
        creditPesewas: balance.normalBalance === 'CREDIT' ? balance.amountPesewas : 0,
      }));
    const difference = lines.reduce(
      (acc, line) => acc + (line.debitPesewas ?? 0) - (line.creditPesewas ?? 0),
      0,
    );
    if (difference > 0) {
      lines.push({ accountCode: LEDGER_CODES.OPENING_EQUITY, creditPesewas: difference });
    } else if (difference < 0) {
      lines.push({ accountCode: LEDGER_CODES.OPENING_EQUITY, debitPesewas: Math.abs(difference) });
    }
    openingJournalEntryId = postJournal(db, {
      locationId: preview.locationId,
      businessDate: input.cutoverDate,
      occurredAt,
      sourceType: 'FINANCIAL_CUTOVER',
      sourceId: cutoverId,
      postingType: 'OPENING_BALANCES',
      description: 'Owner-verified opening balances',
      actorWorkerId: input.actorWorkerId,
      deviceId: input.deviceId,
      allowSealedDate: true,
      lines,
    }).journalEntryId;
    const openingInventory = db.prepare(
      `SELECT p.id AS productId, p.cost_price_pesewas AS unitCostPesewas,
              COALESCE(SUM(CASE WHEN date(sm.created_at) < ? THEN sm.quantity ELSE 0 END), 0) AS quantity
         FROM products p
         LEFT JOIN stock_movements sm
           ON sm.product_id = p.id AND sm.location_id = ?
        WHERE p.active = 1 AND p.deleted_at IS NULL
        GROUP BY p.id
       HAVING quantity > 0`,
    ).all(input.cutoverDate, preview.locationId) as Array<{
      productId: string; unitCostPesewas: number; quantity: number;
    }>;
    for (const item of openingInventory) {
      const value = item.quantity * item.unitCostPesewas;
      db.prepare(
        `INSERT INTO inventory_valuation_movements (
           id, stock_movement_id, product_id, location_id, quantity_delta,
           value_delta_pesewas, balance_quantity, balance_value_pesewas,
           average_unit_cost_pesewas, occurred_at, created_by, device_id
         ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `ivm-opening-${uuidv4()}`, item.productId, preview.locationId,
        item.quantity, value, item.quantity, value, item.unitCostPesewas,
        occurredAt, input.actorWorkerId, input.deviceId,
      );
    }
    for (const balance of preview.balances) {
      const moneyAccount = db.prepare(
        `SELECT id FROM financial_accounts
          WHERE ledger_account_id = ? AND location_id = ? AND active = 1`,
      ).get(balance.ledgerAccountId, preview.locationId) as { id: string } | undefined;
      if (!moneyAccount) continue;
      db.prepare(
        `INSERT INTO account_reconciliations (
           id, location_id, financial_account_id, reconciled_at,
           expected_pesewas, observed_pesewas, variance_pesewas,
           notes, approved_by, created_by, device_id
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      ).run(
        `fr-opening-${uuidv4()}`, preview.locationId, moneyAccount.id, occurredAt,
        balance.amountPesewas, balance.amountPesewas,
        'Owner-verified cutover balance', input.actorWorkerId,
        input.actorWorkerId, input.deviceId,
      );
      db.prepare(
        `UPDATE financial_accounts
            SET last_reconciled_at = ?, updated_at = ?, updated_by = ?
          WHERE id = ?`,
      ).run(occurredAt, occurredAt, input.actorWorkerId, moneyAccount.id);
    }
    db.prepare(
      `INSERT INTO financial_cutovers (
         id, location_id, cutover_date, status, opening_journal_entry_id,
         activated_at, activated_by, notes,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      cutoverId, preview.locationId, input.cutoverDate, openingJournalEntryId,
      new Date().toISOString(), input.actorWorkerId, input.notes?.trim() || null,
      input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
    db.prepare(
      `UPDATE management_ledger_settings
          SET shadow_enabled = 0, updated_at = ?, updated_by = ?, device_id = ?
        WHERE location_id = ?`,
    ).run(new Date().toISOString(), input.actorWorkerId, input.deviceId, preview.locationId);
    logAudit(db, {
      workerId: input.actorWorkerId,
      action: 'FINANCIAL_CUTOVER_ACTIVATED',
      entityType: 'financial_cutovers',
      entityId: cutoverId,
      afterValue: {
        locationId: preview.locationId,
        cutoverDate: input.cutoverDate,
        openingJournalEntryId,
        openingEquityPesewas: preview.openingEquityPesewas,
      },
      deviceId: input.deviceId,
    });
  })();
  return { cutoverId, openingJournalEntryId, openingEquityPesewas: preview.openingEquityPesewas };
}

// --- Structured operating records ----------------------------------------

export function createBusinessExpense(
  db: DB,
  input: {
    locationId?: string;
    category: string;
    payee?: string | null;
    incurredDate: string;
    dueDate?: string | null;
    amountPesewas: number;
    fixedOrVariable?: 'FIXED' | 'VARIABLE';
    financialAccountId?: string | null;
    paidAt?: string | null;
    paymentReference?: string | null;
    photoUrl?: string | null;
    notes?: string | null;
    actorWorkerId: string;
    deviceId: string;
  },
): { businessExpenseId: string; paymentId: string | null } {
  requireOwnerFounder(db, input.actorWorkerId);
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  assertDateOnly('incurredDate', input.incurredDate);
  if (input.dueDate) assertDateOnly('dueDate', input.dueDate);
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('expense amount must be positive integer pesewas');
  }
  const expenseAccount = EXPENSE_ACCOUNT_BY_CATEGORY[input.category];
  if (!expenseAccount) throw new Error(`unknown management expense category ${input.category}`);
  const immediate = !!input.financialAccountId;
  const expenseId = `bexp-${uuidv4()}`;
  let paymentId: string | null = null;
  db.transaction(() => {
    const journalEntryId = isLedgerActive(db, locationId)
      ? postJournal(db, {
          locationId,
          businessDate: input.incurredDate,
          occurredAt: `${input.incurredDate}T12:00:00.000Z`,
          sourceType: 'BUSINESS_EXPENSE',
          sourceId: expenseId,
          postingType: 'EXPENSE_RECOGNITION',
          description: `${input.category} expense${input.payee ? ` - ${input.payee}` : ''}`,
          actorWorkerId: input.actorWorkerId,
          deviceId: input.deviceId,
          lines: [
            { accountCode: expenseAccount, debitPesewas: input.amountPesewas },
            immediate
              ? {
                  ledgerAccountId: financialAccount(db, input.financialAccountId!).ledgerAccountId,
                  creditPesewas: input.amountPesewas,
                }
              : { accountCode: LEDGER_CODES.AP_BILLS, creditPesewas: input.amountPesewas },
          ],
        }).journalEntryId
      : null;
    db.prepare(
      `INSERT INTO business_expenses (
         id, location_id, category, payee, incurred_date, due_date, amount_pesewas,
         payment_status, total_paid_pesewas, fixed_or_variable, photo_url, notes,
         journal_entry_id, created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      expenseId, locationId, input.category, input.payee?.trim() || null,
      input.incurredDate, input.dueDate ?? null, input.amountPesewas,
      immediate ? 'PAID' : 'UNPAID', immediate ? input.amountPesewas : 0,
      input.fixedOrVariable ?? (input.category === 'RENT' || input.category === 'STAFF_WAGES' ? 'FIXED' : 'VARIABLE'),
      input.photoUrl ?? null, input.notes?.trim() || null, journalEntryId,
      input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
    if (immediate) {
      paymentId = `epay-${uuidv4()}`;
      db.prepare(
        `INSERT INTO expense_payments (
           id, business_expense_id, financial_account_id, amount_pesewas,
           paid_at, payment_reference, notes, journal_entry_id,
           created_by, device_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        paymentId, expenseId, input.financialAccountId, input.amountPesewas,
        input.paidAt ?? new Date().toISOString(), input.paymentReference?.trim() || null,
        input.notes?.trim() || null, journalEntryId, input.actorWorkerId, input.deviceId,
      );
    } else {
      createObligationRow(db, {
        locationId,
        obligationType: 'OPERATING_BILL',
        sourceType: 'BUSINESS_EXPENSE',
        sourceId: expenseId,
        creditorName: input.payee?.trim() || input.category,
        issueDate: input.incurredDate,
        dueDate: input.dueDate ?? null,
        principalPesewas: input.amountPesewas,
        interestPesewas: 0,
        actorWorkerId: input.actorWorkerId,
        deviceId: input.deviceId,
      });
    }
  })();
  return { businessExpenseId: expenseId, paymentId };
}

function createObligationRow(
  db: DB,
  input: {
    locationId: string;
    obligationType: string;
    sourceType: string;
    sourceId: string;
    creditorName: string;
    issueDate: string;
    dueDate: string | null;
    principalPesewas: number;
    interestPesewas: number;
    liabilityAgreementId?: string | null;
    notes?: string | null;
    actorWorkerId: string;
    deviceId: string;
  },
): string {
  const existing = db.prepare(
    `SELECT id FROM obligations
      WHERE location_id = ? AND source_type = ? AND source_id = ?`,
  ).get(input.locationId, input.sourceType, input.sourceId) as { id: string } | undefined;
  if (existing) return existing.id;
  const id = `obl-${uuidv4()}`;
  db.prepare(
    `INSERT INTO obligations (
       id, location_id, obligation_type, source_type, source_id, creditor_name,
       issue_date, due_date, principal_pesewas, interest_pesewas,
       liability_agreement_id, notes, created_by, updated_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, input.locationId, input.obligationType, input.sourceType, input.sourceId,
    input.creditorName, input.issueDate, input.dueDate, input.principalPesewas,
    input.interestPesewas, input.liabilityAgreementId ?? null, input.notes?.trim() || null,
    input.actorWorkerId, input.actorWorkerId, input.deviceId,
  );
  return id;
}

export function createLiabilityAgreement(
  db: DB,
  input: {
    locationId?: string;
    kind: 'BANK_LOAN' | 'OWNER_LOAN' | 'LEASE' | 'OTHER';
    creditorName: string;
    originalPrincipalPesewas: number;
    receivedFinancialAccountId?: string | null;
    startDate: string;
    endDate?: string | null;
    schedule: Array<{
      dueDate: string;
      principalPesewas: number;
      interestPesewas?: number;
    }>;
    notes?: string | null;
    actorWorkerId: string;
    deviceId: string;
  },
): { liabilityAgreementId: string; obligationIds: string[] } {
  requireOwnerFounder(db, input.actorWorkerId);
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  assertDateOnly('startDate', input.startDate);
  if (!input.creditorName.trim()) throw new Error('creditor name is required');
  if (!Number.isInteger(input.originalPrincipalPesewas) || input.originalPrincipalPesewas <= 0) {
    throw new Error('loan principal must be positive integer pesewas');
  }
  const schedulePrincipal = input.schedule.reduce((sum, row) => {
    assertDateOnly('installment dueDate', row.dueDate);
    if (!Number.isInteger(row.principalPesewas) || row.principalPesewas < 0
      || !Number.isInteger(row.interestPesewas ?? 0) || (row.interestPesewas ?? 0) < 0
      || row.principalPesewas + (row.interestPesewas ?? 0) <= 0) {
      throw new Error('invalid installment amounts');
    }
    return sum + row.principalPesewas;
  }, 0);
  if (schedulePrincipal !== input.originalPrincipalPesewas) {
    throw new Error(`installment principal ${schedulePrincipal} does not equal loan principal ${input.originalPrincipalPesewas}`);
  }
  const agreementId = `lag-${uuidv4()}`;
  const obligationIds: string[] = [];
  db.transaction(() => {
    const journalEntryId = input.receivedFinancialAccountId && isLedgerActive(db, locationId)
      ? postJournal(db, {
          locationId,
          businessDate: input.startDate,
          occurredAt: `${input.startDate}T12:00:00.000Z`,
          sourceType: 'LIABILITY_AGREEMENT',
          sourceId: agreementId,
          postingType: 'LOAN_RECEIPT',
          description: `${input.kind} from ${input.creditorName.trim()}`,
          actorWorkerId: input.actorWorkerId,
          deviceId: input.deviceId,
          lines: [
            {
              ledgerAccountId: financialAccount(db, input.receivedFinancialAccountId).ledgerAccountId,
              debitPesewas: input.originalPrincipalPesewas,
            },
            { accountCode: LEDGER_CODES.LOANS_PAYABLE, creditPesewas: input.originalPrincipalPesewas },
          ],
        }).journalEntryId
      : null;
    db.prepare(
      `INSERT INTO liability_agreements (
         id, location_id, kind, creditor_name, original_principal_pesewas,
         received_financial_account_id, start_date, end_date, notes, journal_entry_id,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      agreementId, locationId, input.kind, input.creditorName.trim(),
      input.originalPrincipalPesewas, input.receivedFinancialAccountId ?? null,
      input.startDate, input.endDate ?? null, input.notes?.trim() || null,
      journalEntryId, input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
    input.schedule.forEach((row, index) => {
      obligationIds.push(createObligationRow(db, {
        locationId,
        obligationType: input.kind === 'OWNER_LOAN' ? 'OWNER_LOAN_INSTALLMENT' : 'LOAN_INSTALLMENT',
        sourceType: 'LIABILITY_INSTALLMENT',
        sourceId: `${agreementId}:${index + 1}`,
        creditorName: input.creditorName.trim(),
        issueDate: input.startDate,
        dueDate: row.dueDate,
        principalPesewas: row.principalPesewas,
        interestPesewas: row.interestPesewas ?? 0,
        liabilityAgreementId: agreementId,
        actorWorkerId: input.actorWorkerId,
        deviceId: input.deviceId,
      }));
    });
  })();
  return { liabilityAgreementId: agreementId, obligationIds };
}

export function payObligation(
  db: DB,
  input: {
    obligationId: string;
    financialAccountId: string;
    amountPesewas: number;
    paidAt?: string;
    reference?: string | null;
    notes?: string | null;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): {
  allocationId: string;
  journalEntryId: string | null;
  principalPesewas: number;
  interestPesewas: number;
  outstandingPesewas: number;
} {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  if (!Number.isInteger(input.amountPesewas) || input.amountPesewas <= 0) {
    throw new Error('obligation payment must be positive integer pesewas');
  }
  const obligation = db.prepare(
    `SELECT id, location_id AS locationId, obligation_type AS obligationType,
            source_type AS sourceType, source_id AS sourceId,
            creditor_name AS creditorName, principal_pesewas AS principalPesewas,
            interest_pesewas AS interestPesewas,
            total_paid_pesewas AS totalPaidPesewas, status
       FROM obligations WHERE id = ?`,
  ).get(input.obligationId) as {
    id: string; locationId: string; obligationType: string; sourceType: string;
    sourceId: string; creditorName: string; principalPesewas: number;
    interestPesewas: number; totalPaidPesewas: number; status: string;
  } | undefined;
  if (!obligation || obligation.status === 'PAID' || obligation.status === 'VOID') {
    throw new Error('obligation is not open for payment');
  }
  const outstanding = obligation.principalPesewas + obligation.interestPesewas
    - obligation.totalPaidPesewas;
  if (input.amountPesewas > outstanding) throw new Error('payment exceeds obligation outstanding');
  const paidComponents = db.prepare(
    `SELECT COALESCE(SUM(principal_pesewas), 0) AS principalPaid,
            COALESCE(SUM(interest_pesewas), 0) AS interestPaid
       FROM obligation_allocations WHERE obligation_id = ?`,
  ).get(obligation.id) as { principalPaid: number; interestPaid: number };
  const interestRemaining = Math.max(0, obligation.interestPesewas - paidComponents.interestPaid);
  const interest = Math.min(input.amountPesewas, interestRemaining);
  const principal = input.amountPesewas - interest;
  const account = financialAccount(db, input.financialAccountId);
  if (account.locationId !== obligation.locationId) throw new Error('payment account belongs to another location');
  const paidAt = input.paidAt ?? new Date().toISOString();
  const allocationId = `oa-${uuidv4()}`;
  let journalEntryId: string | null = null;
  db.transaction(() => {
    if (isLedgerActive(db, obligation.locationId)) {
      const debitLines: JournalLineInput[] = [];
      if (principal > 0) {
        debitLines.push({
          accountCode: obligation.obligationType === 'SUPPLIER_INVOICE'
            ? LEDGER_CODES.AP_TRADE
            : obligation.obligationType === 'OPERATING_BILL'
              ? LEDGER_CODES.AP_BILLS
              : obligation.obligationType === 'TAX'
                ? LEDGER_CODES.TAX_PAYABLE
                : LEDGER_CODES.LOANS_PAYABLE,
          debitPesewas: principal,
          counterpartyType: 'CREDITOR',
          counterpartyId: obligation.creditorName,
        });
      }
      if (interest > 0) {
        debitLines.push({
          accountCode: LEDGER_CODES.INTEREST_EXPENSE,
          debitPesewas: interest,
          counterpartyType: 'CREDITOR',
          counterpartyId: obligation.creditorName,
        });
      }
      journalEntryId = postJournal(db, {
        locationId: obligation.locationId,
        businessDate: businessDate(paidAt),
        occurredAt: paidAt,
        sourceType: 'OBLIGATION_PAYMENT',
        sourceId: allocationId,
        postingType: 'OBLIGATION_PAYMENT',
        description: `Payment to ${obligation.creditorName}`,
        actorWorkerId: input.actorWorkerId,
        deviceId: input.deviceId,
        lines: [
          ...debitLines,
          { ledgerAccountId: account.ledgerAccountId, creditPesewas: input.amountPesewas },
        ],
      }).journalEntryId;
    }
    db.prepare(
      `INSERT INTO obligation_allocations (
         id, obligation_id, payment_source_type, payment_source_id,
         financial_account_id, principal_pesewas, interest_pesewas,
         paid_at, journal_entry_id, created_by, device_id
       ) VALUES (?, ?, 'MANAGEMENT_PAYMENT', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      allocationId, obligation.id, allocationId, account.id,
      principal, interest, paidAt, journalEntryId, input.actorWorkerId, input.deviceId,
    );
    const newPaid = obligation.totalPaidPesewas + input.amountPesewas;
    db.prepare(
      `UPDATE obligations
          SET total_paid_pesewas = ?,
              status = CASE WHEN ? >= principal_pesewas + interest_pesewas
                            THEN 'PAID' ELSE 'PARTIALLY_PAID' END,
              updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(newPaid, newPaid, new Date().toISOString(), input.actorWorkerId, obligation.id);
    if (obligation.sourceType === 'BUSINESS_EXPENSE') {
      db.prepare(
        `UPDATE business_expenses
            SET total_paid_pesewas = MIN(amount_pesewas, total_paid_pesewas + ?),
                payment_status = CASE WHEN total_paid_pesewas + ? >= amount_pesewas
                                      THEN 'PAID' ELSE 'PARTIALLY_PAID' END,
                updated_at = ?, updated_by = ?
          WHERE id = ?`,
      ).run(
        input.amountPesewas, input.amountPesewas,
        new Date().toISOString(), input.actorWorkerId, obligation.sourceId,
      );
      db.prepare(
        `INSERT INTO expense_payments (
           id, business_expense_id, financial_account_id, amount_pesewas,
           paid_at, payment_reference, notes, journal_entry_id, created_by, device_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `epay-${uuidv4()}`, obligation.sourceId, account.id, input.amountPesewas,
        paidAt, input.reference?.trim() || null, input.notes?.trim() || null,
        journalEntryId, input.actorWorkerId, input.deviceId,
      );
    }
    logAudit(db, {
      workerId: input.actorWorkerId,
      action: 'OBLIGATION_PAYMENT_RECORDED',
      entityType: 'obligations',
      entityId: obligation.id,
      afterValue: {
        amountPesewas: input.amountPesewas,
        principalPesewas: principal,
        interestPesewas: interest,
        financialAccountId: account.id,
        reference: input.reference?.trim() || null,
      },
      deviceId: input.deviceId,
    });
  })();
  return {
    allocationId,
    journalEntryId,
    principalPesewas: principal,
    interestPesewas: interest,
    outstandingPesewas: outstanding - input.amountPesewas,
  };
}

export function updateObligation(
  db: DB,
  input: {
    obligationId: string;
    dueDate: string;
    disputed: boolean;
    notes?: string | null;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): void {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  assertDateOnly('dueDate', input.dueDate);
  const obligation = db.prepare(
    `SELECT id, issue_date AS issueDate, status, principal_pesewas AS principalPesewas,
            interest_pesewas AS interestPesewas, total_paid_pesewas AS totalPaidPesewas,
            due_date AS dueDate, notes
       FROM obligations WHERE id = ?`,
  ).get(input.obligationId) as {
    id: string; issueDate: string; status: string; principalPesewas: number;
    interestPesewas: number; totalPaidPesewas: number; dueDate: string | null; notes: string | null;
  } | undefined;
  if (!obligation || obligation.status === 'VOID' || obligation.status === 'PAID') {
    throw new Error('only open obligations can be maintained');
  }
  if (input.dueDate < obligation.issueDate) throw new Error('due date cannot precede the issue date');
  const total = obligation.principalPesewas + obligation.interestPesewas;
  const nextStatus = input.disputed
    ? 'DISPUTED'
    : obligation.totalPaidPesewas > 0 && obligation.totalPaidPesewas < total
      ? 'PARTIALLY_PAID'
      : 'OPEN';
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE obligations
        SET due_date = ?, status = ?, notes = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
  ).run(
    input.dueDate, nextStatus, input.notes?.trim() || null,
    now, input.actorWorkerId, obligation.id,
  );
  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'OBLIGATION_UPDATED',
    entityType: 'obligations',
    entityId: obligation.id,
    beforeValue: { dueDate: obligation.dueDate, status: obligation.status, notes: obligation.notes },
    afterValue: { dueDate: input.dueDate, status: nextStatus, notes: input.notes?.trim() || null },
    deviceId: input.deviceId,
  });
}

export function registerFixedAsset(
  db: DB,
  input: {
    locationId?: string;
    name: string;
    assetClass: string;
    acquiredDate: string;
    costPesewas: number;
    residualValuePesewas?: number;
    usefulLifeMonths?: number | null;
    sourceFinancialAccountId?: string | null;
    vendorName?: string | null;
    dueDate?: string | null;
    notes?: string | null;
    actorWorkerId: string;
    deviceId: string;
  },
): { fixedAssetId: string; journalEntryId: string | null } {
  requireOwnerFounder(db, input.actorWorkerId);
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  assertDateOnly('acquiredDate', input.acquiredDate);
  if (!input.name.trim() || !input.assetClass.trim()) throw new Error('asset name and class are required');
  if (!Number.isInteger(input.costPesewas) || input.costPesewas <= 0) throw new Error('asset cost must be positive');
  if (input.dueDate) assertDateOnly('dueDate', input.dueDate);
  if (!input.sourceFinancialAccountId && !input.dueDate) {
    throw new Error('an unpaid fixed asset requires a due date');
  }
  const residual = input.residualValuePesewas ?? 0;
  if (!Number.isInteger(residual) || residual < 0 || residual > input.costPesewas) {
    throw new Error('invalid residual value');
  }
  const fixedAssetId = `asset-${uuidv4()}`;
  let journalEntryId: string | null = null;
  db.transaction(() => {
    if (isLedgerActive(db, locationId)) {
      const creditLine: JournalLineInput = input.sourceFinancialAccountId
        ? {
            ledgerAccountId: financialAccount(db, input.sourceFinancialAccountId).ledgerAccountId,
            creditPesewas: input.costPesewas,
          }
        : { accountCode: LEDGER_CODES.AP_BILLS, creditPesewas: input.costPesewas };
      journalEntryId = postJournal(db, {
        locationId,
        businessDate: input.acquiredDate,
        occurredAt: `${input.acquiredDate}T12:00:00.000Z`,
        sourceType: 'FIXED_ASSET',
        sourceId: fixedAssetId,
        postingType: 'ASSET_ACQUISITION',
        description: `Acquire ${input.name.trim()}`,
        actorWorkerId: input.actorWorkerId,
        deviceId: input.deviceId,
        lines: [
          { accountCode: LEDGER_CODES.FIXED_ASSETS, debitPesewas: input.costPesewas },
          creditLine,
        ],
      }).journalEntryId;
    }
    db.prepare(
      `INSERT INTO fixed_assets (
         id, location_id, name, asset_class, acquired_date, cost_pesewas,
         residual_value_pesewas, useful_life_months, source_financial_account_id,
         notes, acquisition_journal_entry_id, created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fixedAssetId, locationId, input.name.trim(), input.assetClass.trim(),
      input.acquiredDate, input.costPesewas, residual, input.usefulLifeMonths ?? null,
      input.sourceFinancialAccountId ?? null, input.notes?.trim() || null,
      journalEntryId, input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
    if (!input.sourceFinancialAccountId) {
      createObligationRow(db, {
        locationId,
        obligationType: 'OPERATING_BILL',
        sourceType: 'FIXED_ASSET',
        sourceId: fixedAssetId,
        creditorName: input.vendorName?.trim() || input.name.trim(),
        issueDate: input.acquiredDate,
        dueDate: input.dueDate ?? null,
        principalPesewas: input.costPesewas,
        interestPesewas: 0,
        notes: `Fixed asset acquisition: ${input.name.trim()}`,
        actorWorkerId: input.actorWorkerId,
        deviceId: input.deviceId,
      });
    }
  })();
  return { fixedAssetId, journalEntryId };
}

export interface FixedAssetRow {
  id: string;
  locationId: string;
  name: string;
  assetClass: string;
  acquiredDate: string;
  costPesewas: number;
  residualValuePesewas: number;
  usefulLifeMonths: number | null;
  accumulatedDepreciationPesewas: number;
  carryingValuePesewas: number;
  disposedAt: string | null;
  disposalProceedsPesewas: number | null;
  notes: string | null;
}

export function listFixedAssets(
  db: DB,
  locationId = DEFAULT_LOCATION_ID,
  includeDisposed = true,
): FixedAssetRow[] {
  return db.prepare(
    `SELECT id, location_id AS locationId, name, asset_class AS assetClass,
            acquired_date AS acquiredDate, cost_pesewas AS costPesewas,
            residual_value_pesewas AS residualValuePesewas,
            useful_life_months AS usefulLifeMonths,
            accumulated_depreciation_pesewas AS accumulatedDepreciationPesewas,
            cost_pesewas - accumulated_depreciation_pesewas AS carryingValuePesewas,
            disposed_at AS disposedAt, disposal_proceeds_pesewas AS disposalProceedsPesewas,
            notes
       FROM fixed_assets
      WHERE location_id = ? AND (? = 1 OR disposed_at IS NULL)
      ORDER BY acquired_date, name`,
  ).all(locationId, includeDisposed ? 1 : 0) as FixedAssetRow[];
}

function fixedAssetById(db: DB, fixedAssetId: string): FixedAssetRow | undefined {
  return db.prepare(
    `SELECT id, location_id AS locationId, name, asset_class AS assetClass,
            acquired_date AS acquiredDate, cost_pesewas AS costPesewas,
            residual_value_pesewas AS residualValuePesewas,
            useful_life_months AS usefulLifeMonths,
            accumulated_depreciation_pesewas AS accumulatedDepreciationPesewas,
            cost_pesewas - accumulated_depreciation_pesewas AS carryingValuePesewas,
            disposed_at AS disposedAt, disposal_proceeds_pesewas AS disposalProceedsPesewas,
            notes
       FROM fixed_assets WHERE id = ?`,
  ).get(fixedAssetId) as FixedAssetRow | undefined;
}

function monthsThrough(acquiredDate: string, throughDate: string): number {
  const acquired = new Date(`${acquiredDate.slice(0, 7)}-01T00:00:00.000Z`);
  const through = new Date(`${throughDate.slice(0, 7)}-01T00:00:00.000Z`);
  return Math.max(0,
    (through.getUTCFullYear() - acquired.getUTCFullYear()) * 12
      + through.getUTCMonth() - acquired.getUTCMonth() + 1);
}

export function depreciateFixedAsset(
  db: DB,
  input: {
    fixedAssetId: string;
    throughDate: string;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): { journalEntryId: string; depreciationPesewas: number; accumulatedDepreciationPesewas: number } {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  assertDateOnly('throughDate', input.throughDate);
  const asset = fixedAssetById(db, input.fixedAssetId);
  if (!asset) throw new Error('fixed asset not found');
  if (asset.disposedAt) throw new Error('disposed assets cannot be depreciated');
  if (!asset.usefulLifeMonths) throw new Error('set a useful life before posting depreciation');
  if (input.throughDate < asset.acquiredDate) throw new Error('depreciation date cannot precede acquisition');
  const sourceId = `${asset.id}:${input.throughDate}`;
  const existing = db.prepare(
    `SELECT je.id AS journalEntryId,
            COALESCE(SUM(CASE WHEN la.code = ? THEN jl.debit_pesewas ELSE 0 END), 0) AS amount
       FROM journal_entries je
       JOIN journal_lines jl ON jl.journal_entry_id = je.id
       JOIN ledger_accounts la ON la.id = jl.ledger_account_id
      WHERE je.location_id = ? AND je.source_type = 'FIXED_ASSET'
        AND je.source_id = ? AND je.posting_type = 'ASSET_DEPRECIATION'
        AND je.status = 'POSTED'
      GROUP BY je.id`,
  ).get(LEDGER_CODES.DEPRECIATION_EXPENSE, asset.locationId, sourceId) as {
    journalEntryId: string; amount: number;
  } | undefined;
  if (existing) {
    return {
      journalEntryId: existing.journalEntryId,
      depreciationPesewas: existing.amount,
      accumulatedDepreciationPesewas: asset.accumulatedDepreciationPesewas,
    };
  }
  const depreciable = asset.costPesewas - asset.residualValuePesewas;
  const elapsed = Math.min(asset.usefulLifeMonths, monthsThrough(asset.acquiredDate, input.throughDate));
  const targetAccumulated = Math.round((depreciable * elapsed) / asset.usefulLifeMonths);
  const amount = targetAccumulated - asset.accumulatedDepreciationPesewas;
  if (amount <= 0) throw new Error('no additional straight-line depreciation is due through this date');
  let journalEntryId = '';
  db.transaction(() => {
    journalEntryId = postJournal(db, {
      locationId: asset.locationId,
      businessDate: input.throughDate,
      occurredAt: `${input.throughDate}T12:00:00.000Z`,
      sourceType: 'FIXED_ASSET',
      sourceId,
      postingType: 'ASSET_DEPRECIATION',
      description: `Straight-line depreciation through ${input.throughDate}: ${asset.name}`,
      actorWorkerId: input.actorWorkerId,
      deviceId: input.deviceId,
      lines: [
        { accountCode: LEDGER_CODES.DEPRECIATION_EXPENSE, debitPesewas: amount },
        { accountCode: LEDGER_CODES.ACCUM_DEPRECIATION, creditPesewas: amount },
      ],
    }).journalEntryId;
    db.prepare(
      `UPDATE fixed_assets
          SET accumulated_depreciation_pesewas = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(targetAccumulated, new Date().toISOString(), input.actorWorkerId, asset.id);
    logAudit(db, {
      workerId: input.actorWorkerId,
      action: 'FIXED_ASSET_DEPRECIATED',
      entityType: 'fixed_assets', entityId: asset.id,
      afterValue: { throughDate: input.throughDate, amountPesewas: amount, targetAccumulated },
      deviceId: input.deviceId,
    });
  })();
  return { journalEntryId, depreciationPesewas: amount, accumulatedDepreciationPesewas: targetAccumulated };
}

export function disposeFixedAsset(
  db: DB,
  input: {
    fixedAssetId: string;
    disposedDate: string;
    proceedsPesewas: number;
    receivingFinancialAccountId?: string | null;
    notes?: string | null;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): { journalEntryId: string; gainLossPesewas: number } {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  assertDateOnly('disposedDate', input.disposedDate);
  if (!Number.isInteger(input.proceedsPesewas) || input.proceedsPesewas < 0) {
    throw new Error('disposal proceeds must be non-negative integer pesewas');
  }
  const asset = fixedAssetById(db, input.fixedAssetId);
  if (!asset) throw new Error('fixed asset not found');
  if (asset.disposedAt) throw new Error('fixed asset is already disposed');
  if (input.disposedDate < asset.acquiredDate) throw new Error('disposal date cannot precede acquisition');
  if (input.proceedsPesewas > 0 && !input.receivingFinancialAccountId) {
    throw new Error('select the account receiving disposal proceeds');
  }
  const receiving = input.receivingFinancialAccountId
    ? financialAccount(db, input.receivingFinancialAccountId)
    : null;
  if (receiving && receiving.locationId !== asset.locationId) {
    throw new Error('receiving account belongs to another location');
  }
  const carrying = asset.carryingValuePesewas;
  const gainLoss = input.proceedsPesewas - carrying;
  const lines: JournalLineInput[] = [];
  if (asset.accumulatedDepreciationPesewas > 0) {
    lines.push({ accountCode: LEDGER_CODES.ACCUM_DEPRECIATION, debitPesewas: asset.accumulatedDepreciationPesewas });
  }
  if (input.proceedsPesewas > 0 && receiving) {
    lines.push({ ledgerAccountId: receiving.ledgerAccountId, debitPesewas: input.proceedsPesewas });
  }
  if (gainLoss < 0) lines.push({ accountCode: LEDGER_CODES.LOSS_ASSET_DISPOSAL, debitPesewas: Math.abs(gainLoss) });
  lines.push({ accountCode: LEDGER_CODES.FIXED_ASSETS, creditPesewas: asset.costPesewas });
  if (gainLoss > 0) lines.push({ accountCode: LEDGER_CODES.GAIN_ASSET_DISPOSAL, creditPesewas: gainLoss });
  let journalEntryId = '';
  db.transaction(() => {
    journalEntryId = postJournal(db, {
      locationId: asset.locationId,
      businessDate: input.disposedDate,
      occurredAt: `${input.disposedDate}T12:00:00.000Z`,
      sourceType: 'FIXED_ASSET', sourceId: asset.id,
      postingType: 'ASSET_DISPOSAL',
      description: `Dispose ${asset.name}`,
      actorWorkerId: input.actorWorkerId, deviceId: input.deviceId, lines,
    }).journalEntryId;
    db.prepare(
      `UPDATE fixed_assets
          SET disposed_at = ?, disposal_proceeds_pesewas = ?, notes = COALESCE(?, notes),
              updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(
      `${input.disposedDate}T12:00:00.000Z`, input.proceedsPesewas,
      input.notes?.trim() || null, new Date().toISOString(), input.actorWorkerId, asset.id,
    );
    logAudit(db, {
      workerId: input.actorWorkerId,
      action: 'FIXED_ASSET_DISPOSED', entityType: 'fixed_assets', entityId: asset.id,
      afterValue: { disposedDate: input.disposedDate, proceedsPesewas: input.proceedsPesewas, gainLossPesewas: gainLoss },
      deviceId: input.deviceId,
    });
  })();
  return { journalEntryId, gainLossPesewas: gainLoss };
}

// --- Operational posting helpers -----------------------------------------

export function postSaleIfActive(
  db: DB,
  saleId: string,
  actorWorkerId: string,
  deviceId: string,
): string | null {
  const sale = db.prepare(
    `SELECT id, location_id AS locationId, created_at AS createdAt,
            total_pesewas AS totalPesewas,
            vat_pesewas AS vatPesewas, nhil_pesewas AS nhilPesewas,
            getfund_pesewas AS getfundPesewas, voided
       FROM sales WHERE id = ?`,
  ).get(saleId) as {
    id: string; locationId: string; createdAt: string; totalPesewas: number;
    vatPesewas: number; nhilPesewas: number; getfundPesewas: number; voided: number;
  } | undefined;
  if (!sale || sale.voided === 1 || !isLedgerPostingEnabled(db, sale.locationId)) return null;
  const tax = sale.vatPesewas + sale.nhilPesewas + sale.getfundPesewas;
  const netSales = sale.totalPesewas - tax;
  const payments = db.prepare(
    `SELECT payment_method AS method, amount_pesewas AS amountPesewas
       FROM sale_payments WHERE sale_id = ?`,
  ).all(saleId) as Array<{ method: string; amountPesewas: number }>;
  const cogs = (db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN line_cogs_pesewas > 0
                             THEN line_cogs_pesewas
                             ELSE unit_cost_pesewas * quantity END), 0) AS total
       FROM sale_lines WHERE sale_id = ?`,
  ).get(saleId) as { total: number }).total;
  const lines: JournalLineInput[] = payments.map((payment) => {
    if (payment.method === 'CREDIT') {
      return {
        accountCode: LEDGER_CODES.AR,
        debitPesewas: payment.amountPesewas,
        counterpartyType: 'CUSTOMER',
      };
    }
    return {
      ledgerAccountId: mappedFinancialAccount(db, sale.locationId, payment.method, 'IN').ledgerAccountId,
      debitPesewas: payment.amountPesewas,
    };
  });
  if (netSales > 0) lines.push({ accountCode: LEDGER_CODES.SALES_NET, creditPesewas: netSales });
  if (tax > 0) lines.push({ accountCode: LEDGER_CODES.TAX_PAYABLE, creditPesewas: tax });
  if (cogs > 0) {
    lines.push({ accountCode: LEDGER_CODES.COGS, debitPesewas: cogs });
    lines.push({ accountCode: LEDGER_CODES.INVENTORY, creditPesewas: cogs });
  }
  return postJournal(db, {
    locationId: sale.locationId,
    businessDate: businessDate(sale.createdAt),
    occurredAt: sale.createdAt,
    sourceType: 'SALE',
    sourceId: sale.id,
    postingType: 'SALE_COMPLETE',
    description: `Sale ${sale.id}`,
    actorWorkerId,
    deviceId,
    lines,
  }).journalEntryId;
}

export function reverseSaleJournalIfActive(
  db: DB,
  saleId: string,
  voidId: string,
  reason: string,
  actorWorkerId: string,
  deviceId: string,
): string | null {
  const original = db.prepare(
    `SELECT id, location_id AS locationId
       FROM journal_entries
      WHERE source_type = 'SALE' AND source_id = ?
        AND posting_type = 'SALE_COMPLETE' AND status = 'POSTED'`,
  ).get(saleId) as { id: string; locationId: string } | undefined;
  if (!original || !isLedgerPostingEnabled(db, original.locationId)) return null;
  const now = new Date().toISOString();
  const rows = db.prepare(
    `SELECT ledger_account_id AS ledgerAccountId,
            debit_pesewas AS debitPesewas, credit_pesewas AS creditPesewas,
            memo, counterparty_type AS counterpartyType, counterparty_id AS counterpartyId
       FROM journal_lines WHERE journal_entry_id = ?`,
  ).all(original.id) as Array<{
    ledgerAccountId: string; debitPesewas: number; creditPesewas: number;
    memo: string | null; counterpartyType: string | null; counterpartyId: string | null;
  }>;
  return postJournal(db, {
    locationId: original.locationId,
    businessDate: businessDate(now),
    occurredAt: now,
    sourceType: 'SALE_VOID',
    sourceId: voidId,
    postingType: 'SALE_REVERSAL',
    description: `Void sale ${saleId}: ${reason}`,
    reversalOfId: original.id,
    actorWorkerId,
    deviceId,
    lines: rows.map((row) => ({
      ledgerAccountId: row.ledgerAccountId,
      debitPesewas: row.creditPesewas,
      creditPesewas: row.debitPesewas,
      memo: row.memo,
      counterpartyType: row.counterpartyType,
      counterpartyId: row.counterpartyId,
    })),
  }).journalEntryId;
}

export function postCustomerPaymentIfActive(
  db: DB,
  customerPaymentId: string,
  actorWorkerId: string,
  deviceId: string,
): string | null {
  const row = db.prepare(
    `SELECT cp.id, cp.amount_pesewas AS amountPesewas,
            cp.payment_method AS paymentMethod, cp.received_at AS occurredAt,
            cp.customer_id AS customerId,
            COALESCE(s.location_id, ?) AS locationId
       FROM customer_payments cp
       LEFT JOIN shifts s ON s.id = cp.shift_id
      WHERE cp.id = ?`,
  ).get(DEFAULT_LOCATION_ID, customerPaymentId) as {
    id: string; amountPesewas: number; paymentMethod: string; occurredAt: string;
    customerId: string; locationId: string;
  } | undefined;
  if (!row || row.paymentMethod === 'RETURN_CREDIT' || !isLedgerPostingEnabled(db, row.locationId)) return null;
  const allocated = (db.prepare(
    `SELECT COALESCE(SUM(amount_pesewas), 0) AS total
       FROM customer_payment_allocations
      WHERE customer_payment_id = ?`,
  ).get(row.id) as { total: number }).total;
  const customerCredit = Math.max(0, row.amountPesewas - allocated);
  const mapped = mappedFinancialAccount(db, row.locationId, row.paymentMethod, 'IN');
  db.prepare(
    'UPDATE customer_payments SET financial_account_id = ?, updated_at = ? WHERE id = ?',
  ).run(mapped.financialAccountId, new Date().toISOString(), row.id);
  return postJournal(db, {
    locationId: row.locationId,
    businessDate: businessDate(row.occurredAt),
    occurredAt: row.occurredAt,
    sourceType: 'CUSTOMER_PAYMENT',
    sourceId: row.id,
    postingType: 'RECEIVABLE_COLLECTION',
    description: `Customer credit collection ${row.id}`,
    actorWorkerId,
    deviceId,
    lines: [
      { ledgerAccountId: mapped.ledgerAccountId, debitPesewas: row.amountPesewas },
      ...(allocated > 0 ? [{
        accountCode: LEDGER_CODES.AR,
        creditPesewas: allocated,
        counterpartyType: 'CUSTOMER',
        counterpartyId: row.customerId,
      }] : []),
      ...(customerCredit > 0 ? [{
        accountCode: LEDGER_CODES.CUSTOMER_CREDITS,
        creditPesewas: customerCredit,
        counterpartyType: 'CUSTOMER',
        counterpartyId: row.customerId,
      }] : []),
    ],
  }).journalEntryId;
}

export function postSupplierPaymentIfActive(
  db: DB,
  supplierPaymentId: string,
  actorWorkerId: string,
  deviceId: string,
): string | null {
  const row = db.prepare(
    `SELECT sp.id, sp.amount_pesewas AS amountPesewas,
            sp.payment_method AS paymentMethod, sp.paid_at AS occurredAt,
            sp.supplier_id AS supplierId
       FROM supplier_payments sp WHERE sp.id = ?`,
  ).get(supplierPaymentId) as {
    id: string; amountPesewas: number; paymentMethod: string; occurredAt: string; supplierId: string;
  } | undefined;
  if (!row) return null;
  const allocations = db.prepare(
    `SELECT sipa.supplier_invoice_id AS supplierInvoiceId,
            sipa.amount_pesewas AS amountPesewas,
            o.id AS obligationId
       FROM supplier_invoice_payment_allocations sipa
       LEFT JOIN obligations o
         ON o.location_id = ? AND o.source_type = 'SUPPLIER_INVOICE'
        AND o.source_id = sipa.supplier_invoice_id
      WHERE sipa.supplier_payment_id = ?`,
  ).all(DEFAULT_LOCATION_ID, row.id) as Array<{
    supplierInvoiceId: string; amountPesewas: number; obligationId: string | null;
  }>;
  for (const allocation of allocations) {
    if (!allocation.obligationId) continue;
    db.prepare(
      `INSERT OR IGNORE INTO obligation_allocations (
         id, obligation_id, payment_source_type, payment_source_id,
         principal_pesewas, interest_pesewas, paid_at, created_by, device_id
       ) VALUES (?, ?, 'SUPPLIER_PAYMENT', ?, ?, 0, ?, ?, ?)`,
    ).run(
      `oa-${uuidv4()}`, allocation.obligationId, row.id, allocation.amountPesewas,
      row.occurredAt, actorWorkerId, deviceId,
    );
    db.prepare(
      `UPDATE obligations
          SET total_paid_pesewas = MIN(principal_pesewas + interest_pesewas,
                                      total_paid_pesewas + ?),
              status = CASE
                WHEN total_paid_pesewas + ? >= principal_pesewas + interest_pesewas THEN 'PAID'
                ELSE 'PARTIALLY_PAID'
              END,
              updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(
      allocation.amountPesewas, allocation.amountPesewas,
      new Date().toISOString(), actorWorkerId, allocation.obligationId,
    );
  }
  if (!isLedgerPostingEnabled(db, DEFAULT_LOCATION_ID)) return null;
  const allocatedTotal = allocations.reduce((sum, allocation) => sum + allocation.amountPesewas, 0);
  const advance = Math.max(0, row.amountPesewas - allocatedTotal);
  const mapped = mappedFinancialAccount(db, DEFAULT_LOCATION_ID, row.paymentMethod, 'OUT');
  db.prepare(
    'UPDATE supplier_payments SET financial_account_id = ?, updated_at = ? WHERE id = ?',
  ).run(mapped.financialAccountId, new Date().toISOString(), row.id);
  return postJournal(db, {
    locationId: DEFAULT_LOCATION_ID,
    businessDate: businessDate(row.occurredAt),
    occurredAt: row.occurredAt,
    sourceType: 'SUPPLIER_PAYMENT',
    sourceId: row.id,
    postingType: 'PAYABLE_PAYMENT',
    description: `Supplier payment ${row.id}`,
    actorWorkerId,
    deviceId,
    lines: [
      ...(allocatedTotal > 0 ? [{
        accountCode: LEDGER_CODES.AP_TRADE,
        debitPesewas: allocatedTotal,
        counterpartyType: 'SUPPLIER',
        counterpartyId: row.supplierId,
      }] : []),
      ...(advance > 0 ? [{
        accountCode: LEDGER_CODES.DEPOSITS_PREPAIDS,
        debitPesewas: advance,
        counterpartyType: 'SUPPLIER',
        counterpartyId: row.supplierId,
      }] : []),
      { ledgerAccountId: mapped.ledgerAccountId, creditPesewas: row.amountPesewas },
    ],
  }).journalEntryId;
}

export function postTaxPaymentIfActive(
  db: DB,
  taxPaymentId: string,
  actorWorkerId: string,
  deviceId: string,
): string | null {
  const row = db.prepare(
    `SELECT id, location_id AS locationId, amount_pesewas AS amountPesewas,
            payment_method AS paymentMethod, paid_at AS occurredAt
       FROM tax_payments WHERE id = ?`,
  ).get(taxPaymentId) as {
    id: string; locationId: string; amountPesewas: number; paymentMethod: string; occurredAt: string;
  } | undefined;
  if (!row || !isLedgerPostingEnabled(db, row.locationId)) return null;
  const mapped = mappedFinancialAccount(db, row.locationId, row.paymentMethod, 'OUT');
  db.prepare(
    'UPDATE tax_payments SET financial_account_id = ?, updated_at = ? WHERE id = ?',
  ).run(mapped.financialAccountId, new Date().toISOString(), row.id);
  return postJournal(db, {
    locationId: row.locationId,
    businessDate: businessDate(row.occurredAt),
    occurredAt: row.occurredAt,
    sourceType: 'TAX_PAYMENT',
    sourceId: row.id,
    postingType: 'TAX_PAYMENT',
    description: `Tax payment ${row.id}`,
    actorWorkerId,
    deviceId,
    lines: [
      { accountCode: LEDGER_CODES.TAX_PAYABLE, debitPesewas: row.amountPesewas },
      { ledgerAccountId: mapped.ledgerAccountId, creditPesewas: row.amountPesewas },
    ],
  }).journalEntryId;
}

export function postLegacyExpenseIfActive(
  db: DB,
  expenseId: string,
  actorWorkerId: string,
  deviceId: string,
): string | null {
  const row = db.prepare(
    `SELECT e.id, e.location_id AS locationId, e.shift_id AS shiftId,
            e.amount_pesewas AS amountPesewas, e.category,
            e.payee, e.created_at AS occurredAt,
            sh.financial_account_id AS shiftFinancialAccountId
       FROM petty_cash_expenses e
       JOIN shifts sh ON sh.id = e.shift_id
      WHERE e.id = ?`,
  ).get(expenseId) as {
    id: string; locationId: string; shiftId: string; amountPesewas: number;
    category: string; payee: string | null; occurredAt: string;
    shiftFinancialAccountId: string | null;
  } | undefined;
  if (!row || !isLedgerPostingEnabled(db, row.locationId)) return null;
  const source = row.shiftFinancialAccountId
    ? financialAccount(db, row.shiftFinancialAccountId)
    : mappedFinancialAccount(db, row.locationId, 'CASH', 'OUT');
  return postJournal(db, {
    locationId: row.locationId,
    businessDate: businessDate(row.occurredAt),
    occurredAt: row.occurredAt,
    sourceType: 'PETTY_CASH_EXPENSE',
    sourceId: row.id,
    postingType: 'IMMEDIATE_EXPENSE',
    description: `${row.category} expense${row.payee ? ` - ${row.payee}` : ''}`,
    actorWorkerId,
    deviceId,
    lines: [
      { accountCode: expenseAccountCode(row.category), debitPesewas: row.amountPesewas },
      { ledgerAccountId: source.ledgerAccountId, creditPesewas: row.amountPesewas },
    ],
  }).journalEntryId;
}

export function postOwnerDrawingIfActive(
  db: DB,
  cashCountId: string,
  actorWorkerId: string,
  deviceId: string,
): string | null {
  const row = db.prepare(
    `SELECT cc.id, cc.location_id AS locationId,
            cc.counted_pesewas AS amountPesewas, cc.created_at AS occurredAt,
            od.category, od.beneficiary_name AS beneficiaryName,
            sh.financial_account_id AS shiftFinancialAccountId
       FROM cash_counts cc
       JOIN owner_drawings od ON od.cash_count_id = cc.id
       JOIN shifts sh ON sh.id = cc.shift_id
      WHERE cc.id = ?`,
  ).get(cashCountId) as {
    id: string; locationId: string; amountPesewas: number;
    occurredAt: string; category: string; beneficiaryName: string;
    shiftFinancialAccountId: string | null;
  } | undefined;
  if (!row || !isLedgerPostingEnabled(db, row.locationId)) return null;
  const till = row.shiftFinancialAccountId
    ? financialAccount(db, row.shiftFinancialAccountId)
    : mappedFinancialAccount(db, row.locationId, 'CASH', 'OUT');
  return postJournal(db, {
    locationId: row.locationId,
    businessDate: businessDate(row.occurredAt),
    occurredAt: row.occurredAt,
    sourceType: 'OWNER_DRAWING',
    sourceId: row.id,
    postingType: 'OWNER_DRAWING',
    description: `${row.category} — ${row.beneficiaryName}`,
    actorWorkerId,
    deviceId,
    lines: [
      { accountCode: LEDGER_CODES.OWNER_DRAWINGS, debitPesewas: row.amountPesewas },
      { ledgerAccountId: till.ledgerAccountId, creditPesewas: row.amountPesewas },
    ],
  }).journalEntryId;
}

export function postSupplierInvoiceIfActive(
  db: DB,
  supplierInvoiceId: string,
  locationId: string,
  actorWorkerId: string,
  deviceId: string,
): string | null {
  const row = db.prepare(
    `SELECT si.id, si.invoice_date AS invoiceDate, si.due_date AS dueDate,
            si.total_pesewas AS totalPesewas, si.supplier_id AS supplierId,
            s.name AS supplierName, si.status
       FROM supplier_invoices si
       JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.id = ?`,
  ).get(supplierInvoiceId) as {
    id: string; invoiceDate: string; dueDate: string | null; totalPesewas: number;
    supplierId: string; supplierName: string; status: string;
  } | undefined;
  if (!row || row.status === 'VOID') return null;
  createObligationRow(db, {
    locationId,
    obligationType: 'SUPPLIER_INVOICE',
    sourceType: 'SUPPLIER_INVOICE',
    sourceId: row.id,
    creditorName: row.supplierName,
    issueDate: row.invoiceDate,
    dueDate: row.dueDate,
    principalPesewas: row.totalPesewas,
    interestPesewas: 0,
    actorWorkerId,
    deviceId,
  });
  if (!isLedgerPostingEnabled(db, locationId)) return null;
  return postJournal(db, {
    locationId,
    businessDate: row.invoiceDate,
    occurredAt: `${row.invoiceDate}T12:00:00.000Z`,
    sourceType: 'SUPPLIER_INVOICE',
    sourceId: row.id,
    postingType: 'INVENTORY_RECEIPT',
    description: `Supplier invoice ${row.id}`,
    actorWorkerId,
    deviceId,
    lines: [
      { accountCode: LEDGER_CODES.INVENTORY, debitPesewas: row.totalPesewas },
      {
        accountCode: LEDGER_CODES.AP_TRADE,
        creditPesewas: row.totalPesewas,
        counterpartyType: 'SUPPLIER',
        counterpartyId: row.supplierId,
      },
    ],
  }).journalEntryId;
}

export function postCustomerReturnIfActive(
  db: DB,
  customerReturnId: string,
  actorWorkerId: string,
  deviceId: string,
): string | null {
  const row = db.prepare(
    `SELECT cr.id, cr.location_id AS locationId, cr.customer_id AS customerId,
            cr.original_sale_id AS originalSaleId, cr.shift_id AS shiftId,
            cr.refund_method AS refundMethod,
            cr.total_refund_pesewas AS totalRefundPesewas,
            cr.created_at AS occurredAt,
            sh.financial_account_id AS shiftFinancialAccountId
       FROM customer_returns cr
       LEFT JOIN shifts sh ON sh.id = cr.shift_id
      WHERE cr.id = ?`,
  ).get(customerReturnId) as {
    id: string; locationId: string; customerId: string; originalSaleId: string | null;
    shiftId: string | null; refundMethod: 'CASH' | 'CREDIT';
    totalRefundPesewas: number; occurredAt: string; shiftFinancialAccountId: string | null;
  } | undefined;
  if (!row || !isLedgerPostingEnabled(db, row.locationId)) return null;
  const returnLines = db.prepare(
    `SELECT crl.stock_movement_id AS stockMovementId, crl.product_id AS productId,
            sm.quantity
       FROM customer_return_lines crl
       JOIN stock_movements sm ON sm.id = crl.stock_movement_id
      WHERE crl.return_id = ?`,
  ).all(row.id) as Array<{ stockMovementId: string; productId: string; quantity: number }>;
  let restoredCogs = 0;
  for (const line of returnLines) {
    let exactInbound: number | undefined;
    if (row.originalSaleId) {
      const original = db.prepare(
        `SELECT COALESCE(SUM(-quantity), 0) AS quantity,
                COALESCE(SUM(-total_value_pesewas), 0) AS value
           FROM stock_movements
          WHERE sale_id = ? AND product_id = ? AND quantity < 0`,
      ).get(row.originalSaleId, line.productId) as { quantity: number; value: number };
      if (original.quantity > 0) {
        exactInbound = line.quantity >= original.quantity
          ? original.value
          : Math.round((original.value * line.quantity) / original.quantity);
      }
    }
    const valuation = recordInventoryValuationMovement(db, {
      stockMovementId: line.stockMovementId,
      exactInboundValuePesewas: exactInbound,
      actorWorkerId,
      deviceId,
    });
    restoredCogs += valuation.valueDeltaPesewas;
    db.prepare(
      `UPDATE stock_movements
          SET total_value_pesewas = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(
      valuation.valueDeltaPesewas, new Date().toISOString(), actorWorkerId, line.stockMovementId,
    );
  }
  const vat = vatForSale(row.totalRefundPesewas);
  const tax = vat.vatPesewas + vat.nhilPesewas + vat.getfundPesewas;
  const refundLines: JournalLineInput[] = [
    { accountCode: LEDGER_CODES.SALES_NET, debitPesewas: row.totalRefundPesewas - tax },
  ];
  if (tax > 0) refundLines.push({ accountCode: LEDGER_CODES.TAX_PAYABLE, debitPesewas: tax });
  if (row.refundMethod === 'CASH') {
    const cash = row.shiftFinancialAccountId
      ? financialAccount(db, row.shiftFinancialAccountId)
      : mappedFinancialAccount(db, row.locationId, 'CASH', 'OUT');
    refundLines.push({ ledgerAccountId: cash.ledgerAccountId, creditPesewas: row.totalRefundPesewas });
  } else {
    const allocated = (db.prepare(
      `SELECT COALESCE(SUM(cpa.amount_pesewas), 0) AS total
         FROM customer_payments cp
         JOIN customer_payment_allocations cpa ON cpa.customer_payment_id = cp.id
        WHERE cp.payment_method = 'RETURN_CREDIT' AND cp.payment_reference = ?`,
    ).get(row.id) as { total: number }).total;
    if (allocated > 0) {
      refundLines.push({
        accountCode: LEDGER_CODES.AR,
        creditPesewas: allocated,
        counterpartyType: 'CUSTOMER',
        counterpartyId: row.customerId,
      });
    }
    const storeCredit = row.totalRefundPesewas - allocated;
    if (storeCredit > 0) {
      refundLines.push({
        accountCode: LEDGER_CODES.CUSTOMER_CREDITS,
        creditPesewas: storeCredit,
        counterpartyType: 'CUSTOMER',
        counterpartyId: row.customerId,
      });
    }
  }
  if (restoredCogs > 0) {
    refundLines.push({ accountCode: LEDGER_CODES.INVENTORY, debitPesewas: restoredCogs });
    refundLines.push({ accountCode: LEDGER_CODES.COGS, creditPesewas: restoredCogs });
  }
  return postJournal(db, {
    locationId: row.locationId,
    businessDate: businessDate(row.occurredAt),
    occurredAt: row.occurredAt,
    sourceType: 'CUSTOMER_RETURN',
    sourceId: row.id,
    postingType: 'SALE_RETURN',
    description: `Customer return ${row.id}`,
    actorWorkerId,
    deviceId,
    lines: refundLines,
  }).journalEntryId;
}

export function postStockLossIfActive(
  db: DB,
  stockMovementId: string,
  actorWorkerId: string,
  deviceId: string,
): string | null {
  const row = db.prepare(
    `SELECT id, location_id AS locationId, reason_code AS reasonCode,
            total_value_pesewas AS totalValuePesewas, created_at AS occurredAt
       FROM stock_movements WHERE id = ?`,
  ).get(stockMovementId) as {
    id: string; locationId: string; reasonCode: string; totalValuePesewas: number; occurredAt: string;
  } | undefined;
  if (!row || !isLedgerPostingEnabled(db, row.locationId)) return null;
  const amount = Math.abs(row.totalValuePesewas);
  if (amount <= 0) return null;
  if (row.reasonCode === 'STOCK_FOUND') {
    return postJournal(db, {
      locationId: row.locationId,
      businessDate: businessDate(row.occurredAt),
      occurredAt: row.occurredAt,
      sourceType: 'STOCK_MOVEMENT',
      sourceId: row.id,
      postingType: 'INVENTORY_GAIN',
      description: `Inventory found ${row.id}`,
      actorWorkerId,
      deviceId,
      lines: [
        { accountCode: LEDGER_CODES.INVENTORY, debitPesewas: amount },
        { accountCode: LEDGER_CODES.INVENTORY_GAIN, creditPesewas: amount },
      ],
    }).journalEntryId;
  }
  const lossCode = LOSS_ACCOUNT_BY_REASON[row.reasonCode];
  if (!lossCode) return null;
  return postJournal(db, {
    locationId: row.locationId,
    businessDate: businessDate(row.occurredAt),
    occurredAt: row.occurredAt,
    sourceType: 'STOCK_MOVEMENT',
    sourceId: row.id,
    postingType: 'INVENTORY_LOSS',
    description: `${row.reasonCode} ${row.id}`,
    actorWorkerId,
    deviceId,
    lines: [
      { accountCode: lossCode, debitPesewas: amount },
      { accountCode: LEDGER_CODES.INVENTORY, creditPesewas: amount },
    ],
  }).journalEntryId;
}

export function recordInventoryValuationMovement(
  db: DB,
  input: {
    stockMovementId: string;
    exactInboundValuePesewas?: number;
    actorWorkerId: string;
    deviceId: string;
  },
): {
  valuationMovementId: string;
  valueDeltaPesewas: number;
  balanceQuantity: number;
  balanceValuePesewas: number;
  averageUnitCostPesewas: number;
} {
  const existing = db.prepare(
    `SELECT id AS valuationMovementId, value_delta_pesewas AS valueDeltaPesewas,
            balance_quantity AS balanceQuantity, balance_value_pesewas AS balanceValuePesewas,
            average_unit_cost_pesewas AS averageUnitCostPesewas
       FROM inventory_valuation_movements WHERE stock_movement_id = ?`,
  ).get(input.stockMovementId) as {
    valuationMovementId: string; valueDeltaPesewas: number; balanceQuantity: number;
    balanceValuePesewas: number; averageUnitCostPesewas: number;
  } | undefined;
  if (existing) return existing;
  const movement = db.prepare(
    `SELECT id, product_id AS productId, location_id AS locationId, quantity,
            total_value_pesewas AS totalValuePesewas, created_at AS occurredAt
       FROM stock_movements WHERE id = ?`,
  ).get(input.stockMovementId) as {
    id: string; productId: string; locationId: string; quantity: number;
    totalValuePesewas: number; occurredAt: string;
  } | undefined;
  if (!movement) throw new Error(`stock movement ${input.stockMovementId} not found`);
  const prior = db.prepare(
    `SELECT balance_quantity AS quantity, balance_value_pesewas AS value
       FROM inventory_valuation_movements
      WHERE product_id = ? AND location_id = ?
      ORDER BY occurred_at DESC, created_at DESC, id DESC LIMIT 1`,
  ).get(movement.productId, movement.locationId) as { quantity: number; value: number } | undefined;
  const priorQty = prior?.quantity ?? 0;
  const priorValue = prior?.value ?? 0;
  let valueDelta: number;
  if (movement.quantity > 0) {
    valueDelta = input.exactInboundValuePesewas ?? Math.abs(movement.totalValuePesewas);
  } else {
    const unitsOut = Math.abs(movement.quantity);
    if (unitsOut > priorQty) throw new Error('inventory valuation cannot go negative');
    valueDelta = priorQty === unitsOut
      ? -priorValue
      : -Math.round((priorValue * unitsOut) / priorQty);
  }
  const balanceQuantity = priorQty + movement.quantity;
  const balanceValuePesewas = priorValue + valueDelta;
  if (balanceQuantity < 0 || balanceValuePesewas < 0) throw new Error('negative inventory valuation balance');
  const averageUnitCostPesewas = balanceQuantity > 0
    ? Math.round(balanceValuePesewas / balanceQuantity)
    : 0;
  const valuationMovementId = `ivm-${uuidv4()}`;
  db.prepare(
    `INSERT INTO inventory_valuation_movements (
       id, stock_movement_id, product_id, location_id, quantity_delta,
       value_delta_pesewas, balance_quantity, balance_value_pesewas,
       average_unit_cost_pesewas, occurred_at, created_by, device_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    valuationMovementId, movement.id, movement.productId, movement.locationId,
    movement.quantity, valueDelta, balanceQuantity, balanceValuePesewas,
    averageUnitCostPesewas, movement.occurredAt, input.actorWorkerId, input.deviceId,
  );
  db.prepare(
    `UPDATE products SET cost_price_pesewas = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
  ).run(averageUnitCostPesewas, new Date().toISOString(), input.actorWorkerId, movement.productId);
  return {
    valuationMovementId,
    valueDeltaPesewas: valueDelta,
    balanceQuantity,
    balanceValuePesewas,
    averageUnitCostPesewas,
  };
}

export function valueStockMovementAndPostLossIfActive(
  db: DB,
  input: {
    stockMovementId: string;
    exactInboundValuePesewas?: number;
    actorWorkerId: string;
    deviceId: string;
  },
): ReturnType<typeof recordInventoryValuationMovement> | null {
  const location = db.prepare(
    'SELECT location_id AS locationId FROM stock_movements WHERE id = ?',
  ).get(input.stockMovementId) as { locationId: string } | undefined;
  if (!location || !isLedgerPostingEnabled(db, location.locationId)) return null;
  const valuation = recordInventoryValuationMovement(db, input);
  db.prepare(
    `UPDATE stock_movements
        SET total_value_pesewas = ?, updated_at = ?
      WHERE id = ?`,
  ).run(valuation.valueDeltaPesewas, new Date().toISOString(), input.stockMovementId);
  postStockLossIfActive(db, input.stockMovementId, input.actorWorkerId, input.deviceId);
  return valuation;
}

export function expenseAccountCode(category: string): string {
  return EXPENSE_ACCOUNT_BY_CATEGORY[category] ?? 'EXP_OTHER';
}

export function updateRiskThreshold(
  db: DB,
  input: {
    locationId?: string;
    dimension: 'CUSTOMER' | 'PRODUCT' | 'SUPPLIER' | 'CATEGORY' | 'PAYMENT_RAIL';
    warningBps: number;
    dangerBps: number;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): void {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  if (!Number.isInteger(input.warningBps) || !Number.isInteger(input.dangerBps)
      || input.warningBps < 0 || input.dangerBps > 10_000
      || input.warningBps >= input.dangerBps) {
    throw new Error('risk thresholds require 0 ≤ warning < danger ≤ 10000 basis points');
  }
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  const row = db.prepare(
    'SELECT id FROM risk_thresholds WHERE location_id = ? AND dimension = ?',
  ).get(locationId, input.dimension) as { id: string } | undefined;
  if (!row) throw new Error(`risk threshold ${input.dimension} not found`);
  db.prepare(
    `UPDATE risk_thresholds
        SET warning_bps = ?, danger_bps = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`,
  ).run(
    input.warningBps, input.dangerBps, new Date().toISOString(), input.actorWorkerId, row.id,
  );
  logAudit(db, {
    workerId: input.actorWorkerId,
    action: 'RISK_THRESHOLD_UPDATED',
    entityType: 'risk_thresholds',
    entityId: row.id,
    afterValue: {
      dimension: input.dimension,
      warningBps: input.warningBps,
      dangerBps: input.dangerBps,
    },
    deviceId: input.deviceId,
  });
}

export interface RiskAssumptionRow {
  id: string;
  locationId: string;
  driver: string;
  baselineBps: number;
  downsideBps: number;
  rationale: string | null;
  ownerWorkerId: string | null;
  ownerName: string | null;
  reviewDate: string | null;
  active: boolean;
}

export interface SavedScenarioRow {
  id: string;
  locationId: string;
  name: string;
  horizonDays: 30 | 90 | 180;
  drivers: Record<string, number | boolean>;
  active: boolean;
}

export function listRiskConfiguration(
  db: DB,
  locationId = DEFAULT_LOCATION_ID,
): { assumptions: RiskAssumptionRow[]; scenarios: SavedScenarioRow[] } {
  const assumptions = (db.prepare(
    `SELECT ra.id, ra.location_id AS locationId, ra.driver,
            ra.baseline_bps AS baselineBps, ra.downside_bps AS downsideBps,
            ra.rationale, ra.owner_worker_id AS ownerWorkerId,
            w.full_name AS ownerName, ra.review_date AS reviewDate, ra.active
       FROM risk_assumptions ra
       LEFT JOIN workers w ON w.id = ra.owner_worker_id
      WHERE ra.location_id = ? AND ra.active = 1
      ORDER BY ra.driver`,
  ).all(locationId) as Array<Omit<RiskAssumptionRow, 'active'> & { active: number }>)
    .map((row) => ({ ...row, active: row.active === 1 }));
  const scenarios = (db.prepare(
    `SELECT id, location_id AS locationId, name, horizon_days AS horizonDays,
            drivers_json AS driversJson, active
       FROM saved_scenarios
      WHERE location_id = ? AND active = 1
      ORDER BY name`,
  ).all(locationId) as Array<{
    id: string; locationId: string; name: string; horizonDays: 30 | 90 | 180;
    driversJson: string; active: number;
  }>).map((row) => ({
    id: row.id, locationId: row.locationId, name: row.name, horizonDays: row.horizonDays,
    drivers: JSON.parse(row.driversJson) as Record<string, number | boolean>, active: row.active === 1,
  }));
  return { assumptions, scenarios };
}

export function upsertRiskAssumption(
  db: DB,
  input: {
    id?: string;
    locationId?: string;
    driver: string;
    baselineBps: number;
    downsideBps: number;
    rationale?: string | null;
    reviewDate?: string | null;
    active?: boolean;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): RiskAssumptionRow {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  if (!input.driver.trim()) throw new Error('risk assumption driver is required');
  if (!Number.isInteger(input.baselineBps) || !Number.isInteger(input.downsideBps)) {
    throw new Error('risk assumption values must be integer basis points');
  }
  if (input.reviewDate) assertDateOnly('reviewDate', input.reviewDate);
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  const existing = input.id
    ? db.prepare('SELECT id FROM risk_assumptions WHERE id = ? AND location_id = ?').get(input.id, locationId) as { id: string } | undefined
    : db.prepare('SELECT id FROM risk_assumptions WHERE location_id = ? AND driver = ? AND active = 1')
      .get(locationId, input.driver.trim()) as { id: string } | undefined;
  const id = existing?.id ?? `risk-${uuidv4()}`;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      `UPDATE risk_assumptions
          SET driver = ?, baseline_bps = ?, downside_bps = ?, rationale = ?,
              owner_worker_id = ?, review_date = ?, active = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(
      input.driver.trim(), input.baselineBps, input.downsideBps,
      input.rationale?.trim() || null, input.actorWorkerId, input.reviewDate ?? null,
      input.active === false ? 0 : 1, now, input.actorWorkerId, id,
    );
  } else {
    db.prepare(
      `INSERT INTO risk_assumptions (
         id, location_id, driver, baseline_bps, downside_bps, rationale,
         owner_worker_id, review_date, active, created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, locationId, input.driver.trim(), input.baselineBps, input.downsideBps,
      input.rationale?.trim() || null, input.actorWorkerId, input.reviewDate ?? null,
      input.active === false ? 0 : 1, input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
  }
  logAudit(db, {
    workerId: input.actorWorkerId, action: 'RISK_ASSUMPTION_SAVED',
    entityType: 'risk_assumptions', entityId: id,
    afterValue: { driver: input.driver.trim(), baselineBps: input.baselineBps, downsideBps: input.downsideBps },
    deviceId: input.deviceId,
  });
  return listRiskConfiguration(db, locationId).assumptions.find((row) => row.id === id)!;
}

export function saveScenario(
  db: DB,
  input: {
    id?: string;
    locationId?: string;
    name: string;
    horizonDays: 30 | 90 | 180;
    drivers: Record<string, number | boolean>;
    active?: boolean;
    actorWorkerId: string;
    pin: string;
    deviceId: string;
  },
): SavedScenarioRow {
  requireOwnerPin(db, input.actorWorkerId, input.pin, input.deviceId);
  if (!input.name.trim()) throw new Error('scenario name is required');
  if (![30, 90, 180].includes(input.horizonDays)) throw new Error('scenario horizon must be 30, 90, or 180 days');
  const allowed = new Set([
    'salesVolumeChangeBps', 'sellingPriceChangeBps', 'cogsChangeBps',
    'fixedExpenseChangeBps', 'variableExpenseChangeBps', 'collectionChangeBps',
    'badDebtBps', 'additionalInventoryLossBps', 'removeTopCustomer', 'removeTopProduct',
  ]);
  for (const [key, value] of Object.entries(input.drivers)) {
    if (!allowed.has(key)) throw new Error(`unsupported scenario driver ${key}`);
    if (typeof value !== 'number' && typeof value !== 'boolean') throw new Error(`invalid scenario driver ${key}`);
    if (typeof value === 'number' && !Number.isInteger(value)) throw new Error(`scenario driver ${key} must use integer basis points`);
  }
  const locationId = input.locationId ?? DEFAULT_LOCATION_ID;
  const existing = input.id
    ? db.prepare('SELECT id FROM saved_scenarios WHERE id = ? AND location_id = ?').get(input.id, locationId) as { id: string } | undefined
    : db.prepare('SELECT id FROM saved_scenarios WHERE location_id = ? AND name = ?')
      .get(locationId, input.name.trim()) as { id: string } | undefined;
  const id = existing?.id ?? `scenario-${uuidv4()}`;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare(
      `UPDATE saved_scenarios
          SET name = ?, horizon_days = ?, drivers_json = ?, active = ?, updated_at = ?, updated_by = ?
        WHERE id = ?`,
    ).run(
      input.name.trim(), input.horizonDays, JSON.stringify(input.drivers),
      input.active === false ? 0 : 1, now, input.actorWorkerId, id,
    );
  } else {
    db.prepare(
      `INSERT INTO saved_scenarios (
         id, location_id, name, horizon_days, drivers_json, active,
         created_by, updated_by, device_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, locationId, input.name.trim(), input.horizonDays, JSON.stringify(input.drivers),
      input.active === false ? 0 : 1, input.actorWorkerId, input.actorWorkerId, input.deviceId,
    );
  }
  logAudit(db, {
    workerId: input.actorWorkerId, action: 'DOWNSIDE_SCENARIO_SAVED',
    entityType: 'saved_scenarios', entityId: id,
    afterValue: { name: input.name.trim(), horizonDays: input.horizonDays },
    deviceId: input.deviceId,
  });
  return listRiskConfiguration(db, locationId).scenarios.find((row) => row.id === id)!;
}
