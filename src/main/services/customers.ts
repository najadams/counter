// Customer search for the credit-sale flow.

import type { Database as DB } from 'better-sqlite3';
import { normalizePhone } from '../../shared/lib/phone.js';

export interface CustomerSearchResult {
  id: string;
  displayName: string;
  businessName: string | null;
  phone: string;
  customerType: string;
  currentBalancePesewas: number;
  creditLimitPesewas: number;
  cashOnly: boolean;
  blocked: boolean;
  preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
}

/**
 * Search customers by phone substring, customer name, or business/company
 * name (case-insensitive). This is the single search used by every till
 * picker, so company-name matching stays consistent across desktop and touch.
 * Excludes deleted customers; blocked customers are returned but flagged
 * (the UI will surface this so the worker knows credit is suspended).
 */
export function searchCustomers(
  db: DB,
  query: string,
  limit = 12,
): CustomerSearchResult[] {
  const trimmed = query.trim();
  if (trimmed === '') return [];

  // Phones are stored in +233XXXXXXXXX form. A cashier typing the local
  // "024..." or "024 422 2000" needs to find the same customer, so we
  // attempt normalization too and OR it into the WHERE. Falls back to
  // raw-substring matching if the query doesn't look phone-like.
  const like = `%${trimmed}%`;
  const normalizedPhone = normalizePhone(trimmed);
  const rows = db
    .prepare(
      `SELECT id, display_name AS displayName, business_name AS businessName,
              phone, customer_type AS customerType,
              current_balance_pesewas AS currentBalancePesewas,
              credit_limit_pesewas AS creditLimitPesewas,
              cash_only AS cashOnly,
              blocked,
              preferred_channel AS preferredChannel
         FROM customers
         WHERE deleted_at IS NULL
           AND (display_name LIKE ? COLLATE NOCASE
                OR business_name LIKE ? COLLATE NOCASE
                OR phone LIKE ?
                OR (? IS NOT NULL AND phone = ?))
         ORDER BY
           CASE
             WHEN (? IS NOT NULL AND phone = ?) THEN 0
             WHEN display_name = ? COLLATE NOCASE THEN 1
             WHEN business_name = ? COLLATE NOCASE THEN 2
             ELSE 3
           END,
           display_name ASC
         LIMIT ?`,
    )
    .all(like, like, like, normalizedPhone, normalizedPhone,
      normalizedPhone, normalizedPhone, trimmed, trimmed, limit) as Array<{
      id: string;
      displayName: string;
      businessName: string | null;
      phone: string;
      customerType: string;
      currentBalancePesewas: number;
      creditLimitPesewas: number;
      cashOnly: number;
      blocked: number;
      preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
    }>;

  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    businessName: r.businessName,
    phone: r.phone,
    customerType: r.customerType,
    currentBalancePesewas: r.currentBalancePesewas,
    creditLimitPesewas: r.creditLimitPesewas,
    cashOnly: r.cashOnly === 1,
    blocked: r.blocked === 1,
    preferredChannel: r.preferredChannel,
  }));
}
