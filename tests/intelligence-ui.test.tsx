// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntelligenceBrief, IntelligenceItem } from '../src/shared/types/ipc';

const api = vi.hoisted(() => ({
  getBrief: vi.fn(),
  getCompanyBrief: vi.fn(),
  getItem: vi.fn(),
  list: vi.fn(),
  refresh: vi.fn(),
  transition: vi.fn(),
}));

vi.mock('../src/renderer/lib/ipc', () => ({
  counter: {
    intelligenceGetBrief: api.getBrief,
    intelligenceGetCompanyBrief: api.getCompanyBrief,
    intelligenceGetItem: api.getItem,
    intelligenceList: api.list,
    intelligenceRefresh: api.refresh,
    intelligenceTransition: api.transition,
  },
}));

import { IntelligenceBriefPanel } from '../src/renderer/components/IntelligenceBriefPanel';
import IntelligenceScreen from '../src/renderer/screens/IntelligenceScreen';
import { useSession } from '../src/renderer/store/session';

function item(overrides: Partial<IntelligenceItem> = {}): IntelligenceItem {
  return {
    id: 'ii-1', fingerprint: 'variance:1', episode: 1, locationId: 'loc-main-counter',
    scope: 'LOCAL', sourceShopId: null, modelKey: 'variance-case', modelVersion: '1.0.0',
    category: 'CONTROL', audience: 'SUPERVISOR', severity: 'CRITICAL', status: 'OPEN',
    controlOverride: true, title: 'Till variance requires review',
    recommendation: 'Review the count sheet and source receipts.', cediImpactPesewas: 12_500,
    confidenceBps: 10000, dueAt: '2026-08-03T12:00:00.000Z', validUntil: null,
    sourceDataThrough: '2026-08-04T07:00:00.000Z',
    evidence: [{ label: 'Difference', value: 'GHS 125.00', detail: 'Exact closing-count difference' }],
    rationale: { exactReconciliationDifference: true, thresholdPesewas: 1000 },
    sourceEntityType: 'variance_cases', sourceEntityId: 'vc-1', assignedTo: null,
    assignedToName: null, snoozedUntil: null, resolutionNote: null, dismissalReason: null,
    detectedAt: '2026-08-04T07:00:00.000Z', lastEvaluatedAt: '2026-08-04T08:00:00.000Z',
    closedAt: null, overdue: true, ...overrides,
  };
}

function brief(overrides: Partial<IntelligenceBrief> = {}): IntelligenceBrief {
  return {
    stage: 'FOUNDATION', generatedAt: '2026-08-04T08:00:00.000Z',
    lastRefreshAt: '2026-08-04T08:00:00.000Z', sourceDataThrough: '2026-08-04T07:00:00.000Z',
    stale: false, criticalCount: 1, highCount: 0, openCount: 1,
    totalExposurePesewas: 12_500, items: [item()], ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSession.setState({ workerId: 'owner-1', workerName: 'Ama Owner', workerRole: 'OWNER' });
  api.getBrief.mockResolvedValue({ success: true, data: brief() });
  api.getCompanyBrief.mockResolvedValue({ success: false, error: 'not HQ' });
  api.list.mockResolvedValue({ success: true, data: { items: [item()], total: 1 } });
  api.getItem.mockResolvedValue({ success: true, data: { item: item(), events: [
    { id: 'e-1', eventType: 'GENERATED', fromStatus: null, toStatus: 'OPEN',
      note: 'Condition detected.', actorName: 'SYSTEM', occurredAt: '2026-08-04T07:00:00.000Z' },
  ] } });
  api.refresh.mockResolvedValue({ success: true, data: { skipped: false, generatedCount: 0, updatedCount: 1, resolvedCount: 0, durationMs: 10 } });
  api.transition.mockResolvedValue({ success: true, data: item({ status: 'RESOLVED' }) });
});
afterEach(() => cleanup());

describe('intelligence renderer', () => {
  it('shows the persisted top brief, measurable exposure, freshness, and opens the full queue', async () => {
    const onOpen = vi.fn();
    api.getBrief.mockResolvedValue({ success: true, data: brief({ stale: true }) });
    render(<IntelligenceBriefPanel onOpen={onOpen} />);
    expect(await screen.findByText("Today's brief")).toBeInTheDocument();
    expect(screen.getAllByText('GHS 125.00')).toHaveLength(2);
    expect(screen.getByText(/Intelligence is stale/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Till variance requires review'));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('shows stale-shop state, expands evidence/model explanation, and sends a reasoned lifecycle action', async () => {
    api.getCompanyBrief.mockResolvedValue({ success: true, data: brief({
      stage: 'HQ', companyLastRefreshAt: '2026-08-04T07:30:00.000Z',
      companyShops: [
        { shopId: 'HQ', shopName: 'HQ', role: 'HQ', lastSeenAt: '2026-08-04T07:30:00.000Z', stale: false, includedInPeerBaseline: true },
        { shopId: 'TEMA', shopName: 'Tema', role: 'SHOP', lastSeenAt: '2026-08-01T07:30:00.000Z', stale: true, includedInPeerBaseline: false },
      ],
    }) });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Count sheet reviewed with supervisor');
    render(<IntelligenceScreen onExit={vi.fn()} onNavigate={vi.fn()} />);

    expect(await screen.findByText(/Missing\/stale: Tema/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Till variance requires review'));
    expect(screen.getByText('Exact closing-count difference')).toBeInTheDocument();
    expect(screen.getByText('Why this item ranks here')).toBeInTheDocument();
    expect(screen.getByText(/Exact Reconciliation Difference/i)).toBeInTheDocument();
    expect(screen.getByText(/Advice only/)).toBeInTheDocument();
    expect(await screen.findByText('Lifecycle')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Resolve'));
    await waitFor(() => expect(api.transition).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'ii-1', action: 'RESOLVE', note: 'Count sheet reviewed with supervisor',
    })));
    prompt.mockRestore();
  });
});
