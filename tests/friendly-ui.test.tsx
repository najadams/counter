// @vitest-environment jsdom
//
// Counter Friendly build (COUNTER_FRIENDLY=1): the illustrated home menu, the
// number pad, sign-in, the Home/Back header, and the checkout's guarantees —
// a repeated tap can't post a sale twice and a refused sale keeps what the
// cashier typed. The flag is read when buildFlags loads, so it is set in
// vi.hoisted before any import.

import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState as useStateShim } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { process.env['COUNTER_FRIENDLY'] = '1'; });

const counterMock = vi.hoisted(() => ({
  listLoginCandidates: vi.fn(),
  login: vi.fn(),
  getOpenShift: vi.fn(),
  searchProducts: vi.fn(),
  topSellers: vi.fn(),
  activationStatus: vi.fn(),
  getBestPricingTier: vi.fn(),
  completeSale: vi.fn(),
  searchCustomers: vi.fn(),
  pendingOrderMarkFulfilled: vi.fn(),
  paperReceiptMarkPostedFromTill: vi.fn(),
}));
vi.mock('../src/renderer/lib/ipc', () => ({ counter: counterMock, isDesktopHost: false }));
vi.mock('../src/renderer/lib/feedback', () => ({ chimeSuccess: vi.fn(), chimeWarning: vi.fn(), flashBody: vi.fn() }));

import { FRIENDLY_UI_ENABLED } from '../src/shared/lib/buildFlags';
import { NumberPad, applyNumberPadKey } from '../src/renderer/components/friendly/NumberPad';
import { TaskIllustration } from '../src/renderer/components/friendly/TaskIllustration';
import { FriendlyHomeMenu, type FriendlyHomeCounts } from '../src/renderer/components/friendly/FriendlyHomeMenu';
import { AppHeader } from '../src/renderer/components/AppHeader';
import LoginScreen from '../src/renderer/screens/LoginScreen';
import SaleScreen from '../src/renderer/screens/SaleScreen';
import { useCart } from '../src/renderer/store/cart';
import { useSession } from '../src/renderer/store/session';

const NO_COUNTS: FriendlyHomeCounts = {
  pendingOrders: 0, myVoidRequests: 0, reviewableVoidRequests: 0,
  myStockRequests: 0, reviewableStockRequests: 0,
  openVarianceCases: 0, overdueVarianceCases: 0, unresolvedVariancePesewas: 0,
};

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has no matchMedia; report a mouse (fine pointer) like the counter PC.
  window.matchMedia = vi.fn().mockImplementation(() => ({
    matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  for (const fn of Object.values(counterMock)) fn.mockReset();
});
afterEach(() => {
  cleanup();
  useCart.getState().clear();
});

describe('build flag', () => {
  it('is on for this suite', () => {
    expect(FRIENDLY_UI_ENABLED).toBe(true);
  });
});

describe('TaskIllustration', () => {
  // Real artwork (assets/illustrations/raster/<name>.webp) replaces a line
  // drawing name by name. Every name with no picture on disk must keep its
  // SVG, so the set can be swapped one at a time without blank tiles.
  it('falls back to the line drawing for a name with no raster picture', () => {
    render(<TaskIllustration name="sell" size={48} />);
    const el = document.querySelector('[data-illustration="sell"]') as HTMLElement;
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('aria-hidden');
    if (el.dataset['art'] === 'photo') {
      expect(el.querySelector('img')).toBeInTheDocument();
    } else {
      expect(el.dataset['art']).toBe('line');
      expect(el.querySelector('svg')).toBeInTheDocument();
    }
  });

  it('renders nothing for an unknown name rather than an empty box', () => {
    const { container } = render(
      <TaskIllustration name={'not-a-picture' as never} size={48} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('applyNumberPadKey', () => {
  it('builds PINs, respecting the length cap and allowing a leading zero', () => {
    let v = '';
    for (const k of ['0', '1', '2', '3', '4', '5', '6']) v = applyNumberPadKey(v, k, { maxLength: 6 });
    expect(v).toBe('012345');
    expect(applyNumberPadKey(v, 'back')).toBe('01234');
    expect(applyNumberPadKey(v, 'clear')).toBe('');
    expect(applyNumberPadKey('12', '.', {})).toBe('12');
  });

  it('builds money with one decimal point and at most two decimals', () => {
    expect(applyNumberPadKey('', '.', { allowDecimal: true })).toBe('0.');
    expect(applyNumberPadKey('0', '5', { allowDecimal: true })).toBe('5');
    expect(applyNumberPadKey('12.5', '.', { allowDecimal: true })).toBe('12.5');
    expect(applyNumberPadKey('12.50', '1', { allowDecimal: true })).toBe('12.50');
    expect(applyNumberPadKey('12.5', '0', { allowDecimal: true })).toBe('12.50');
  });
});

describe('NumberPad', () => {
  it('does not steal focus from the paired input, so keyboard typing carries on', () => {
    function Harness() {
      const [v, setV] = useStateShim('');
      return (
        <>
          <input aria-label="amount" value={v} onChange={(e) => setV(e.target.value)} />
          <NumberPad label="pad" value={v} onChange={setV} allowDecimal />
        </>
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('amount');
    input.focus();
    const seven = screen.getByRole('button', { name: '7' });
    // mousedown is prevented, which is what keeps focus in the input.
    expect(fireEvent.mouseDown(seven)).toBe(false);
    fireEvent.click(seven);
    expect(input).toHaveValue('7');
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Decimal point' }));
    fireEvent.click(screen.getByRole('button', { name: '5' }));
    expect(input).toHaveValue('75.5');
    fireEvent.click(screen.getByRole('button', { name: 'Delete last digit' }));
    expect(input).toHaveValue('75.');
  });
});

describe('FriendlyHomeMenu', () => {
  it('shows the six main actions with Sell drinks first', () => {
    render(<FriendlyHomeMenu isSenior={false} cartItemCount={0} counts={NO_COUNTS} onNavigate={vi.fn()} onCloseShift={vi.fn()} />);
    const main = screen.getByRole('region', { name: 'Main actions' });
    const labels = within(main).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['Sell drinks', 'Customers', 'Money out', 'Receive stock', 'Recent sales', 'Today’s summary']);
  });

  it('keeps extra actions in collapsed groups that open on demand', () => {
    const onNavigate = vi.fn();
    render(<FriendlyHomeMenu isSenior={false} cartItemCount={0} counts={NO_COUNTS} onNavigate={onNavigate} onCloseShift={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: /Stock tools/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Count stock' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Count stock' }));
    expect(onNavigate).toHaveBeenCalledWith('stocktake');
    for (const name of [/Orders & receipts/, /Manage shop/]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-expanded', 'false');
    }
  });

  it('hides approval and variance actions from cashiers but shows them to supervisors', () => {
    const openAll = () => {
      for (const name of [/Stock tools/, /Orders & receipts/, /Manage shop/]) fireEvent.click(screen.getByRole('button', { name }));
    };
    const { unmount } = render(<FriendlyHomeMenu isSenior={false} cartItemCount={0} counts={NO_COUNTS} onNavigate={vi.fn()} onCloseShift={vi.fn()} />);
    openAll();
    expect(screen.queryByRole('button', { name: /Approve deliveries/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Review sale cancellations/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Differences to check/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    unmount();
    window.localStorage.clear();

    render(<FriendlyHomeMenu isSenior cartItemCount={0} counts={NO_COUNTS} onNavigate={vi.fn()} onCloseShift={vi.fn()} />);
    openAll();
    expect(screen.getByRole('button', { name: 'Approve deliveries' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review sale cancellations' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Differences to check' })).toBeInTheDocument();
  });

  it('carries notification counts on tiles and on the closed group header', () => {
    render(
      <FriendlyHomeMenu
        isSenior
        cartItemCount={0}
        counts={{ ...NO_COUNTS, pendingOrders: 2, reviewableVoidRequests: 1, myStockRequests: 3 }}
        onNavigate={vi.fn()}
        onCloseShift={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Receive stock, 3 waiting' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Orders & receipts/ })).toHaveTextContent('3');
  });

  it('offers Continue sale while the cart has items, and keeps Close shift apart', () => {
    const onNavigate = vi.fn();
    const onCloseShift = vi.fn();
    render(<FriendlyHomeMenu isSenior={false} cartItemCount={2} counts={NO_COUNTS} onNavigate={onNavigate} onCloseShift={onCloseShift} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue sale' }));
    expect(onNavigate).toHaveBeenCalledWith('sale');
    expect(screen.getByText('2 items are waiting in the cart.')).toBeInTheDocument();
    const main = screen.getByRole('region', { name: 'Main actions' });
    expect(within(main).queryByText('Close shift')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Close shift/ }));
    expect(onCloseShift).toHaveBeenCalled();
  });
});

describe('AppHeader return button', () => {
  it('says Home with the house picture by default', () => {
    const onBack = vi.fn();
    render(<AppHeader subtitle="Sell" onBack={onBack} />);
    const btn = screen.getByRole('button', { name: /Home/ });
    expect(btn.querySelector('[data-illustration="home"]')).not.toBeNull();
    fireEvent.click(btn);
    expect(onBack).toHaveBeenCalled();
  });

  it('uses the caller’s label when it does not go home', () => {
    render(<AppHeader subtitle="customer" onBack={vi.fn()} backLabel="Back to customers" />);
    const btn = screen.getByRole('button', { name: /Back to customers/ });
    expect(btn.querySelector('[data-illustration="home"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Home/ })).toBeNull();
  });
});

describe('LoginScreen', () => {
  beforeEach(() => {
    counterMock.listLoginCandidates.mockResolvedValue({
      success: true,
      data: { workers: [{ id: 'w1', fullName: 'Ama Mensah', role: 'CASHIER' }, { id: 'w2', fullName: 'Kofi Boateng', role: 'SUPERVISOR' }] },
    });
    counterMock.login.mockResolvedValue({ success: true, data: { ok: false, reason: 'INVALID_PIN', attemptsRemaining: 4 } });
    useSession.setState({ loginError: null, loginLockedUntil: null });
  });

  it('signs in with a mix of keypad taps and keyboard typing', async () => {
    render(<LoginScreen />);
    expect(screen.getByRole('heading', { name: 'Choose your name' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Enter your PIN' })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Kofi Boateng/ }));

    const pad = screen.getByRole('group', { name: 'PIN number pad' });
    const signIn = within(pad).getByRole('button', { name: 'Sign in' });
    fireEvent.click(within(pad).getByRole('button', { name: '1' }));
    fireEvent.click(within(pad).getByRole('button', { name: '2' }));
    expect(signIn).toBeDisabled();
    const pinInput = screen.getByLabelText('PIN');
    fireEvent.change(pinInput, { target: { value: '12a34' } });
    expect(pinInput).toHaveValue('1234');
    fireEvent.click(signIn);
    await waitFor(() => expect(counterMock.login).toHaveBeenCalledWith('w2', '1234'));
    expect(await screen.findByText(/Wrong PIN/)).toBeInTheDocument();
    expect(pinInput).toHaveValue('');
  });
});

describe('SaleScreen checkout', () => {
  beforeEach(() => {
    useSession.setState({ shiftId: 'shift-1', workerName: 'Ama', workerRole: 'CASHIER' });
    counterMock.activationStatus.mockResolvedValue({ success: true, data: { salesBlocked: false } });
    counterMock.searchProducts.mockResolvedValue({ success: true, data: { products: [] } });
    counterMock.topSellers.mockResolvedValue({ success: true, data: { products: [] } });
    counterMock.getBestPricingTier.mockResolvedValue({ success: true, data: { tier: null } });
    counterMock.searchCustomers.mockResolvedValue({ success: true, data: { customers: [] } });
    useCart.getState().clear();
    useCart.getState().addLine({
      productId: 'p1', sku: 'COKE', name: 'Coca-Cola 350ml', unitPricePesewas: 800,
      unitsOnHand: 40, unitId: null, unitName: 'BOTTLE', factor: 1, quantity: 2,
    });
  });

  it('keeps keyboard payment keys visible beside Take payment', async () => {
    render(<SaleScreen onExit={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Take payment/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Cash.*F4/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /MoMo.*F5/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Credit.*F6/ })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F4' });
    expect(await screen.findByLabelText('Money received')).toBeInTheDocument();
  });

  it('shows Total, Money received and Change to give, and a repeated tap posts one sale', async () => {
    let resolveSale: (v: unknown) => void = () => {};
    counterMock.completeSale.mockImplementation(() => new Promise((r) => { resolveSale = r; }));
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }));

    const dialog = await screen.findByRole('dialog', { name: 'Take payment' });
    expect(within(dialog).getByText('Total')).toBeInTheDocument();
    const received = within(dialog).getByLabelText('Money received');
    fireEvent.change(received, { target: { value: '20' } });
    expect(within(dialog).getByText('Change to give')).toBeInTheDocument();
    expect(within(dialog).getByText('GHS 4.00')).toBeInTheDocument();

    const complete = within(dialog).getByRole('button', { name: /Complete sale/ });
    fireEvent.click(complete);
    fireEvent.click(complete);
    fireEvent.keyDown(window, { key: 'F2' });
    expect(counterMock.completeSale).toHaveBeenCalledTimes(1);
    expect(counterMock.completeSale.mock.calls[0]![0]).toMatchObject({ paymentMethod: 'CASH', cashGivenPesewas: 2000 });

    await act(async () => {
      resolveSale({ success: true, data: { saleId: 'sale-00000001', changePesewas: 400, printerFailed: false, receipt: null, station: 'counter' } });
    });
    expect(await screen.findByText('Sale complete')).toBeInTheDocument();
    expect(screen.getByText('Change to give')).toBeInTheDocument();
    expect(useCart.getState().lines).toHaveLength(0);
  });

  it('keeps the cart and the amount typed when the sale is refused', async () => {
    counterMock.completeSale.mockResolvedValue({ success: false, error: 'Printer drawer is locked. Try again.' });
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Take payment' });
    fireEvent.change(within(dialog).getByLabelText('Money received'), { target: { value: '50' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Complete sale/ }));

    expect(await within(dialog).findByText('Printer drawer is locked. Try again.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Money received')).toHaveValue('50');
    expect(useCart.getState().lines).toHaveLength(1);
    // A retry is allowed once the first attempt has come back.
    fireEvent.click(within(dialog).getByRole('button', { name: /Complete sale/ }));
    await waitFor(() => expect(counterMock.completeSale).toHaveBeenCalledTimes(2));
  });

  it('Esc closes the checkout without emptying the cart', async () => {
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Take payment/ }));
    await screen.findByRole('dialog', { name: 'Take payment' });
    fireEvent.keyDown(window, { key: 'F5' });
    expect(screen.getByLabelText('MoMo transaction number')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Take payment' })).toBeNull();
    expect(useCart.getState().lines).toHaveLength(1);
  });

  it('keeps split tenders on screen when the split sale is refused', async () => {
    counterMock.completeSale.mockResolvedValue({ success: false, error: 'MoMo reference already used.' });
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Split payment$/ }));
    const [cashAmount, momoAmount] = screen.getAllByPlaceholderText('0.00').slice(-2);
    fireEvent.change(cashAmount!, { target: { value: '10' } });
    fireEvent.change(momoAmount!, { target: { value: '6' } });
    fireEvent.change(screen.getByPlaceholderText('ref / txn id'), { target: { value: '99887766' } });
    const complete = screen.getByRole('button', { name: 'Complete sale' });
    fireEvent.click(complete);
    fireEvent.click(complete);

    expect((await screen.findAllByText('MoMo reference already used.')).length).toBeGreaterThan(0);
    expect(counterMock.completeSale).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Split payment' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('ref / txn id')).toHaveValue('99887766');
  });
  it.each(['F4', 'F5', 'F6'])('opens the same checkout from %s', async (key) => {
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.keyDown(window, { key });
    const dialog = screen.getByRole('dialog', { name: 'Take payment' });
    expect(within(dialog).getByRole('button', { name: key === 'F4' ? 'Cash' : key === 'F5' ? 'MoMo' : 'Pay later' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('isolates split shortcuts, traps focus, and restores the opening control', async () => {
    const exit = vi.fn();
    render(<SaleScreen onExit={exit} />);
    const opener = screen.getByRole('button', { name: /^Split payment$/ });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Split payment' });
    fireEvent.keyDown(window, { key: 'F9' });
    fireEvent.keyDown(window, { key: 'F4' });
    fireEvent.keyDown(window, { key: 'F2' });
    expect(exit).not.toHaveBeenCalled();
    expect(counterMock.completeSale).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Take payment' })).toBeNull();
    // Base UI traps Tab with focus guards around the dialog (they need real
    // layout, so jsdom can't drive them); what it can check is that focus
    // starts inside and the sale screen behind is hidden from assistive tech.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(opener.closest('[aria-hidden="true"]')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
    expect(useCart.getState().lines).toHaveLength(1);
  });

  it('lets only customer creation receive Escape and suspends checkout keys', async () => {
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'F6' });
    const add = screen.getByRole('button', { name: '+ New customer' });
    add.focus(); fireEvent.click(add);
    expect(screen.getByRole('dialog', { name: 'New customer' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'F4' });
    fireEvent.keyDown(window, { key: 'F2' });
    expect(counterMock.completeSale).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Pay later', hidden: true })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New customer' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Take payment' })).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(add));
  });

  it('unlocks after a transport exception without retrying or losing the amount', async () => {
    counterMock.completeSale.mockRejectedValue(new Error('IPC disconnected'));
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'F4' });
    fireEvent.change(screen.getByLabelText('Money received'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /Complete sale/ }));
    expect((await screen.findAllByText(/Check Recent sales before trying again/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Complete sale/ })).toBeEnabled();
    expect(screen.getByLabelText('Money received')).toHaveValue('50');
    expect(counterMock.completeSale).toHaveBeenCalledTimes(1);
    expect(useCart.getState().lines).toHaveLength(1);
  });

  it('blocks close, method changes, cart edits and Home while saving', async () => {
    let resolveSale!: (result: unknown) => void;
    counterMock.completeSale.mockImplementation(() => new Promise((resolve) => { resolveSale = resolve; }));
    const exit = vi.fn();
    render(<SaleScreen onExit={exit} />);
    fireEvent.keyDown(window, { key: 'F4' });
    fireEvent.click(screen.getByRole('button', { name: /Complete sale/ }));
    expect(screen.getByLabelText('Money received')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'MoMo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Back to cart/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Home/, hidden: true })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(window, { key: 'F9' });
    expect(screen.getByRole('dialog', { name: 'Take payment' })).toBeInTheDocument();
    expect(exit).not.toHaveBeenCalled();
    await act(async () => resolveSale({ success: false, error: 'Refused' }));
  });

  it('sends the restock exception explicitly and clears it for the next sale', async () => {
    counterMock.completeSale.mockResolvedValue({ success: true, data: { saleId: 'sale-1', changePesewas: 0, printerFailed: false, receipt: null, station: 'counter' } });
    render(<SaleScreen onExit={vi.fn()} />);
    const checkbox = screen.getByRole('checkbox', { name: /Restock not recorded yet/ });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    fireEvent.keyDown(window, { key: 'F4' });
    fireEvent.click(screen.getByRole('button', { name: /Complete sale/ }));
    await screen.findByRole('dialog', { name: 'Sale complete' });
    expect(counterMock.completeSale.mock.calls[0]![0]).toMatchObject({ allowUnrecordedStock: true });
    fireEvent.click(screen.getByRole('button', { name: 'Next sale' }));
    expect(screen.getByRole('checkbox', { name: /Restock not recorded yet/ })).not.toBeChecked();
  });

  it('keeps change and printer failure visible until Next sale', async () => {
    counterMock.completeSale.mockResolvedValue({ success: true, data: { saleId: 'sale-1', changePesewas: 400, printerFailed: true, printerError: 'Offline', receipt: null, station: 'counter' } });
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'F4' });
    fireEvent.click(screen.getByRole('button', { name: /Complete sale/ }));
    const completed = await screen.findByRole('dialog', { name: 'Sale complete' });
    vi.useFakeTimers();
    try {
      act(() => vi.advanceTimersByTime(30000));
      expect(within(completed).getByText('GHS 4.00')).toBeInTheDocument();
      expect(within(completed).getByText(/sale is saved/i)).toBeInTheDocument();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(completed).toBeInTheDocument();
      fireEvent.click(within(completed).getByRole('button', { name: 'Next sale' }));
      expect(screen.queryByRole('dialog', { name: 'Sale complete' })).toBeNull();
      expect(useCart.getState().lines).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('suspends checkout shortcuts while a supervisor approves a discount', async () => {
    counterMock.listLoginCandidates.mockResolvedValue({ success: true, data: { workers: [{ id: 'sup', fullName: 'Kofi', role: 'SUPERVISOR' }] } });
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '10' } });
    fireEvent.change(screen.getByPlaceholderText('why? (e.g. regular customer)'), { target: { value: 'Approved discount' } });
    fireEvent.keyDown(window, { key: 'F4' });
    fireEvent.click(screen.getByRole('button', { name: /Complete sale/ }));
    const supervisor = await screen.findByRole('dialog', { name: 'Supervisor approval' });
    fireEvent.keyDown(window, { key: 'F5' });
    fireEvent.keyDown(window, { key: 'F2' });
    expect(counterMock.completeSale).not.toHaveBeenCalled();
    // The checkout sits behind a modal now, so it is hidden from the accessibility tree.
    expect(screen.getByRole('button', { name: 'Cash', exact: true, hidden: true })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(supervisor).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Take payment' })).toBeInTheDocument();
  });

  it('retains split amounts after a thrown save and allows an explicit retry', async () => {
    counterMock.completeSale.mockRejectedValue(new Error('Disconnected'));
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Split payment$/ }));
    const dialog = screen.getByRole('dialog', { name: 'Split payment' });
    const amounts = within(dialog).getAllByLabelText('Amount (GHS)');
    fireEvent.change(amounts[0]!, { target: { value: '10' } });
    fireEvent.change(amounts[1]!, { target: { value: '6' } });
    fireEvent.change(within(dialog).getByLabelText('Transaction reference'), { target: { value: 'ref-1' } });
    fireEvent.keyDown(window, { key: 'F2' });
    await within(dialog).findByText(/Check Recent sales/);
    expect(amounts[0]).toHaveValue('10');
    expect(amounts[1]).toHaveValue('6');
    expect(counterMock.completeSale).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: 'F2' });
    await waitFor(() => expect(counterMock.completeSale).toHaveBeenCalledTimes(2));
  });

  it('records the selected MoMo network and reference', async () => {
    counterMock.completeSale.mockResolvedValue({ success: false, error: 'Test refusal' });
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'F5' });
    fireEvent.click(screen.getByRole('button', { name: 'Telecel', exact: true }));
    fireEvent.change(screen.getByLabelText('MoMo transaction number'), { target: { value: 'TX123' } });
    fireEvent.keyDown(window, { key: 'F2' });
    await waitFor(() => expect(counterMock.completeSale).toHaveBeenCalledTimes(1));
    expect(counterMock.completeSale.mock.calls[0]![0]).toMatchObject({ paymentMethod: 'MOMO_VODAFONE', paymentReference: 'TX123' });
    expect(screen.getByLabelText('MoMo transaction number')).toHaveValue('TX123');
  });

  it('requires a customer for Pay later and blocks cash-only customers', async () => {
    counterMock.completeSale.mockResolvedValue({ success: false, error: 'Test refusal' });
    counterMock.searchCustomers.mockResolvedValue({ success: true, data: { customers: [{ id: 'c1', displayName: 'Akosua', phone: '0240000000', currentBalancePesewas: 0, cashOnly: true }] } });
    render(<SaleScreen onExit={vi.fn()} />);
    fireEvent.keyDown(window, { key: 'F6' });
    expect(screen.getByRole('button', { name: /Complete sale/ })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: /Akosua/ }));
    expect(screen.getByRole('button', { name: /Complete sale/ })).toBeDisabled();
    fireEvent.keyDown(window, { key: 'F2' });
    expect(counterMock.completeSale).not.toHaveBeenCalled();
    act(() => useCart.getState().setCustomer({ id:'c2',displayName:'Ama',phone:'0240000001',currentBalancePesewas:0,cashOnly:false }));
    fireEvent.keyDown(window, { key: 'F2' });
    await waitFor(() => expect(counterMock.completeSale).toHaveBeenCalledTimes(1));
    expect(counterMock.completeSale.mock.calls[0]![0]).toMatchObject({ paymentMethod: 'CREDIT', customerId: 'c2' });
  });

});
