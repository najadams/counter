// HQ-only pull of tenant-scoped company intelligence. The local database is
// the offline cache: a network failure leaves the last successful company
// episodes and freshness metadata readable, with their original timestamps.

import type { Database as DB } from 'better-sqlite3';
import log from 'electron-log/main';
import { v4 as uuidv4 } from 'uuid';
import type { IntelligenceFeedTransport } from '../../shared/sync.js';
import { DEFAULT_LOCATION_ID } from '../../shared/lib/constants.js';
import { applyCompanyIntelligenceFeed } from '../services/intelligence.js';
import { setState } from './state.js';

export interface CompanyIntelligencePullResult {
  generated: number;
  updated: number;
  resolved: number;
}

export async function pullCompanyIntelligenceOnce(
  db: DB, transport: IntelligenceFeedTransport, deviceId: string,
): Promise<CompanyIntelligencePullResult> {
  const runId = `ir-${uuidv4()}`;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  db.prepare(`INSERT INTO intelligence_runs (
    id, location_id, model_family, model_version, trigger_type, status, started_at, device_id
  ) VALUES (?, ?, 'HQ', '1.0.0', 'HQ_PULL', 'RUNNING', ?, ?)`).run(
    runId, DEFAULT_LOCATION_ID, startedAt, deviceId,
  );
  try {
    const feed = await transport.fetchIntelligence();
    const result = applyCompanyIntelligenceFeed(db, feed, deviceId);
    const completedAt = new Date().toISOString();
    setState(db, 'company_intelligence_shops_json', JSON.stringify(feed.shops), completedAt);
    setState(db, 'company_intelligence_last_pull_at', completedAt, completedAt);
    setState(db, 'company_intelligence_feed_generated_at', feed.generatedAt, completedAt);
    db.prepare(`UPDATE intelligence_runs SET status = 'SUCCESS', completed_at = ?,
      source_data_through = ?, generated_count = ?, updated_count = ?, resolved_count = ?,
      duration_ms = ? WHERE id = ?`).run(
      completedAt, feed.sourceDataThrough, result.generated, result.updated,
      result.resolved, Date.now() - startMs, runId,
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`UPDATE intelligence_runs SET status = 'FAILED', completed_at = ?,
      duration_ms = ?, error = ? WHERE id = ?`).run(
      new Date().toISOString(), Date.now() - startMs, message.slice(0, 1000), runId,
    );
    throw error;
  }
}

export interface CompanyIntelligencePullHandle { stop(): void }

export function startCompanyIntelligencePullWorker(
  db: DB, transport: IntelligenceFeedTransport, deviceId: string,
  opts?: { intervalMs?: number },
): CompanyIntelligencePullHandle {
  const intervalMs = opts?.intervalMs ?? 5 * 60_000;
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await pullCompanyIntelligenceOnce(db, transport, deviceId);
    } catch (error) {
      log.warn('[intelligence] company feed failed; cached result remains available:',
        error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}
