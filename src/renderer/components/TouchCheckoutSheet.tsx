// Touch checkout sheet — the one-surface phone closeout.
//
// Replaces the keyboard-first F4/F5/F6 -> modal -> F2 flow on touch devices with
// a single bottom sheet: pick method (defaults to Cash), enter amount/ref/customer,
// confirm. Confirm writes the SAME cart-store fields the desktop PaymentModal
// writes, then calls the parent's submitSale (the one finalize path) — it never
// re-implements validation or the network call. The desktop flow is untouched.
//
// Cash-first (Approach C): opens on Cash with the exact amount pre-filled and a
// numeric keypad, so the dominant tender closes in ~2 taps (open -> confirm).

import { DeleteIcon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { counter } from '../lib/ipc';
import { useCart, type PaymentMethod } from '../store/cart';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import { extractInclusiveVat, VAT_ENABLED } from '../../shared/lib/vat';
import { CustomerCreateModal } from './CustomerCreateModal';
import { FeedbackBanner } from './FeedbackBanner';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Kbd } from './ui/kbd';
import { Sheet, SheetContent, SheetTitle } from './ui/sheet';
import { FRIENDLY_UI_ENABLED } from '../../shared/lib/buildFlags';
import { NumberPad } from './friendly/NumberPad';
import { TaskIllustration } from './friendly/TaskIllustration';

type Cust = ReturnType<typeof useCart.getState>['customer'];

interface TouchCheckoutSheetProps {
  totalPesewas: number;
  paymentReference: string;
  setPaymentReference: (s: string) => void;
  setPaymentMethod: (m: PaymentMethod | null) => void;
  setCashGivenPesewas: (n: number | null) => void;
  customer: Cust;
  setCustomer: (c: Cust) => void;
  submitting: boolean;
  error: string | null;
  /** Calls the parent's submitSale (reads cart state fresh). */
  onSubmit: () => void;
  onClose: () => void;
  onOpenSplit: () => void;
  /** Hybrid PCs (Friendly build): F4/F5/F6 pick the method, F2 completes,
   *  Esc closes — the same keys as the desktop checkout. */
  keyboardShortcuts?: boolean;
  initialMethod?: PaymentMethod;
  /** Dialogs that open on top of the checkout (supervisor approval). They
   *  render inside it so the two stack as parent and child. */
  children?: ReactNode;
}

type Tab = 'CASH' | 'MOMO' | 'CREDIT';

export function TouchCheckoutSheet(p: TouchCheckoutSheetProps): JSX.Element {
  const [tab, setTab] = useState<Tab>(p.initialMethod === 'CREDIT' ? 'CREDIT' : p.initialMethod?.startsWith('MOMO_') ? 'MOMO' : 'CASH');
  const [cashRaw, setCashRaw] = useState(formatMoney(p.totalPesewas)); // exact preset
  const [refRaw, setRefRaw] = useState(p.paymentReference);
  const [momoProvider, setMomoProvider] = useState<PaymentMethod>(p.initialMethod?.startsWith('MOMO_') ? p.initialMethod : 'MOMO_MTN');
  const [showCreate, setShowCreate] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [custHits, setCustHits] = useState<NonNullable<Cust>[]>([]);
  // The exact total is pre-filled; the first key typed replaces it rather than
  // appending to "12.50".
  const [cashPristine, setCashPristine] = useState(true);

  const cashPesewas = useMemo(() => parseCedisToPesewas(cashRaw), [cashRaw]);
  const change = cashPesewas != null ? cashPesewas - p.totalPesewas : null;
  // VAT contained in the inclusive total — null in the no-VAT build. Display only.
  const vat = useMemo(() => (VAT_ENABLED ? extractInclusiveVat(p.totalPesewas) : null), [p.totalPesewas]);

  // Customer search (credit) — mirrors PaymentModal.
  useEffect(() => {
    if (tab !== 'CREDIT') return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await counter.searchCustomers(custQuery, 8);
      if (!cancelled && res.success) setCustHits(res.data.customers as NonNullable<Cust>[]);
    }, 150);
    return () => { cancelled = true; clearTimeout(t); };
  }, [custQuery, tab]);

  // Confirm enablement mirrors submitSale's validation exactly (strict subset),
  // so submitSale's desktop-only failure branches (which open PaymentModal) are
  // never reached on touch.
  const canConfirm =
    (tab === 'CASH' && cashPesewas != null && cashPesewas >= p.totalPesewas) ||
    (tab === 'MOMO' && refRaw.trim() !== '') ||
    (tab === 'CREDIT' && !!p.customer && !p.customer.cashOnly);

  function pressKey(k: string): void {
    setCashRaw((cur) => {
      if (k === '⌫') return cur.slice(0, -1);
      if (k === '.') return cur.includes('.') ? cur : (cur === '' ? '0.' : cur + '.');
      return cur === '0' ? k : cur + k;
    });
  }

  function setCashFromPad(next: string): void {
    setCashPristine(false);
    setCashRaw(next);
  }

  const close = () => { if (!p.submitting) p.onClose(); };
  // Only the topmost dialog gets F-keys, so while New customer is open these
  // never arrive here.
  const onShortcut = (key: string) => {
    if (!p.keyboardShortcuts) return;
    if (key === 'F4') setTab('CASH');
    else if (key === 'F5') setTab('MOMO');
    else if (key === 'F6') setTab('CREDIT');
    else if (key === 'F2') confirmAndComplete();
  };

  function confirmAndComplete(): void {
    if (!canConfirm || p.submitting) return;
    if (tab === 'CASH') {
      p.setPaymentMethod('CASH');
      p.setCashGivenPesewas(cashPesewas);
    } else if (tab === 'MOMO') {
      p.setPaymentMethod(momoProvider);
      p.setPaymentReference(refRaw.trim());
    } else {
      p.setPaymentMethod('CREDIT');
    }
    // submitSale reads these fresh from the store; parent closes the sheet when
    // the cart empties on success.
    p.onSubmit();
  }

  const tabBtn = (t: Tab, label: string): JSX.Element => (
    <button
      type="button"
      onClick={() => setTab(t)}
      aria-pressed={t === tab}
      className={[
        '-mb-px flex-1 py-3 text-base font-semibold border-b-2 transition-colors duration-(--duration-fast)',
        t === tab ? 'border-accent text-accent' : 'border-transparent text-text-secondary hover:text-text-primary',
      ].join(' ')}
    >
      {label}
    </button>
  );

  if (FRIENDLY_UI_ENABLED) {
    const methodBtn = (t: Tab, label: string, art: 'cash' | 'momo' | 'credit', hot: string): JSX.Element => (
      <button
        type="button"
        onClick={() => setTab(t)}
        aria-pressed={t === tab}
        aria-label={label}
        className={[
          'min-h-24 rounded-2xl border-2 flex flex-col items-center justify-center gap-1 px-2 py-2 text-xl font-semibold',
          t === tab ? 'border-accent bg-accent/15 text-text-primary' : 'border-border bg-bg-elevated text-text-primary hover:border-border-strong',
        ].join(' ')}
      >
        <TaskIllustration name={art} size={48} />
        <span>{label}</span>
        {p.keyboardShortcuts && <span aria-hidden className="hidden sm:inline-flex"><Kbd>{hot}</Kbd></span>}
      </button>
    );
    // A bottom sheet on a phone, a centred card from the small breakpoint up.
    return (
      <Dialog onClose={close} busy={p.submitting} onShortcut={onShortcut}>
        <DialogContent
          showCloseButton={false}
          className="w-full sm:w-[min(56rem,calc(100%-3rem))] max-h-[94dvh] gap-0 overflow-hidden rounded-t-3xl rounded-b-none bg-bg-surface p-0 sm:rounded-3xl max-sm:top-auto max-sm:bottom-0 max-sm:translate-y-0 max-sm:data-starting-style:translate-y-8 max-sm:data-starting-style:scale-100"
        >
          <div className="shrink-0 px-5 py-3 border-b border-border flex flex-wrap items-center justify-between gap-3">
            <DialogTitle className="text-2xl sm:text-3xl font-bold">Take payment</DialogTitle>
            <Button type="button" size="xl" onClick={close} disabled={p.submitting} className="rounded-xl border-2 border-border text-lg">
              Back to cart {p.keyboardShortcuts && <span aria-hidden className="hidden sm:inline-flex"><Kbd>Esc</Kbd></span>}
            </Button>
          </div>

          <div className="min-h-0 overflow-y-auto p-5 friendly-checkout-body">
          <fieldset disabled={p.submitting} className="min-w-0 flex flex-col gap-4">
          <div className="rounded-2xl bg-bg-elevated border-2 border-border px-5 py-3 flex items-baseline justify-between gap-3">
            <span className="text-2xl font-semibold">Total</span>
            <span className="text-right">
              <span className="block font-mono tnum text-3xl sm:text-4xl font-bold text-accent whitespace-nowrap">{formatMoneyWithCurrency(p.totalPesewas)}</span>
              {vat && p.totalPesewas > 0 && (
                <span className="block text-base text-text-secondary">
                  incl. VAT <span className="font-mono tnum">{formatMoney(vat.vatPesewas + vat.nhilPesewas + vat.getfundPesewas)}</span>
                </span>
              )}
            </span>
          </div>

          <div role="group" aria-label="How is the customer paying?" className="grid grid-cols-3 gap-2">
            {methodBtn('CASH', 'Cash', 'cash', 'F4')}
            {methodBtn('MOMO', 'MoMo', 'momo', 'F5')}
            {methodBtn('CREDIT', 'Pay later', 'credit', 'F6')}
          </div>

          {tab === 'CASH' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-start">
              <div className="flex flex-col gap-3">
              <label htmlFor="checkout-cash" className="text-xl font-semibold">Money received</label>
              <div className="flex flex-col items-stretch gap-3">
                <Input className="flex-1 border-2 rounded-xl text-4xl font-mono tnum text-right h-auto py-3 px-4"
                  id="checkout-cash"
                  autoFocus
                  value={cashRaw}
                  onChange={(e) => { setCashPristine(false); setCashRaw(e.target.value); }}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmAndComplete(); } }}
                  inputMode="decimal" />
                <Button
                  type="button"
                  size="xl"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setCashRaw(formatMoney(p.totalPesewas)); setCashPristine(true); }}
                  className="rounded-xl border-2 border-border text-lg"
                >
                  <span>Exact amount (<span className="font-mono tnum">{formatMoney(p.totalPesewas)}</span>)</span>
                </Button>
              </div>
              <div
                aria-live="polite"
                className={`rounded-2xl border-2 px-5 py-3 flex flex-wrap items-baseline justify-between gap-x-3 ${change != null && change < 0 ? 'border-danger bg-danger/10' : 'border-success bg-success/10'}`}
              >
                {change != null && change < 0 ? (
                  <>
                    <span className="text-2xl font-semibold text-danger">Not enough money</span>
                    <span className="font-mono tnum text-2xl sm:text-3xl font-bold text-danger whitespace-nowrap">{formatMoneyWithCurrency(-change)} more</span>
                  </>
                ) : (
                  <>
                    <span className="text-2xl font-semibold">Change to give</span>
                    <span className="font-mono tnum text-3xl sm:text-4xl font-bold whitespace-nowrap">{change != null ? formatMoneyWithCurrency(change) : '—'}</span>
                  </>
                )}
              </div>
              </div>
              <NumberPad
                label="Money received number pad"
                value={cashPristine ? '' : cashRaw}
                onChange={setCashFromPad}
                allowDecimal
                disabled={p.submitting}
              />
            </div>
          )}

          {tab === 'MOMO' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-start">
              <div className="flex flex-col gap-3">
              <div role="group" aria-label="MoMo network" className="grid grid-cols-3 gap-2">
                {(['MOMO_MTN', 'MOMO_VODAFONE', 'MOMO_AIRTELTIGO'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={m === momoProvider}
                    onClick={() => setMomoProvider(m)}
                    className={[
                      'min-h-14 rounded-xl border-2 text-xl font-semibold',
                      m === momoProvider ? 'bg-accent/15 border-accent text-text-primary' : 'border-border bg-bg-elevated text-text-primary',
                    ].join(' ')}
                  >
                    {m === 'MOMO_MTN' ? 'MTN' : m === 'MOMO_VODAFONE' ? 'Telecel' : 'AirtelTigo'}
                  </button>
                ))}
              </div>
              <label htmlFor="checkout-momo-ref" className="text-xl font-semibold">MoMo transaction number</label>
              <p className="text-lg text-text-secondary -mt-2">Copy it from the payment message on the phone.</p>
              <Input className="border-2 rounded-xl font-mono text-3xl h-auto py-3 px-4"
                id="checkout-momo-ref"
                autoFocus
                value={refRaw}
                onChange={(e) => setRefRaw(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmAndComplete(); } }}
                inputMode="numeric"
                placeholder="e.g. 7812345678" />
              </div>
              <NumberPad label="Transaction number pad" value={refRaw} onChange={setRefRaw} disabled={p.submitting} />
            </div>
          )}

          {tab === 'CREDIT' && (
            <>
              <p className="text-xl">The customer takes the drinks now and pays later. Choose who.</p>
              <label htmlFor="checkout-customer" className="sr-only">Find customer</label>
              <Input className="border-2 rounded-xl text-2xl h-auto py-3 px-4"
                id="checkout-customer"
                autoFocus
                value={custQuery}
                onChange={(e) => setCustQuery(e.target.value)}
                placeholder="Type a name or phone number" />
              <Button type="button" size="xl" onClick={() => setShowCreate(true)} className="self-start rounded-xl border-2 border-border text-lg">+ New customer</Button>
              <ul className="flex flex-col gap-2 max-h-72 overflow-y-auto">
                {custHits.length === 0 && custQuery.length > 0 && (
                  <li className="text-lg text-text-secondary px-2 py-2">No customer found. Check the spelling or add a new customer.</li>
                )}
                {custHits.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      aria-pressed={p.customer?.id === c.id}
                      onClick={() => p.setCustomer({
                        id: c.id, displayName: c.displayName, businessName: c.businessName, phone: c.phone,
                        currentBalancePesewas: c.currentBalancePesewas,
                        cashOnly: c.cashOnly,
                        preferredChannel: (c as { preferredChannel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null }).preferredChannel ?? null,
                      })}
                      className={[
                        'w-full min-h-16 text-left px-4 py-3 rounded-xl border-2 flex items-center gap-3',
                        p.customer?.id === c.id ? 'border-accent bg-accent/15' : 'border-border bg-bg-elevated',
                      ].join(' ')}
                    >
                      <TaskIllustration name="person" size={40} />
                      <span className="min-w-0">
                        <span className="block text-xl font-semibold">{c.displayName}</span>
                        <span className="block text-base text-text-secondary">
                          {c.phone} · owes {formatMoneyWithCurrency(c.currentBalancePesewas)}{c.cashOnly ? ' · cash only' : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {p.customer && (
                <div className="text-xl">
                  Paying later: <span className="font-semibold">{p.customer.displayName}</span>
                </div>
              )}
              {p.customer?.cashOnly && (
                <FeedbackBanner className="text-lg">{p.customer.displayName} must pay now. Choose Cash or MoMo.</FeedbackBanner>
              )}
              {showCreate && (
                <CustomerCreateModal
                  initialPhone={/^[0+\d]/.test(custQuery) ? custQuery : ''}
                  onCancel={() => setShowCreate(false)}
                  onCreated={(c) => {
                    setShowCreate(false);
                    p.setCustomer({ id: c.id, displayName: c.displayName, businessName: c.businessName, phone: c.phone, currentBalancePesewas: c.currentBalancePesewas, cashOnly: c.cashOnly });
                  }}
                />
              )}
            </>
          )}

          {p.error && <FeedbackBanner className="text-lg">{p.error}</FeedbackBanner>}
          </fieldset>
          </div>
          <footer className="friendly-checkout-footer relative shrink-0 border-t border-border p-4 bg-bg-surface grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">

          <Button
            type="button"
            variant="primary"
            onClick={confirmAndComplete}
            disabled={!canConfirm || p.submitting}
            className="h-auto min-h-20 rounded-2xl text-3xl font-bold"
          >
            {p.submitting ? 'Saving the sale…' : 'Complete sale'}
            {p.keyboardShortcuts && <span aria-hidden className="hidden sm:inline-flex ml-1"><Kbd onAccent>F2</Kbd></span>}
          </Button>
          <Button
            type="button"
            size="xl"
            disabled={p.submitting}
            onClick={p.onOpenSplit}
            className="gap-3 rounded-xl border-2 border-border text-lg"
          >
            <TaskIllustration name="split" size={36} />
            Split payment
          </Button>
          </footer>
          {p.children}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Sheet onClose={close} busy={p.submitting} onShortcut={onShortcut}>
      <SheetContent side="bottom" showCloseButton={false} className="max-h-[90dvh] gap-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <SheetTitle>Take payment</SheetTitle>
            <div className="text-text-tertiary text-sm">
              Total due <span className="font-mono tnum text-text-primary text-lg">{formatMoneyWithCurrency(p.totalPesewas)}</span>
              {vat && p.totalPesewas > 0 && (
                <div className="text-text-tertiary text-xs">
                  incl. VAT{' '}
                  <span className="font-mono tnum">
                    {formatMoney(vat.vatPesewas + vat.nhilPesewas + vat.getfundPesewas)}
                  </span>
                </div>
              )}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={close} disabled={p.submitting} aria-label="Close"><XIcon aria-hidden="true" /></Button>
        </div>

        <div role="group" aria-label="Payment method" className="flex border-b border-border">
          {tabBtn('CASH', 'Cash')}
          {tabBtn('MOMO', 'MoMo')}
          {tabBtn('CREDIT', 'Credit')}
        </div>

        {tab === 'CASH' && (
          <>
            <div className="flex items-center justify-between gap-3">
              <Input
                aria-label="Cash received"
                value={cashRaw}
                onChange={(e) => setCashRaw(e.target.value)}
                inputMode="decimal"
                className="h-14 flex-1 text-3xl font-mono tnum text-right"
              />
              <Button size="xl" className="text-base" onClick={() => setCashRaw(formatMoney(p.totalPesewas))}>
                Exact
              </Button>
            </div>
            {change != null && change >= 0 && (
              <div className="text-text-secondary text-base">Change <span className="font-mono tnum text-text-primary text-xl">{formatMoneyWithCurrency(change)}</span></div>
            )}
            {change != null && change < 0 && (
              <div className="text-danger text-base">Short by <span className="font-mono tnum">{formatMoneyWithCurrency(-change)}</span></div>
            )}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map((k) => (
                <Button size="xl" className="rounded-lg text-2xl font-mono"
                  key={k}
                  type="button"
                  onClick={() => pressKey(k)}
                  aria-label={k === '⌫' ? 'Delete' : undefined}>
                  {k === '⌫' ? <DeleteIcon aria-hidden="true" className="size-6" /> : k}
                </Button>
              ))}
            </div>
          </>
        )}

        {tab === 'MOMO' && (
          <>
            <div role="group" aria-label="MoMo network" className="grid grid-cols-3 gap-2">
              {(['MOMO_MTN', 'MOMO_VODAFONE', 'MOMO_AIRTELTIGO'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={m === momoProvider}
                  onClick={() => setMomoProvider(m)}
                  className={[
                    'rounded-lg px-3 py-3 border text-base font-semibold',
                    m === momoProvider ? 'bg-accent/10 border-accent text-accent' : 'border-border bg-bg-elevated text-text-primary',
                  ].join(' ')}
                >
                  {m === 'MOMO_MTN' ? 'MTN' : m === 'MOMO_VODAFONE' ? 'Telecel' : 'AirtelTigo'}
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-1.5 text-sm text-text-secondary">
              Transaction reference
              <Input
                value={refRaw}
                onChange={(e) => setRefRaw(e.target.value)}
                inputMode="numeric"
                placeholder="e.g. 7812345678"
                className="h-12 font-mono text-lg"
              />
            </label>
          </>
        )}

        {tab === 'CREDIT' && (
          <>
            <Input
              aria-label="Find customer"
              value={custQuery}
              onChange={(e) => setCustQuery(e.target.value)}
              placeholder="Search customer, company, or phone"
              className="h-12 text-lg"
            />
            <Button variant="link" className="self-start" onClick={() => setShowCreate(true)}>+ New customer</Button>
            <ul className="flex flex-col max-h-52 overflow-y-auto rounded-lg border border-border">
              {custHits.length === 0 && custQuery.length > 0 && (
                <li className="text-text-tertiary text-sm px-2 py-2">No matches.</li>
              )}
              {custHits.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={p.customer?.id === c.id}
                    onClick={() => p.setCustomer({
                      id: c.id, displayName: c.displayName, businessName: c.businessName, phone: c.phone,
                      currentBalancePesewas: c.currentBalancePesewas,
                      cashOnly: c.cashOnly,
                      preferredChannel: (c as { preferredChannel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null }).preferredChannel ?? null,
                    })}
                    className={[
                      'w-full text-left px-4 py-3 border-b border-border-subtle',
                      p.customer?.id === c.id ? 'bg-accent/10' : 'bg-bg-elevated hover:bg-bg-surface',
                    ].join(' ')}
                  >
                    <div className="text-text-primary">{c.displayName}</div>
                    {c.businessName && <div className="text-text-secondary text-xs">{c.businessName}</div>}
                    <div className="text-text-tertiary text-xs">
                      {c.phone} · balance <span className="font-mono tnum">{formatMoneyWithCurrency(c.currentBalancePesewas)}</span>
                      {c.cashOnly ? ' · cash only' : ''}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {p.customer && (
              <div className="text-text-secondary text-sm">
                Selected: <span className="text-text-primary">{p.customer.displayName}</span>
                {p.customer.cashOnly && <span className="text-danger ml-2">cash-only</span>}
              </div>
            )}
            {showCreate && (
              <CustomerCreateModal
                initialPhone={/^[0+\d]/.test(custQuery) ? custQuery : ''}
                onCancel={() => setShowCreate(false)}
                onCreated={(c) => {
                  setShowCreate(false);
                  p.setCustomer({ id: c.id, displayName: c.displayName, businessName: c.businessName, phone: c.phone, currentBalancePesewas: c.currentBalancePesewas, cashOnly: c.cashOnly });
                }}
              />
            )}
          </>
        )}

        {p.error && (
          <FeedbackBanner>{p.error}</FeedbackBanner>
        )}

        <Button variant="link" className="self-start text-text-secondary" onClick={p.onOpenSplit} disabled={p.submitting}>Split payment instead</Button>

        <Button
          variant="primary"
          size="xl"
          onClick={confirmAndComplete}
          disabled={!canConfirm || p.submitting}
        >
          {p.submitting ? 'Completing…' : 'Confirm & complete'}
        </Button>
        {tab === 'CREDIT' && p.customer?.cashOnly && (
          <div className="text-danger text-sm">This customer is marked cash-only. Use cash, MoMo, or split without credit.</div>
        )}
        {p.children}
      </SheetContent>
    </Sheet>
  );
}
