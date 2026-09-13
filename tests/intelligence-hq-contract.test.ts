import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('HQ intelligence tenant contract', () => {
  const edge = fs.readFileSync(path.join(root, 'supabase/functions/intelligence-feed/index.ts'), 'utf8');
  const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260804000000_intelligence_feed.sql'), 'utf8');

  it('requires an authenticated HQ token and derives every company filter from that token', () => {
    expect(edge).toContain('const caller = await authenticate(req, supabase)');
    expect(edge).toContain('if (caller.role !== "HQ")');
    expect(edge).not.toMatch(/searchParams\.get\(["']company/i);
    expect(edge.match(/\.eq\("company_id", caller\.company_id\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(edge).not.toMatch(/batch\.company|body\.company|companyId/);
  });

  it('excludes stale shops, requires three fresh shops for comparisons, and never proposes stock transfers', () => {
    expect(edge).toContain('const freshShopIds = shops.filter((shop) => !shop.stale)');
    expect(edge).toContain('if (freshShopIds.length >= 3)');
    expect(edge).toContain('includedInPeerBaseline: !stale');
    expect(edge).not.toMatch(/recommendation:.*transfer/i);
  });

  it('keeps typed central views behind underlying default-deny RLS', () => {
    expect(migration).toContain('intelligence_items_central with (security_invoker = on)');
    expect(migration).toContain('daily_summaries_central with (security_invoker = on)');
    expect(migration).toContain("where table_name = 'intelligence_items'");
    expect(migration).toContain("where table_name = 'daily_summaries'");
  });
});
