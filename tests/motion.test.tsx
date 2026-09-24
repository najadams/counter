// @vitest-environment jsdom
//
// Motion (docs/design-system.md, "Shape, depth, motion"). jsdom can't watch an
// animation run, so this holds the parts that matter: reduced motion still
// switches everything off, screens fade in by CSS alone (no View Transitions,
// which would apply a screen change a frame late), new cart lines and changed
// totals are marked to animate, and the report skeleton says it's loading.

import '@testing-library/jest-dom/vitest';
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counterMock = vi.hoisted(() => ({
  searchProducts: vi.fn(),
  topSellers: vi.fn(),
  activationStatus: vi.fn(),
  getBestPricingTier: vi.fn(),
  searchCustomers: vi.fn(),
}));
vi.mock('../src/renderer/lib/ipc', () => ({ counter: counterMock, isDesktopHost: true }));
vi.mock('../src/renderer/lib/feedback', () => ({ chimeSuccess: vi.fn(), chimeWarning: vi.fn(), flashBody: vi.fn() }));

import SaleScreen from '../src/renderer/screens/SaleScreen';
import { ReportSkeleton } from '../src/renderer/components/ReportSkeleton';
import { useCart } from '../src/renderer/store/cart';
import { useSession } from '../src/renderer/store/session';

const CSS = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles', 'index.css'), 'utf-8');

describe('motion stylesheet', () => {
  it('switches every animation and transition off under reduced motion', () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(CSS)?.[1] ?? '';
    expect(block).toMatch(/\*, ::before, ::after \{[^}]*animation-duration: 0\.01ms !important/);
    expect(block).toMatch(/\*, ::before, ::after \{[^}]*transition-duration: 0\.01ms !important/);
  });

  it('fades each new screen in with CSS, not the View Transitions API', () => {
    expect(CSS).toMatch(/#root > \* \{\s*animation: screen-in /);
    const renderer = path.join(__dirname, '..', 'src', 'renderer');
    const uses = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? uses(path.join(dir, e.name))
        : /\.tsx?$/.test(e.name) && fs.readFileSync(path.join(dir, e.name), 'utf-8').includes('startViewTransition') ? [e.name] : []);
    expect(uses(renderer)).toEqual([]);
  });
});

describe('cart motion', () => {
  beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    for (const fn of Object.values(counterMock)) fn.mockReset();
    useSession.setState({ shiftId: 'shift-motion', workerName: 'Ama', workerRole: 'CASHIER' });
    counterMock.activationStatus.mockResolvedValue({ success: true, data: { salesBlocked: false } });
    counterMock.searchProducts.mockResolvedValue({ success: true, data: { products: [] } });
    counterMock.topSellers.mockResolvedValue({ success: true, data: { products: [] } });
    counterMock.getBestPricingTier.mockResolvedValue({ success: true, data: { tier: null } });
    counterMock.searchCustomers.mockResolvedValue({ success: true, data: { customers: [] } });
    useCart.getState().clear();
  });
  afterEach(() => { cleanup(); useCart.getState().clear(); });

  it('marks a new line to ease in and re-mounts its total when the quantity changes', async () => {
    useCart.getState().addLine({ productId: 'star', sku: 'STAR', name: 'Star Beer 330ml', unitPricePesewas: 800, unitsOnHand: 24 });
    render(<SaleScreen onExit={vi.fn()} />);
    await act(async () => {});
    const line = screen.getByText('Star Beer 330ml').closest('li')!;
    expect(line).toHaveClass('animate-cart-line-in');
    const before = screen.getAllByText('8.00').find((el) => el.classList.contains('animate-value-bump'))!;
    expect(before).toBeTruthy();

    act(() => { useCart.getState().addLine({ productId: 'star', sku: 'STAR', name: 'Star Beer 330ml', unitPricePesewas: 800, unitsOnHand: 24 }); });
    const after = screen.getAllByText('16.00').find((el) => el.classList.contains('animate-value-bump'))!;
    // A new element, so the bump plays again; the same line stays put.
    expect(after).not.toBe(before);
    expect(screen.getByText('Star Beer 330ml').closest('li')).toBe(line);
  });
});

describe('ReportSkeleton', () => {
  it('announces what is loading and hides its placeholder blocks', () => {
    render(<ReportSkeleton label="Loading dashboard…" stats={3} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading dashboard…');
    expect(status.querySelectorAll('[data-slot="skeleton"][aria-hidden="true"]').length).toBeGreaterThan(3);
  });
});
