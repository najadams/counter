// @vitest-environment jsdom
//
// Settings → Printers: the owner picks the receipt printer from the printers
// installed on the host — no typing its exact name, no making it the OS
// default — and a USB printer with no driver is set up from the same screen.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReceiptConfigResponse, ReceiptInstalledPrinter } from '../src/shared/types/ipc';

// The theme store reads matchMedia when it is imported.
vi.hoisted(() => {
  window.matchMedia = ((() => ({
    matches: false, addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {},
  })) as unknown) as typeof window.matchMedia;
});

const counterMock = vi.hoisted(() => ({
  receiptGetConfig: vi.fn(),
  receiptSetConfig: vi.fn(),
  receiptTestPrinter: vi.fn(),
  receiptListPrinters: vi.fn(),
  receiptSetupUsbPrinter: vi.fn(),
}));
vi.mock('../src/renderer/lib/ipc', () => ({ counter: counterMock, isDesktopHost: true }));

import { AppearanceTab } from '../src/renderer/screens/settings/AppearanceTab';
import { useSession } from '../src/renderer/store/session';

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

const PDF: ReceiptInstalledPrinter = { name: 'Microsoft Print to PDF', isDefault: true, offline: false, port: 'PORTPROMPT:', usb: false };
const POS: ReceiptInstalledPrinter = { name: 'POS-80', isDefault: false, offline: false, port: 'USB001', usb: true };

function listed(printers: ReceiptInstalledPrinter[], canSetupUsb = true) {
  return { success: true, data: { printers, canSetupUsb } };
}

beforeEach(() => {
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  for (const fn of Object.values(counterMock)) fn.mockReset();
  useSession.setState({ workerName: 'Naj', workerRole: 'OWNER' });
  counterMock.receiptGetConfig.mockResolvedValue({ success: true, data: CONFIG });
  counterMock.receiptSetConfig.mockImplementation(async (req: ReceiptConfigResponse) => ({ success: true, data: req }));
  counterMock.receiptTestPrinter.mockResolvedValue({ success: true, data: { ok: true, printed: true } });
});

afterEach(cleanup);

async function renderTab() {
  await act(async () => { render(<AppearanceTab />); });
}

function counterPicker(): HTMLSelectElement {
  return screen.getByLabelText('Counter printer on this computer') as HTMLSelectElement;
}

describe('printer picker', () => {
  it('lists the host printers, USB first, and saves the chosen one', async () => {
    counterMock.receiptListPrinters.mockResolvedValue(listed([POS, PDF]));
    await renderTab();

    const options = within(counterPicker()).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Choose a printer…', 'POS-80 · USB', 'Microsoft Print to PDF · default']);

    fireEvent.change(counterPicker(), { target: { value: 'POS-80' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save receipt settings' })); });
    expect(counterMock.receiptSetConfig).toHaveBeenCalledWith(
      expect.objectContaining({ counterPrinterInterface: 'printer:POS-80', doorPrinterInterface: null }),
    );
  });

  it('defaults the door to the counter printer, and lets it be tested', async () => {
    counterMock.receiptListPrinters.mockResolvedValue(listed([POS]));
    await renderTab();
    expect(screen.getByRole('radio', { name: /Same as Counter/ })).toBeChecked();
    expect(screen.getByText(/Phone and tablet sales print on the Counter printer/)).toBeInTheDocument();
  });

  it('keeps a saved printer that is missing now, marked as not found', async () => {
    counterMock.receiptGetConfig.mockResolvedValue({ success: true, data: { ...CONFIG, counterPrinterInterface: 'printer:Old XP' } });
    counterMock.receiptListPrinters.mockResolvedValue(listed([POS]));
    await renderTab();
    expect(counterPicker().value).toBe('Old XP');
    expect(within(counterPicker()).getByRole('option', { name: 'Old XP · not found on this computer' })).toBeInTheDocument();
  });

  it('sets up a driver-less USB printer and selects it', async () => {
    counterMock.receiptListPrinters
      .mockResolvedValueOnce(listed([PDF]))
      .mockResolvedValue(listed([{ ...POS, name: 'Counter Receipt' }, PDF]));
    counterMock.receiptSetupUsbPrinter.mockResolvedValue({
      success: true, data: { ok: true, printerName: 'Counter Receipt', port: 'USB001', created: true },
    });
    await renderTab();

    expect(screen.getAllByText(/No USB printer is installed/)[0]).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Set up USB receipt printer' })[0]!);
    });
    expect(counterMock.receiptSetupUsbPrinter).toHaveBeenCalledTimes(1);
    expect(counterPicker().value).toBe('Counter Receipt');
    expect(screen.getByText(/"Counter Receipt" is ready on USB001/)).toBeInTheDocument();
  });

  it('shows why setup failed, e.g. the Windows prompt was declined', async () => {
    counterMock.receiptListPrinters.mockResolvedValue(listed([]));
    counterMock.receiptSetupUsbPrinter.mockResolvedValue({
      success: true, data: { ok: false, reason: 'CANCELLED', message: 'Setup was cancelled at the Windows prompt.' },
    });
    await renderTab();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Set up USB receipt printer' })[0]!);
    });
    expect(screen.getByText('Setup was cancelled at the Windows prompt.')).toBeInTheDocument();
  });

  it('offers no USB setup off Windows', async () => {
    counterMock.receiptListPrinters.mockResolvedValue(listed([], false));
    await renderTab();
    expect(screen.queryByRole('button', { name: 'Set up USB receipt printer' })).not.toBeInTheDocument();
    expect(screen.getAllByText(/add it in this computer's printer settings/)[0]).toBeInTheDocument();
  });
});
