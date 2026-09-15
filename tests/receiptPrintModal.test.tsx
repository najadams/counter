// @vitest-environment jsdom
//
// Regression test for the "long blank leader before the receipt" bug.
//
// The print stylesheet used to hide the app with `body * { visibility: hidden }`
// and then set the overlay to `position: static`. visibility:hidden hides
// pixels but KEEPS the box, so the entire app's height was still laid out and
// printed as blank paper ahead of the receipt. The fix portals the overlay to
// <body> so the stylesheet can `display: none` every sibling outright, which
// removes those boxes from layout.
//
// Both halves matter and neither works without the other, so both are asserted.

import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReceiptPrintModal } from '../src/renderer/components/ReceiptPrintModal';
import type { SaleReceipt } from '../src/shared/lib/receipt';
import type { ReceiptConfigResponse } from '../src/shared/types/ipc';

vi.mock('../src/renderer/lib/ipc', () => ({
  counter: { receiptGetConfig: vi.fn() },
}));

const CONFIG: ReceiptConfigResponse = {
  shopName: 'COUNTER SHOP',
  shopSubtitle: null,
  headerLine3: null,
  headerLine4: null,
  footerText: 'Thank you. Come again.',
  counterPrinterInterface: null,
  doorPrinterInterface: null,
  paperWidthMm: 80,
  sideMarginMm: 2,
  density: 'normal',
  bold: true,
  showCashier: true,
  showChannel: true,
  showCustomer: true,
  showVatBreakdown: true,
  vatRegistrationNumber: null,
};

const RECEIPT: SaleReceipt = {
  shopName: 'COUNTER SHOP',
  receiptId: 'sale-abcdef12',
  workerName: 'Ama',
  saleAt: '2026-09-13T10:30:00.000Z',
  channel: 'WALK_IN',
  lines: [{ quantity: 2, name: 'Coca-Cola 350ml', unitPricePesewas: 800, lineTotalPesewas: 1600 }],
  subtotalPesewas: 1600,
  discountPesewas: 0,
  totalPesewas: 1600,
  payment: { method: 'CASH', cashGivenPesewas: 2000, changePesewas: 400 },
};

afterEach(cleanup);

describe('ReceiptPrintModal print layout', () => {
  it('portals the overlay to <body> so siblings can be removed from layout', () => {
    // Mimic the real tree: the modal is mounted deep inside the app, not at root.
    const appRoot = document.createElement('div');
    appRoot.id = 'root';
    document.body.appendChild(appRoot);

    render(<ReceiptPrintModal receipt={RECEIPT} config={CONFIG} onClose={() => {}} />, {
      container: appRoot.appendChild(document.createElement('div')),
    });

    const overlay = document.querySelector('.receipt-print-overlay');
    expect(overlay).not.toBeNull();
    // The whole point: a direct child of <body>, NOT nested inside #root.
    expect(overlay!.parentElement).toBe(document.body);
    expect(appRoot.contains(overlay)).toBe(false);
  });

  it('removes non-receipt content from layout instead of merely hiding it', () => {
    render(<ReceiptPrintModal receipt={RECEIPT} config={CONFIG} onClose={() => {}} />);
    const css = document.querySelector('.receipt-print-overlay style')?.textContent ?? '';

    // display:none drops the box; visibility:hidden would keep printing it blank.
    expect(css).toMatch(/body\s*>\s*\*:not\(\.receipt-print-overlay\)\s*\{\s*display:\s*none/);
    expect(css).not.toMatch(/body\s*\*\s*\{\s*visibility:\s*hidden/);

    // Continuous roll, no page margins — otherwise the driver reintroduces a gap.
    expect(css).toMatch(/@page\s*\{\s*size:\s*80mm\s+auto;\s*margin:\s*0/);
  });
});
