import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/main/db/migrations';
import { runSeed } from '../src/main/db/seed';
import {
  applyCompanyIntelligenceFeed,
  advisoryPriceFloor,
  collectionPriorityScore,
  compareIntelligencePriority,
  getIntelligenceBrief,
  getIntelligenceItem,
  listIntelligenceItems,
  refreshIntelligence,
  roundCanonicalOrderQuantity,
  transitionIntelligenceItem,
  weightedDemandForecast,
} from '../src/main/services/intelligence';
import { openVarianceCase, updateVarianceCase } from '../src/main/services/varianceCases';
import type { CompanyIntelligenceFeedResponse, CompanyIntelligenceFeedItem } from '../src/shared/sync';
import type { IntelligenceItem } from '../src/shared/types/ipc';
import { pullCompanyIntelligenceOnce } from '../src/main/sync/pullIntelligence';
import { getState } from '../src/main/sync/state';

const migrationsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../migrations');
const COUNTER = 'dev-counter-1';
const SENIOR = 'dev-supervisor-1';
const LOCATION = 'loc-main-counter';
const DEVICE = 'intelligence-test';
let db: ReturnType<typeof Database>;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  runSeed(db, { includeDevFixtures: true });
});
afterEach(() => db.close());

const supervisor = () => ({ workerId: SENIOR, role: 'SUPERVISOR' });
const owner = () => ({ workerId: SENIOR, role: 'OWNER' });

describe('local intelligence lifecycle and access', () => {
  it('ships Foundation by default, denies counters, deduplicates, and starts a new episode only after clearing', () => {
    expect(db.prepare("SELECT value FROM device_config WHERE key = 'intelligence_stage'").get())
      .toMatchObject({ value: 'FOUNDATION' });
    const opened = openVarianceCase(db, {
      caseType: 'MANUAL', title: 'Unexplained control difference', amountPesewas: -12_000,
      sourceType: 'TEST', sourceId: 'intel-case', actorWorkerId: SENIOR, deviceId: DEVICE,
    });

    const first = refreshIntelligence(db, { actorWorkerId: SENIOR, deviceId: DEVICE, trigger: 'EVENT', exactOnly: true });
    expect(first.generatedCount).toBeGreaterThan(0);
    refreshIntelligence(db, { actorWorkerId: SENIOR, deviceId: DEVICE, trigger: 'EVENT', exactOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM intelligence_items WHERE fingerprint = ?")
      .get(`variance:${opened.caseId}`)).toMatchObject({ n: 1 });
    expect(() => getIntelligenceBrief(db, { workerId: COUNTER, role: 'COUNTER' }, DEVICE))
      .toThrow(/Supervisor/);

    const item = listIntelligenceItems(db, supervisor(), DEVICE).items
      .find((row) => row.fingerprint === `variance:${opened.caseId}`)!;
    expect(item).toMatchObject({ severity: 'CRITICAL', controlOverride: true, cediImpactPesewas: 12_000 });
    expect(() => transitionIntelligenceItem(db, supervisor(), DEVICE, {
      itemId: item.id, action: 'DISMISS', note: 'x',
    })).toThrow(/at least 3/);
    transitionIntelligenceItem(db, supervisor(), DEVICE, {
      itemId: item.id, action: 'DISMISS', note: 'Known counting issue under review',
    });
    refreshIntelligence(db, { actorWorkerId: SENIOR, deviceId: DEVICE, trigger: 'EVENT', exactOnly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM intelligence_items WHERE fingerprint = ? AND status IN ('OPEN','ACKNOWLEDGED','ASSIGNED','SNOOZED')")
      .get(item.fingerprint)).toMatchObject({ n: 0 });

    updateVarianceCase(db, { caseId: opened.caseId, status: 'RESOLVED',
      causeCode: 'COUNTING_ERROR', resolutionNote: 'Physical recount confirmed the source',
      actorWorkerId: SENIOR, deviceId: DEVICE });
    refreshIntelligence(db, { actorWorkerId: SENIOR, deviceId: DEVICE, trigger: 'EVENT', exactOnly: true });
    expect(db.prepare('SELECT condition_cleared_at AS cleared FROM intelligence_items WHERE id = ?').get(item.id))
      .toMatchObject({ cleared: expect.any(String) });

    db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(SENIOR);
    updateVarianceCase(db, { caseId: opened.caseId, status: 'OPEN',
      resolutionNote: 'The difference recurred on a later recount', actorWorkerId: SENIOR, deviceId: DEVICE });
    refreshIntelligence(db, { actorWorkerId: SENIOR, deviceId: DEVICE, trigger: 'EVENT', exactOnly: true });
    const episodes = db.prepare('SELECT episode, status FROM intelligence_items WHERE fingerprint = ? ORDER BY episode')
      .all(item.fingerprint) as Array<{ episode: number; status: string }>;
    expect(episodes).toEqual([{ episode: 1, status: 'DISMISSED' }, { episode: 2, status: 'OPEN' }]);
  });

  it('audits acknowledgement, assignment, snooze, and resolution with before/after states', () => {
    const opened = openVarianceCase(db, {
      caseType: 'MANUAL', title: 'Lifecycle control case', amountPesewas: -15_000,
      sourceType: 'TEST', sourceId: 'lifecycle', actorWorkerId: SENIOR, deviceId: DEVICE,
    });
    refreshIntelligence(db, { actorWorkerId: SENIOR, deviceId: DEVICE, trigger: 'EVENT', exactOnly: true });
    const item = listIntelligenceItems(db, supervisor(), DEVICE).items
      .find((row) => row.fingerprint === `variance:${opened.caseId}`)!;
    transitionIntelligenceItem(db, supervisor(), DEVICE, { itemId: item.id, action: 'ACKNOWLEDGE' });
    transitionIntelligenceItem(db, supervisor(), DEVICE, { itemId: item.id, action: 'ASSIGN', assignedTo: SENIOR });
    transitionIntelligenceItem(db, supervisor(), DEVICE, { itemId: item.id, action: 'SNOOZE', snoozeDays: 3 });
    transitionIntelligenceItem(db, supervisor(), DEVICE, { itemId: item.id, action: 'RESOLVE', note: 'Records checked and corrected upstream' });
    const detail = getIntelligenceItem(db, supervisor(), item.id);
    expect(detail.item).toMatchObject({ status: 'RESOLVED', assignedTo: SENIOR });
    expect(detail.events.map((event) => event.eventType)).toEqual([
      'GENERATED', 'ACKNOWLEDGED', 'ASSIGNED', 'SNOOZED', 'RESOLVED',
    ]);
    expect(() => db.prepare('UPDATE intelligence_item_events SET note = ? WHERE item_id = ?').run('rewrite', item.id))
      .toThrow(/append-only/);
  });
});

describe('predictive worker normalization', () => {
  it('does not flag a high-volume worker with a normal rate and flags a rate outlier with three qualifying peers', () => {
    db.prepare("UPDATE device_config SET value = 'PREDICTIVE' WHERE key = 'intelligence_stage'").run();
    const template = db.prepare('SELECT pin_hash AS pinHash FROM workers WHERE id = ?').get(COUNTER) as { pinHash: string };
    const workers = [
      { id: COUNTER, attempts: 300, voids: 3 },
      { id: 'rate-outlier', attempts: 30, voids: 6 },
      { id: 'rate-peer-1', attempts: 30, voids: 1 },
      { id: 'rate-peer-2', attempts: 30, voids: 1 },
      { id: 'rate-peer-3', attempts: 30, voids: 1 },
    ];
    for (const [index, worker] of workers.slice(1).entries()) {
      db.prepare(`INSERT INTO workers (id, full_name, phone, role, pin_hash, hired_at, created_by, updated_by, device_id)
        VALUES (?, ?, ?, 'COUNTER', ?, '2026-01-01', 'sys-system', 'sys-system', ?)`)
        .run(worker.id, `Rate Worker ${index + 1}`, `+23355510000${index}`, template.pinHash, DEVICE);
    }
    const now = new Date();
    for (const worker of workers) {
      const shifts = Array.from({ length: 3 }, (_unused, index) => `${worker.id}-shift-${index}`);
      for (const [index, shiftId] of shifts.entries()) {
        const at = new Date(now); at.setUTCDate(at.getUTCDate() - index - 2);
        db.prepare(`INSERT INTO shifts (id, worker_id, location_id, opened_at, closed_at,
          shift_type, opening_cash_pesewas, closing_cash_counted_pesewas,
          closing_cash_expected_pesewas, cash_variance_pesewas, created_by, updated_by, device_id)
          VALUES (?, ?, ?, ?, ?, 'COUNTER', 0, 0, 0, 0, ?, ?, ?)`)
          .run(shiftId, worker.id, LOCATION, at.toISOString(), at.toISOString(), worker.id, worker.id, DEVICE);
      }
      for (let index = 0; index < worker.attempts; index++) {
        const voided = index < worker.voids;
        const at = new Date(now); at.setUTCDate(at.getUTCDate() - 2 - (index % 20));
        db.prepare(`INSERT INTO sales (id, shift_id, worker_id, location_id, channel,
          subtotal_pesewas, discount_pesewas, total_pesewas, payment_method,
          voided, voided_by, voided_at, void_reason, created_at, created_by, updated_by, device_id)
          VALUES (?, ?, ?, ?, 'WALK_IN', 1000, 0, 1000, 'CASH', ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(`${worker.id}-sale-${index}`, shifts[index % 3], worker.id, LOCATION,
            voided ? 1 : 0, voided ? worker.id : null, voided ? at.toISOString() : null,
            voided ? 'Customer changed order' : null, at.toISOString(), worker.id, worker.id, DEVICE);
      }
    }

    refreshIntelligence(db, { actorWorkerId: SENIOR, deviceId: DEVICE, trigger: 'MANUAL' });
    const rows = db.prepare("SELECT source_entity_id AS workerId FROM intelligence_items WHERE model_key = 'normalized-worker-void-rate' AND status = 'OPEN'")
      .all() as Array<{ workerId: string }>;
    expect(rows).toContainEqual({ workerId: 'rate-outlier' });
    expect(rows).not.toContainEqual({ workerId: COUNTER });
  });
});

describe('predictive formulas and sparse-data gates', () => {
  it('uses zero-filled weighted demand, integer purchase-unit rounding, collection weights, and a minimum price floor', () => {
    const history = Array<number>(84).fill(0);
    history.fill(2, 0, 7);
    expect(weightedDemandForecast(history)).toBeCloseTo(
      0.5 * 2 + 0.3 * (14 / 28) + 0.2 * (14 / 84), 8,
    );
    expect(roundCanonicalOrderQuantity(25, 24)).toBe(48);
    expect(collectionPriorityScore({ overdueDays: 90, outstandingToLimitBps: 10_000,
      brokenPromises: 2, daysSinceFollowup: 30 })).toBe(100);
    expect(advisoryPriceFloor(900, 0.2, 1200)).toBe(1200);
  });

  it('labels a new product low confidence, falls back to its threshold, and rounds advice to the purchase unit', () => {
    db.prepare("UPDATE device_config SET value = 'PREDICTIVE' WHERE key = 'intelligence_stage'").run();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO products (id, sku, name, category, cost_price_pesewas,
      walk_in_price_pesewas, wholesale_price_pesewas, route_price_pesewas,
      reorder_threshold, reorder_quantity, created_at, created_by, updated_by, device_id)
      VALUES ('sparse-product', 'SPARSE-1', 'Sparse Product', 'WATER', 100, 150, 140, 140,
        10, 24, ?, 'sys-system', 'sys-system', ?)`)
      .run(now, DEVICE);
    db.prepare(`INSERT INTO product_units (id, product_id, unit_name, conversion_factor,
      price_pesewas, is_purchase_unit, is_sale_unit, created_by, updated_by, device_id)
      VALUES ('sparse-crate', 'sparse-product', 'CRATE', 24, 3600, 1, 0,
        'sys-system', 'sys-system', ?)`)
      .run(DEVICE);
    db.prepare("UPDATE products SET primary_purchase_unit_id = 'sparse-crate' WHERE id = 'sparse-product'").run();

    refreshIntelligence(db, { actorWorkerId: SENIOR, deviceId: DEVICE, trigger: 'MANUAL' });
    const row = db.prepare(`SELECT confidence_bps AS confidence, recommendation,
      json_extract(rationale_json, '$.fallbackThreshold') AS fallback
      FROM intelligence_items WHERE fingerprint = 'inventory-low:sparse-product' AND status = 'OPEN'`)
      .get() as { confidence: number; recommendation: string; fallback: number };
    expect(row).toMatchObject({ confidence: 4000, fallback: 1 });
    expect(row.recommendation).toMatch(/24 canonical units \(1 primary purchase unit/);
  });

  it('downgrades collection confidence when due-date history is missing and only advises a policy review', () => {
    db.prepare("UPDATE device_config SET value = 'PREDICTIVE' WHERE key = 'intelligence_stage'").run();
    db.prepare(`INSERT INTO customers (id, display_name, phone, customer_type,
      credit_limit_pesewas, current_balance_pesewas, created_by, updated_by, device_id)
      VALUES ('credit-sparse', 'Sparse Credit', '+233555777777', 'WHOLESALE',
        10000, 12000, ?, ?, ?)`)
      .run(COUNTER, COUNTER, DEVICE);
    refreshIntelligence(db, { actorWorkerId: SENIOR, deviceId: DEVICE, trigger: 'MANUAL' });
    const collection = db.prepare(`SELECT confidence_bps AS confidence FROM intelligence_items
      WHERE fingerprint = 'credit-collection:credit-sparse'`).get();
    const review = db.prepare(`SELECT recommendation FROM intelligence_items
      WHERE fingerprint = 'credit-policy-review:credit-sparse'`).get() as { recommendation: string };
    expect(collection).toMatchObject({ confidence: 6500 });
    expect(review.recommendation).toMatch(/will not change the limit or block/i);
  });

  it('implements every ranking tie-break in the documented direction', () => {
    const base = {
      ...({} as IntelligenceItem), controlOverride: false, severity: 'HIGH' as const,
      dueAt: null, cediImpactPesewas: 1000, confidenceBps: 7000,
      detectedAt: '2026-08-04T08:00:00.000Z',
    };
    expect(compareIntelligencePriority({ ...base, controlOverride: true }, { ...base })).toBeLessThan(0);
    expect(compareIntelligencePriority({ ...base, severity: 'CRITICAL' }, base)).toBeLessThan(0);
    expect(compareIntelligencePriority({ ...base, dueAt: '2026-08-01T00:00:00.000Z' }, base, '2026-08-04T00:00:00.000Z')).toBeLessThan(0);
    expect(compareIntelligencePriority({ ...base, cediImpactPesewas: 2000 }, base)).toBeLessThan(0);
    expect(compareIntelligencePriority({ ...base, dueAt: '2026-08-05T00:00:00.000Z' }, { ...base, dueAt: '2026-08-06T00:00:00.000Z' }, '2026-08-04T00:00:00.000Z')).toBeLessThan(0);
    expect(compareIntelligencePriority({ ...base, confidenceBps: 8000 }, base)).toBeLessThan(0);
    expect(compareIntelligencePriority({ ...base, detectedAt: '2026-08-04T09:00:00.000Z' }, base)).toBeLessThan(0);
  });
});

describe('HQ cache and transparent ranking', () => {
  function feed(items: CompanyIntelligenceFeedItem[]): CompanyIntelligenceFeedResponse {
    return {
      generatedAt: '2026-08-04T08:00:00.000Z', sourceDataThrough: '2026-08-04T07:59:00.000Z',
      freshShopCount: 3,
      shops: [
        { shopId: 'HQ', shopName: 'HQ', role: 'HQ', lastSeenAt: '2026-08-04T07:59:00.000Z', stale: false, includedInPeerBaseline: true },
        { shopId: 'OSU', shopName: 'Osu', role: 'SHOP', lastSeenAt: '2026-08-04T07:58:00.000Z', stale: false, includedInPeerBaseline: true },
        { shopId: 'TEMA', shopName: 'Tema', role: 'SHOP', lastSeenAt: '2026-08-04T07:57:00.000Z', stale: false, includedInPeerBaseline: true },
      ], items,
    };
  }
  function item(overrides: Partial<CompanyIntelligenceFeedItem>): CompanyIntelligenceFeedItem {
    return {
      fingerprint: 'company:test', sourceShopId: 'OSU', sourceShopName: 'Osu',
      modelKey: 'test', modelVersion: '1.0.0', category: 'PRICING', audience: 'OWNER',
      severity: 'CRITICAL', controlOverride: false, title: 'Review margin pressure',
      recommendation: 'Review the evidence and decide whether a response is appropriate.',
      cediImpactPesewas: 50_000, confidenceBps: 9000, dueAt: null, validUntil: null,
      sourceDataThrough: '2026-08-04T07:59:00.000Z', evidence: [], rationale: {},
      sourceEntityType: null, sourceEntityId: null, ...overrides,
    };
  }

  it('keeps HQ lifecycle local, resolves absent feed conditions, and reopens a later episode', () => {
    db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(SENIOR);
    const source = item({});
    expect(applyCompanyIntelligenceFeed(db, feed([source]), DEVICE)).toMatchObject({ generated: 1 });
    const first = listIntelligenceItems(db, owner(), DEVICE, { scope: 'COMPANY' }).items[0]!;
    transitionIntelligenceItem(db, owner(), DEVICE, { itemId: first.id, action: 'ACKNOWLEDGE' });
    applyCompanyIntelligenceFeed(db, feed([source]), DEVICE);
    expect(getIntelligenceItem(db, owner(), first.id).item.status).toBe('ACKNOWLEDGED');
    applyCompanyIntelligenceFeed(db, feed([]), DEVICE);
    expect(getIntelligenceItem(db, owner(), first.id).item.status).toBe('RESOLVED');
    applyCompanyIntelligenceFeed(db, feed([source]), DEVICE);
    expect(db.prepare('SELECT episode FROM intelligence_items WHERE fingerprint = ? ORDER BY episode')
      .all(source.fingerprint)).toEqual([{ episode: 1 }, { episode: 2 }]);
  });

  it('ranks control exposure before a more severe profit opportunity', () => {
    db.prepare("UPDATE workers SET role = 'OWNER' WHERE id = ?").run(SENIOR);
    applyCompanyIntelligenceFeed(db, feed([
      item({ fingerprint: 'company:profit', severity: 'CRITICAL', controlOverride: false, cediImpactPesewas: 500_000 }),
      item({ fingerprint: 'company:control', title: 'Control issue', severity: 'HIGH', controlOverride: true, cediImpactPesewas: 10_000, category: 'CONTROL' }),
    ]), DEVICE);
    const ranked = listIntelligenceItems(db, owner(), DEVICE, { scope: 'COMPANY' }).items;
    expect(ranked.map((row) => row.fingerprint)).toEqual(['company:control', 'company:profit']);
  });

  it('retains the last successful HQ cache when the next network pull fails', async () => {
    const source = item({});
    const transport = { fetchIntelligence: vi.fn().mockResolvedValueOnce(feed([source])) };
    await pullCompanyIntelligenceOnce(db, transport, DEVICE);
    const cachedAt = getState(db, 'company_intelligence_last_pull_at');
    expect(cachedAt).toEqual(expect.any(String));
    transport.fetchIntelligence.mockRejectedValueOnce(new Error('offline'));
    await expect(pullCompanyIntelligenceOnce(db, transport, DEVICE)).rejects.toThrow(/offline/);
    expect(getState(db, 'company_intelligence_last_pull_at')).toBe(cachedAt);
    expect(db.prepare("SELECT COUNT(*) AS n FROM intelligence_items WHERE scope = 'COMPANY' AND status = 'OPEN'").get())
      .toMatchObject({ n: 1 });
  });
});
