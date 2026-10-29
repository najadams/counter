// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagementKeptAndFree } from '../src/shared/types/ipc';

const api = vi.hoisted(() => ({
  paymentSettingsGet: vi.fn(),
  paymentSettingsSet: vi.fn(),
}));

vi.mock('../src/renderer/lib/ipc', () => ({ counter: api }));

import { KeptAndFreeView } from '../src/renderer/screens/reports/OwnerManagementTab';
import { SplitPaymentModal } from '../src/renderer/components/SplitPaymentModal';
import { PaymentsTab } from '../src/renderer/screens/settings/PaymentsTab';
import { usePaymentSettings } from '../src/renderer/store/paymentSettings';
import { useSession } from '../src/renderer/store/session';

function keptAndFree(overrides: Partial<ManagementKeptAndFree> = {}): ManagementKeptAndFree {
  return {
    cutoverDate: '2026-09-01',
    profitSinceCutoverPesewas: 500_000, ownerDrawingsPesewas: 120_000, profitKeptPesewas: 380_000,
    cashOnHandPesewas: 900_000, notCountedRecentlyPesewas: 40_000,
    cashAccounts: [
      { code: 'CASH_TILL_DEFAULT', label: 'Counter till', amountPesewas: 40_000, note: 'Not counted recently' },
      { code: 'CASH_MOMO_MTN', label: 'MTN MoMo', amountPesewas: 860_000, note: null },
    ],
    overdueBillsPesewas: 10_000, dueNext7DaysPesewas: 50_000, dueNext30DaysPesewas: 200_000,
    undatedBillsPesewas: 5_000, taxOwedPesewas: 0,
    freeCashAfter7DaysPesewas: 835_000, freeCashAfter30DaysPesewas: 685_000,
    bankInUse: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.paymentSettingsGet.mockResolvedValue({ success: true, data: { bankInUse: true } });
  usePaymentSettings.setState({ bankInUse: true, loaded: false });
  useSession.setState({ workerId: 'owner-1', workerName: 'Ama Owner', workerRole: 'OWNER' });
});
afterEach(() => cleanup());

describe('kept and free card', () => {
  it('answers how much profit was kept and how much money is free to spend', () => {
    render(<KeptAndFreeView data={keptAndFree()} compact={false} />);
    expect(screen.getByText(
      'Since 2026-09-01 the shop has kept GHS 3,800.00 of its profit. '
      + 'GHS 6,850.00 of the GHS 9,000.00 on hand is free after bills due in the next 30 days.',
    )).toBeInTheDocument();
    expect(screen.getByText('Free after 7 days of bills')).toBeInTheDocument();
    expect(screen.getByText('GHS 8,350.00')).toBeInTheDocument();
    expect(screen.getByText('Less taken out by the owner')).toBeInTheDocument();
    expect(screen.getByText("GHS 400.00 of this hasn't been counted recently.")).toBeInTheDocument();
    expect(screen.getByText('Where the money is')).toBeInTheDocument();
    expect(screen.getByText('MTN MoMo')).toBeInTheDocument();
  });

  it('says plainly when the shop is behind and the bills coming due are more than the money on hand', () => {
    render(<KeptAndFreeView data={keptAndFree({
      profitKeptPesewas: -223_200, freeCashAfter30DaysPesewas: -25_000,
    })} compact />);
    expect(screen.getByText(
      'Since 2026-09-01 the shop is GHS 2,232.00 behind: losses and what the owner took out are more than the profit. '
      + 'Bills due in the next 30 days are GHS 250.00 more than the GHS 9,000.00 on hand.',
    )).toBeInTheDocument();
    expect(screen.queryByText('Where the money is')).not.toBeInTheDocument();
  });

  it('points to the ledger cutover before there is anything to show', () => {
    const onFixCutover = vi.fn();
    render(<KeptAndFreeView data={null} compact onFixCutover={onFixCutover} />);
    expect(screen.getByText(/Shown once the shop's books have started/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start the books' }));
    expect(onFixCutover).toHaveBeenCalledOnce();
  });
});

describe('bank in use', () => {
  function renderSplit() {
    return render(
      <SplitPaymentModal totalPesewas={1000} hasCustomer={false}
        onCancel={() => undefined} onConfirm={() => undefined} />,
    );
  }

  it('offers Bank transfer at checkout while the shop banks', async () => {
    renderSplit();
    await waitFor(() => expect(api.paymentSettingsGet).toHaveBeenCalled());
    expect(screen.getAllByRole('option', { name: 'Bank transfer' }).length).toBeGreaterThan(0);
  });

  it('hides Bank transfer at checkout once the owner says the shop does not bank', async () => {
    api.paymentSettingsGet.mockResolvedValue({ success: true, data: { bankInUse: false } });
    renderSplit();
    await waitFor(() => expect(screen.queryAllByRole('option', { name: 'Bank transfer' })).toHaveLength(0));
    expect(screen.getAllByRole('option', { name: 'Cash' }).length).toBeGreaterThan(0);
  });

  it('lets the owner switch the bank off in Settings', async () => {
    api.paymentSettingsSet.mockResolvedValue({ success: true, data: { bankInUse: false } });
    render(<PaymentsTab />);
    const box = screen.getByRole('checkbox', { name: /pays and gets paid through a bank/ });
    await waitFor(() => expect(box).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(box);
    await waitFor(() => expect(api.paymentSettingsSet).toHaveBeenCalledWith({ bankInUse: false }));
    expect(await screen.findByText('Bank transfer is now hidden.')).toBeInTheDocument();
    expect(usePaymentSettings.getState().bankInUse).toBe(false);
  });

  it('shows the switch read-only to a cashier', () => {
    useSession.setState({ workerRole: 'CASHIER' });
    render(<PaymentsTab />);
    expect(screen.getByRole('checkbox', { name: /pays and gets paid through a bank/ }))
      .toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Only OWNER or FOUNDER can change this.')).toBeInTheDocument();
  });
});
