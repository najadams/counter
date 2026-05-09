// Customer search for the credit-sale flow.

import type { Database as DB } from 'better-sqlite3';

export interface CustomerSearchResult {
  id: string;
  displayName: string;
  phone: string;
  customerType: string;
  currentBalancePesewas: number;
  creditLimitPesewas: number;
  blocked: boolean;
  preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
}

/**
 * Search customers by phone substring or name (case-insensitive).
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

  const like = `%${trimmed}%`;
  const rows = db
    .prepare(
      `SELECT id, display_name AS displayName, phone, customer_type AS customerType,
              current_balance_pesewas AS currentBalancePesewas,
              credit_limit_pesewas AS creditLimitPesewas,
              blocked,
              preferred_channel AS preferredChannel
         FROM customers
         WHERE deleted_at IS NULL
           AND (display_name LIKE ? COLLATE NOCASE OR phone LIKE ?)
         ORDER BY display_name ASC
         LIMIT ?`,
    )
    .all(like, like, limit) as Array<{
      id: string;
      displayName: string;
      phone: string;
      customerType: string;
      currentBalancePesewas: number;
      creditLimitPesewas: number;
      blocked: number;
      preferredChannel: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null;
    }>;

  return rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    phone: r.phone,
    customerType: r.customerType,
    currentBalancePesewas: r.currentBalancePesewas,
    creditLimitPesewas: r.creditLimitPesewas,
    blocked: r.blocked === 1,
    preferredChannel: r.preferredChannel,
  }));
}
