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

import { useEffect, useMemo, useState } from 'react';
import { counter } from '../lib/ipc';
import { useCart, type PaymentMethod } from '../store/cart';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import { CustomerCreateModal } from './CustomerCreateModal';

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
}

type Tab = 'CASH' | 'MOMO' | 'CREDIT';

export function TouchCheckoutSheet(p: TouchCheckoutSheetProps): JSX.Element {
  const [tab, setTab] = useState<Tab>('CASH');
  const [cashRaw, setCashRaw] = useState(formatMoney(p.totalPesewas)); // exact preset
  const [refRaw, setRefRaw] = useState(p.paymentReference);
  const [momoProvider, setMomoProvider] = useState<PaymentMethod>('MOMO_MTN');
  const [showCreate, setShowCreate] = useState(false);
  const [custQuery, setCustQuery] = useState('');
  const [custHits, setCustHits] = useState<NonNullable<Cust>[]>([]);

  const cashPesewas = useMemo(() => parseCedisToPesewas(cashRaw), [cashRaw]);
  const change = cashPesewas != null ? cashPesewas - p.totalPesewas : null;

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
    (tab === 'CREDIT' && !!p.customer);

  function pressKey(k: string): void {
    setCashRaw((cur) => {
      if (k === '⌫') return cur.slice(0, -1);
      if (k === '.') return cur.includes('.') ? cur : (cur === '' ? '0.' : cur + '.');
      return cur === '0' ? k : cur + k;
    });
  }

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
      onClick={() => setTab(t)}
      className={[
        'flex-1 py-3 text-base font-semibold border-b-2',
        t === tab ? 'border-accent text-accent' : 'border-transparent text-text-secondary',
      ].join(' ')}
    >
      {label}
    </button>
  );

  return (
    <div className="fixed inset-0 bg-scrim flex items-end z-50" onClick={p.onClose}>
      <div
        className="bg-bg-surface border-t border-border w-full max-h-[90vh] overflow-y-auto rounded-t-2xl p-5 flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="text-text-tertiary text-sm">
            Total due <span className="font-mono tnum text-text-primary text-lg">{formatMoneyWithCurrency(p.totalPesewas)}</span>
          </div>
          <button onClick={p.onClose} className="text-text-secondary text-2xl leading-none px-2" aria-label="Close">×</button>
        </div>

        <div className="flex border-b border-border">
          {tabBtn('CASH', 'Cash')}
          {tabBtn('MOMO', 'MoMo')}
          {tabBtn('CREDIT', 'Credit')}
        </div>

        {tab === 'CASH' && (
          <>
            <div className="flex items-center justify-between gap-3">
              <input
                value={cashRaw}
                onChange={(e) => setCashRaw(e.target.value)}
                inputMode="decimal"
                className="bg-bg-input border border-border-strong px-4 py-3 text-3xl font-mono tnum text-right flex-1 min-w-0"
              />
              <button
                onClick={() => setCashRaw(formatMoney(p.totalPesewas))}
                className="px-4 py-3 border border-border text-text-primary hover:bg-bg-elevated whitespace-nowrap"
              >
                Exact
              </button>
            </div>
            {change != null && change >= 0 && (
              <div className="text-text-secondary text-base">Change <span className="font-mono tnum text-text-primary text-xl">{formatMoneyWithCurrency(change)}</span></div>
            )}
            {change != null && change < 0 && (
              <div className="text-danger text-base">Short by {formatMoneyWithCurrency(-change)}</div>
            )}
            <div className="grid grid-cols-3 gap-2">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map((k) => (
                <button
                  key={k}
                  onClick={() => pressKey(k)}
                  className="py-4 text-2xl font-mono border border-border bg-bg-deep text-text-primary hover:bg-bg-elevated active:bg-bg-elevated"
                >
                  {k}
                </button>
              ))}
            </div>
          </>
        )}

        {tab === 'MOMO' && (
          <>
            <div className="grid grid-cols-3 gap-2">
              {(['MOMO_MTN', 'MOMO_VODAFONE', 'MOMO_AIRTELTIGO'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMomoProvider(m)}
                  className={[
                    'px-3 py-3 border text-base',
                    m === momoProvider ? 'bg-bg-elevated border-accent text-accent' : 'border-border bg-bg-deep text-text-primary',
                  ].join(' ')}
                >
                  {m === 'MOMO_MTN' ? 'MTN' : m === 'MOMO_VODAFONE' ? 'Telecel' : 'AirtelTigo'}
                </button>
              ))}
            </div>
            <label className="text-text-secondary text-xs uppercase tracking-wider">Transaction reference</label>
            <input
              value={refRaw}
              onChange={(e) => setRefRaw(e.target.value)}
              inputMode="numeric"
              placeholder="e.g. 7812345678"
              className="bg-bg-input border border-border-strong px-4 py-3 font-mono text-lg"
            />
          </>
        )}

        {tab === 'CREDIT' && (
          <>
            <input
              value={custQuery}
              onChange={(e) => setCustQuery(e.target.value)}
              placeholder="Search customer (name or phone)"
              className="bg-bg-input border border-border-strong px-4 py-3 text-lg"
            />
            <button onClick={() => setShowCreate(true)} className="self-start text-accent text-sm">+ New customer</button>
            <ul className="flex flex-col max-h-52 overflow-y-auto">
              {custHits.length === 0 && custQuery.length > 0 && (
                <li className="text-text-tertiary text-sm px-2 py-2">No matches.</li>
              )}
              {custHits.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => p.setCustomer({
                      id: c.id, displayName: c.displayName, phone: c.phone,
                      currentBalancePesewas: c.currentBalancePesewas,
                      preferredChannel: (c as { preferredChannel?: 'WALK_IN' | 'WHOLESALE' | 'ROUTE' | null }).preferredChannel ?? null,
                    })}
                    className={[
                      'w-full text-left px-4 py-3 border-b border-border',
                      p.customer?.id === c.id ? 'bg-bg-elevated' : 'bg-bg-deep',
                    ].join(' ')}
                  >
                    <div className="text-text-primary">{c.displayName}</div>
                    <div className="text-text-tertiary text-xs">{c.phone} · balance {formatMoneyWithCurrency(c.currentBalancePesewas)}</div>
                  </button>
                </li>
              ))}
            </ul>
            {p.customer && (
              <div className="text-text-secondary text-sm">Selected: <span className="text-text-primary">{p.customer.displayName}</span></div>
            )}
            {showCreate && (
              <CustomerCreateModal
                initialPhone={/^[0+\d]/.test(custQuery) ? custQuery : ''}
                onCancel={() => setShowCreate(false)}
                onCreated={(c) => {
                  setShowCreate(false);
                  p.setCustomer({ id: c.id, displayName: c.displayName, phone: c.phone, currentBalancePesewas: c.currentBalancePesewas });
                }}
              />
            )}
          </>
        )}

        {p.error && (
          <div className="bg-bg-deep border border-danger px-4 py-2 text-danger text-sm">{p.error}</div>
        )}

        <button onClick={p.onOpenSplit} className="text-text-tertiary text-sm underline self-start">Split payment instead</button>

        <button
          onClick={confirmAndComplete}
          disabled={!canConfirm || p.submitting}
          className="bg-accent text-ink py-4 text-lg font-semibold rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {p.submitting ? 'Completing…' : 'Confirm & complete'}
        </button>
      </div>
    </div>
  );
}
