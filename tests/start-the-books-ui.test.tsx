// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ManagementAccountsListResponse,
  ManagementCutoverPreviewResponse,
} from '../src/shared/types/ipc';

const api = vi.hoisted(() => ({
  paymentSettingsGet: vi.fn(),
  setupCreateOwner: vi.fn(),
  setupBooksOptions: vi.fn(),
  setupStartBooks: vi.fn(),
  managementCutoverPreview: vi.fn(),
  managementCutoverActivate: vi.fn(),
  periodSeal: vi.fn(),
}));

vi.mock('../src/renderer/lib/ipc', () => ({ counter: api }));

import SetupScreen from '../src/renderer/screens/SetupScreen';
import { StartTheBooksPanel } from '../src/renderer/screens/reports/StartTheBooksPanel';
import { usePaymentSettings } from '../src/renderer/store/paymentSettings';
import { useSession } from '../src/renderer/store/session';

const accounts = [
  { id: 'fa-till', name: 'Counter till', kind: 'TILL' as const },
  { id: 'fa-safe', name: 'Shop safe', kind: 'SAFE' as const },
  { id: 'fa-bank', name: 'Primary bank', kind: 'BANK' as const },
  { id: 'fa-mtn', name: 'MTN MoMo', kind: 'MOMO' as const },
];

beforeEach(() => {
  vi.clearAllMocks();
  api.paymentSettingsGet.mockResolvedValue({ success: true, data: { bankInUse: true } });
  usePaymentSettings.setState({ bankInUse: true, loaded: false });
  useSession.setState({ workerId: null, workerName: null, workerRole: null });
});
afterEach(() => cleanup());

async function createOwnerAndSaveCode() {
  api.setupCreateOwner.mockResolvedValue({
    success: true,
    data: { workerId: 'w-owner', fullName: 'Ama Owner', role: 'OWNER', recoveryCode: 'H7K3-MXN9-PQR2-VFTW' },
  });
  render(<SetupScreen />);
  fireEvent.change(screen.getByPlaceholderText('e.g. Kwame Adams'), { target: { value: 'Ama Owner' } });
  fireEvent.change(screen.getByPlaceholderText('0244 123 456'), { target: { value: '0244123456' } });
  const pins = document.querySelectorAll('input[type="password"]');
  fireEvent.change(pins[0]!, { target: { value: '4321' } });
  fireEvent.change(pins[1]!, { target: { value: '4321' } });
  fireEvent.click(screen.getByRole('radio', { name: /^Drinks/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Create owner account' }));
  fireEvent.click(await screen.findByLabelText('I have written this code down somewhere safe.'));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('first-run setup starts the books', () => {
  it('starts them with the money the shop opens with, leaving the bank out when it does not bank', async () => {
    api.setupBooksOptions.mockResolvedValue({
      success: true, data: { canStart: true, reason: null, bankInUse: true, accounts },
    });
    api.setupStartBooks.mockResolvedValue({
      success: true, data: { cutoverDate: '2026-10-02', openingEquityPesewas: 70_000 },
    });
    await createOwnerAndSaveCode();

    expect(await screen.findByText("Start the shop's books")).toBeInTheDocument();
    expect(screen.getByText('Primary bank')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /pays and gets paid through a bank/ }));
    expect(screen.queryByText('Primary bank')).not.toBeInTheDocument();

    const field = (name: string) => screen.getByText(name).parentElement!.querySelector('input')!;
    fireEvent.change(field('Counter till'), { target: { value: '200' } });
    fireEvent.change(field('MTN MoMo'), { target: { value: '500.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start the books' }));

    await waitFor(() => expect(api.setupStartBooks).toHaveBeenCalledWith({
      bankInUse: false,
      startingMoney: [
        { financialAccountId: 'fa-till', amountPesewas: 20_000 },
        { financialAccountId: 'fa-mtn', amountPesewas: 50_000 },
      ],
    }));
    await waitFor(() => expect(useSession.getState().workerId).toBe('w-owner'));
    expect(usePaymentSettings.getState().bankInUse).toBe(false);
  });

  it('goes straight in when the books cannot be started from setup', async () => {
    api.setupBooksOptions.mockResolvedValue({
      success: true,
      data: { canStart: false, reason: 'The books are already running.', bankInUse: true, accounts },
    });
    await createOwnerAndSaveCode();
    await waitFor(() => expect(useSession.getState().workerId).toBe('w-owner'));
    expect(screen.queryByText("Start the shop's books")).not.toBeInTheDocument();
    expect(api.setupStartBooks).not.toHaveBeenCalled();
  });
});

describe('Start the books for a shop that already trades', () => {
  const data: ManagementAccountsListResponse = {
    accounts: [
      { id: 'fa-till', locationId: 'loc', ledgerAccountId: 'la-till', ledgerAccountCode: 'CASH_TILL_DEFAULT', name: 'Counter till', kind: 'TILL', provider: null, maskedIdentifier: null, allowNegative: false, active: true, balancePesewas: 0, lastReconciledAt: null },
      { id: 'fa-bank', locationId: 'loc', ledgerAccountId: 'la-bank', ledgerAccountCode: 'CASH_BANK_DEFAULT', name: 'Primary bank', kind: 'BANK', provider: null, maskedIdentifier: null, allowNegative: false, active: true, balancePesewas: 0, lastReconciledAt: null },
    ],
    ledgerAccounts: [
      { id: 'la-till', code: 'CASH_TILL_DEFAULT', name: 'Counter till', accountClass: 'ASSET', accountSubtype: 'CASH', normalBalance: 'DEBIT' },
      { id: 'la-bank', code: 'CASH_BANK_DEFAULT', name: 'Primary bank', accountClass: 'ASSET', accountSubtype: 'CASH', normalBalance: 'DEBIT' },
      { id: 'la-inv', code: 'INVENTORY', name: 'Inventory', accountClass: 'ASSET', accountSubtype: 'INVENTORY', normalBalance: 'DEBIT' },
      { id: 'la-ar', code: 'AR', name: 'Customer receivables', accountClass: 'ASSET', accountSubtype: 'CURRENT_ASSET', normalBalance: 'DEBIT' },
      { id: 'la-loan', code: 'LOANS_PAYABLE', name: 'Loans payable', accountClass: 'LIABILITY', accountSubtype: 'LOAN', normalBalance: 'CREDIT' },
      { id: 'la-oe', code: 'OPENING_EQUITY', name: 'Opening balance equity', accountClass: 'EQUITY', accountSubtype: 'OPENING_BALANCE', normalBalance: 'CREDIT' },
    ],
    dataQuality: { status: 'INCOMPLETE', cutoverDate: null, issues: [] },
  };

  function preview(issues: ManagementCutoverPreviewResponse['issues']): ManagementCutoverPreviewResponse {
    return {
      locationId: 'loc', cutoverDate: '2026-10-02', debitPesewas: 0, creditPesewas: 0,
      openingEquityPesewas: 62_000, balances: [], issues, priorDate: '2026-10-01', hasTradingHistory: true,
      suggestedBalances: [
        { ledgerAccountId: 'la-inv', code: 'INVENTORY', label: 'Stock at cost', amountPesewas: 50_000, locked: true, note: 'From the stock records.' },
        { ledgerAccountId: 'la-ar', code: 'AR', label: 'Customers owe the shop', amountPesewas: 12_000, locked: false, note: 'Unpaid credit sales.' },
      ],
    };
  }

  it('lists what stands in the way, seals the day before, and starts with the records filled in', async () => {
    api.managementCutoverPreview.mockResolvedValue({ success: true, data: preview([
      { code: 'PRIOR_DAY_NOT_SEALED', severity: 'BLOCKING', message: 'Seal 2026-10-01, the day before the books start.' },
      { code: 'OPEN_SHIFTS', severity: 'BLOCKING', message: 'Close the 1 open shift(s) first.' },
    ]) });
    api.periodSeal.mockResolvedValue({ success: true, data: { closeId: 'pc-1' } });
    api.managementCutoverActivate.mockResolvedValue({
      success: true, data: { cutoverId: 'fc-1', openingJournalEntryId: 'je-1', openingEquityPesewas: 82_000 },
    });
    const onStarted = vi.fn().mockResolvedValue(undefined);
    const onPinConsumed = vi.fn();
    const { rerender } = render(
      <StartTheBooksPanel data={data} pin="" reportAccessToken="tok"
        onPinConsumed={onPinConsumed} onStarted={onStarted} />,
    );

    expect(await screen.findByText('Seal 2026-10-01, the day before the books start.')).toBeInTheDocument();
    expect(screen.getByText('Stock at cost')).toBeInTheDocument();
    expect(screen.getByText('GHS 500.00')).toBeInTheDocument();
    expect(screen.queryByText('Opening balance equity')).not.toBeInTheDocument();
    const start = screen.getByRole('button', { name: /Start the books on/ });
    expect(start).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Seal 2026-10-01' }));
    await waitFor(() => expect(api.periodSeal).toHaveBeenCalledWith('2026-10-01'));

    api.managementCutoverPreview.mockResolvedValue({ success: true, data: preview([]) });
    const till = screen.getByText('Counter till').parentElement!.querySelector('input')!;
    fireEvent.change(till, { target: { value: '200' } });
    expect(await screen.findByText('Nothing stands in the way.')).toBeInTheDocument();
    expect(screen.getByText(/Type your PIN/)).toBeInTheDocument();

    rerender(
      <StartTheBooksPanel data={data} pin="4321" reportAccessToken="tok"
        onPinConsumed={onPinConsumed} onStarted={onStarted} />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /Start the books on/ })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /Start the books on/ }));
    await waitFor(() => expect(api.managementCutoverActivate).toHaveBeenCalled());
    expect(api.managementCutoverActivate.mock.calls[0]![0]).toMatchObject({
      pin: '4321',
      balances: [
        { ledgerAccountId: 'la-till', amountPesewas: 20_000 },
        { ledgerAccountId: 'la-inv', amountPesewas: 50_000 },
        { ledgerAccountId: 'la-ar', amountPesewas: 12_000 },
      ],
    });
    await waitFor(() => expect(onStarted).toHaveBeenCalled());
    expect(onPinConsumed).toHaveBeenCalled();
  });
});
