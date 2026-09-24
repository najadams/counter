// @vitest-environment jsdom
//
// Quick picks on the sale screen (standard build): tiles from the top-sellers
// query, one tap or Alt+N adds the same cart line a search hit would, and
// Alt+N never reaches the cart behind an open dialog.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counterMock = vi.hoisted(() => ({
  searchProducts: vi.fn(),
  topSellers: vi.fn(),
  activationStatus: vi.fn(),
  getBestPricingTier: vi.fn(),
  searchCustomers: vi.fn(),
  completeSale: vi.fn(),
}));
vi.mock('../src/renderer/lib/ipc', () => ({ counter: counterMock, isDesktopHost: true }));
vi.mock('../src/renderer/lib/feedback', () => ({ chimeSuccess: vi.fn(), chimeWarning: vi.fn(), flashBody: vi.fn() }));

import SaleScreen from '../src/renderer/screens/SaleScreen';
import { quickPickIndex } from '../src/renderer/components/QuickPicks';
import { useCart } from '../src/renderer/store/cart';
import { useSession } from '../src/renderer/store/session';

function hit(id: string, name: string, pricePesewas: number, unit = 'UNIT') {
  return {
    id, sku: id.toUpperCase(), barcode: null, name, brand: null, category: 'BEER',
    unitPricePesewas: pricePesewas, costPricePesewas: 100, unitsOnHand: 24, isReturnable: false,
    defaultUnitId: unit === 'UNIT' ? null : `${id}-${unit}`, defaultUnitName: unit,
    defaultUnitFactor: unit === 'CRATE' ? 24 : 1, canonicalChannelPricePesewas: pricePesewas,
  };
}

let shift = 0;
beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  for (const fn of Object.values(counterMock)) fn.mockReset();
  // A fresh shift per test: picks are held per shift.
  useSession.setState({ shiftId: `shift-qp-${++shift}`, workerName: 'Ama', workerRole: 'CASHIER' });
  counterMock.activationStatus.mockResolvedValue({ success: true, data: { salesBlocked: false } });
  counterMock.searchProducts.mockResolvedValue({ success: true, data: { products: [] } });
  counterMock.getBestPricingTier.mockResolvedValue({ success: true, data: { tier: null } });
  counterMock.searchCustomers.mockResolvedValue({ success: true, data: { customers: [] } });
  useCart.getState().clear();
});
afterEach(() => {
  cleanup();
  useCart.getState().clear();
});

describe('quickPickIndex', () => {
  it('maps Alt+1…Alt+8 by physical key and ignores other chords', () => {
    const k = (code: string, extra: Partial<KeyboardEvent> = {}) =>
      quickPickIndex({ altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, code, ...extra });
    expect(k('Digit1')).toBe(0);
    expect(k('Digit8')).toBe(7);
    expect(k('Digit9')).toBeNull();
    expect(k('Digit1', { altKey: false })).toBeNull();
    expect(k('Digit1', { ctrlKey: true })).toBeNull();
    expect(k('Numpad1')).toBeNull();
  });
});

describe('SaleScreen quick picks', () => {
  it('shows no strip for a shop with no sales yet', async () => {
    counterMock.topSellers.mockResolvedValue({ success: true, data: { products: [] } });
    render(<SaleScreen onExit={vi.fn()} />);
    await act(async () => {});
    expect(counterMock.topSellers).toHaveBeenCalledWith('WALK_IN', 8);
    expect(screen.queryByRole('group', { name: 'Quick picks' })).toBeNull();
  });

  it('adds a pick to the cart on tap and on Alt+N, in its default unit', async () => {
    counterMock.topSellers.mockResolvedValue({ success: true, data: { products: [
      hit('star', 'Star Beer 330ml', 800),
      hit('club', 'Club Premium 330ml', 18000, 'CRATE'),
    ] } });
    render(<SaleScreen onExit={vi.fn()} />);
    const strip = await screen.findByRole('group', { name: 'Quick picks' });
    const star = within(strip).getByRole('button', { name: /Add Star Beer 330ml/ });
    expect(star).toHaveAttribute('aria-keyshortcuts', 'Alt+1');
    expect(within(strip).getByText('180.00')).toBeInTheDocument();

    fireEvent.click(star);
    fireEvent.keyDown(window, { key: '™', code: 'Digit2', altKey: true });
    fireEvent.keyDown(window, { key: '¡', code: 'Digit1', altKey: true });
    const lines = useCart.getState().lines;
    expect(lines.map((l) => [l.productId, l.quantity, l.unitName])).toEqual([
      ['star', 2, 'UNIT'],
      ['club', 1, 'CRATE'],
    ]);
  });

  it('ignores Alt+N while a dialog is open', async () => {
    counterMock.topSellers.mockResolvedValue({ success: true, data: { products: [hit('star', 'Star Beer 330ml', 800)] } });
    useCart.getState().addLine({ productId: 'coke', sku: 'COKE', name: 'Coca-Cola', unitPricePesewas: 500, unitsOnHand: 10 });
    render(<SaleScreen onExit={vi.fn()} />);
    await screen.findByRole('group', { name: 'Quick picks', hidden: true });
    fireEvent.keyDown(window, { key: 'F4' });
    await screen.findByRole('dialog');
    fireEvent.keyDown(window, { key: '¡', code: 'Digit1', altKey: true });
    expect(useCart.getState().lines.map((l) => l.productId)).toEqual(['coke']);
  });
});
