// StartTheBooksPanel — the guided way for a shop that already trades to start
// its books (the ledger cutover).
//
// The old form listed every ledger account by code and wanted the stock value
// typed to the pesewa. Here Counter fills in what its own records already
// know: stock at cost (locked, because it has to match), what customers owe,
// what the shop owes suppliers. The owner only counts the money in each place.
// Whatever stands in the way — an open shift, an unsealed day, an old
// stocktake — is listed with what to do about it.

import { useEffect, useMemo, useRef, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../../shared/lib/money';
import type {
  ManagementAccountsListResponse,
  ManagementCutoverPreviewResponse,
} from '../../../shared/types/ipc';
import { useBankInUse } from '../../store/paymentSettings';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { FeedbackBanner } from '../../components/FeedbackBanner';

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const toPesewas = (raw: string | undefined) => Math.max(0, parseCedisToPesewas(raw ?? '') ?? 0);

export function StartTheBooksPanel({ data, pin, reportAccessToken, onPinConsumed, onStarted }: {
  data: ManagementAccountsListResponse;
  pin: string;
  reportAccessToken: string;
  onPinConsumed: () => void;
  onStarted: () => Promise<void>;
}) {
  const bankInUse = useBankInUse();
  const [startDate, setStartDate] = useState(today);
  const [money, setMoney] = useState<Record<string, string>>({});
  const [records, setRecords] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ManagementCutoverPreviewResponse | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const request = useRef(0);

  const moneyAccounts = data.accounts.filter((account) =>
    account.active && (bankInUse || account.kind !== 'BANK'));
  const suggestions = preview?.suggestedBalances ?? [];
  const otherAccounts = useMemo(() => {
    const taken = new Set([
      ...data.accounts.map((account) => account.ledgerAccountId),
      ...suggestions.map((row) => row.ledgerAccountId),
    ]);
    return data.ledgerAccounts.filter((account) =>
      (account.accountClass === 'ASSET' || account.accountClass === 'LIABILITY' || account.accountClass === 'EQUITY')
      && account.accountSubtype !== 'CASH'
      && account.code !== 'OPENING_EQUITY'
      && !taken.has(account.id));
  }, [data, suggestions]);

  function balances() {
    const lines = [
      ...moneyAccounts.map((account) => ({
        ledgerAccountId: account.ledgerAccountId, amountPesewas: toPesewas(money[account.id]),
      })),
      ...suggestions.map((row) => ({
        ledgerAccountId: row.ledgerAccountId,
        amountPesewas: row.locked ? row.amountPesewas : toPesewas(records[row.ledgerAccountId] ?? formatMoney(row.amountPesewas)),
      })),
      ...otherAccounts.map((account) => ({
        ledgerAccountId: account.id, amountPesewas: toPesewas(other[account.id]),
      })),
    ];
    return lines.filter((line) => line.amountPesewas > 0);
  }

  async function check() {
    const id = ++request.current;
    setChecking(true);
    const result = await counter.managementCutoverPreview({
      cutoverDate: startDate, balances: balances(), reportAccessToken,
    });
    if (id !== request.current) return;
    setChecking(false);
    if (!result.success) {
      setPreview(null);
      setMessage({ tone: 'error', text: result.error });
      return;
    }
    setPreview(result.data);
  }

  // Re-check whenever anything changes, so the checklist and the owner's
  // stake always describe what Start would do.
  const inputs = JSON.stringify([startDate, money, records, other, bankInUse, suggestions.map((row) => row.amountPesewas)]);
  useEffect(() => {
    const timer = window.setTimeout(() => { void check(); }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs]);

  async function sealPriorDay() {
    if (!preview) return;
    setMessage(null);
    const result = await counter.periodSeal(preview.priorDate);
    if (!result.success) {
      setMessage({ tone: 'error', text: result.error });
      return;
    }
    await check();
  }

  async function start() {
    setBusy(true);
    setMessage(null);
    const result = await counter.managementCutoverActivate({
      cutoverDate: startDate, balances: balances(), pin,
      notes: 'Started through Start the books',
    }).finally(onPinConsumed);
    setBusy(false);
    if (!result.success) {
      setMessage({ tone: 'error', text: result.error });
      return;
    }
    setMessage({ tone: 'success', text: `The books are running from ${startDate}.` });
    await onStarted();
  }

  // The first check goes out before Counter has told us the stock value, so a
  // stock mismatch then is ours, not the shop's.
  const stockKnown = suggestions.some((row) => row.locked);
  const blocking = (preview?.issues ?? []).filter((issue) =>
    issue.severity === 'BLOCKING' && (stockKnown || issue.code !== 'OPENING_INVENTORY_MISMATCH'));
  const ready = !!preview && stockKnown && blocking.length === 0;
  const stake = preview?.openingEquityPesewas ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">
        From the day you choose, Counter keeps the shop's full books, so profit, cash and what the shop
        owns and owes are real figures instead of estimates. Do this before the first shift of that day.
      </p>

      <label className="text-sm">
        <span className="block text-xs uppercase tracking-wider text-text-tertiary mb-1">Start the books on</span>
        <Input className="px-2 max-w-48" type="date" value={startDate}
          onChange={(e) => setStartDate(e.target.value)} />
      </label>

      <section aria-label="Before you start">
        <h4 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">Before you start</h4>
        {!preview && <p className="text-sm text-text-tertiary">{checking ? 'Checking…' : 'Not checked yet.'}</p>}
        {preview && blocking.length === 0 && (
          <p className="text-sm text-success">Nothing stands in the way.</p>
        )}
        <ul className="space-y-2">
          {blocking.map((issue) => (
            <li key={`${issue.code}-${issue.message}`} className="text-sm border border-danger/40 bg-danger/5 p-3">
              <div>{issue.message}</div>
              {issue.code === 'PRIOR_DAY_NOT_SEALED' && preview && (
                <Button size="sm" className="mt-2" onClick={() => void sealPriorDay()}>
                  Seal {preview.priorDate}
                </Button>
              )}
              {issue.code === 'OPEN_SHIFTS' && (
                <div className="text-xs text-text-secondary mt-1">
                  Close every shift, your own too. Then come back from the open-shift screen:
                  Management access → Reports.
                </div>
              )}
              {issue.code === 'RECENT_STOCKTAKE_REQUIRED' && (
                <div className="text-xs text-text-secondary mt-1">Home → Stocktake, then come back here.</div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Where is the money">
        <h4 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">Where is the money?</h4>
        <p className="text-xs text-text-secondary mb-2">Count what is in each place now. Leave a place blank if it is empty.</p>
        <div className="grid @xl:grid-cols-2 @4xl:grid-cols-3 gap-2">
          {moneyAccounts.map((account) => (
            <label key={account.id} className="text-sm">
              {account.name}
              <Input className="mt-1 px-2 font-mono" inputMode="decimal" placeholder="GH¢ 0.00"
                value={money[account.id] ?? ''}
                onChange={(e) => setMoney((current) => ({ ...current, [account.id]: e.target.value }))} />
            </label>
          ))}
        </div>
      </section>

      {suggestions.length > 0 && (
        <section aria-label="From Counter's records">
          <h4 className="text-xs uppercase tracking-wider text-text-tertiary mb-2">From Counter's records</h4>
          <div className="grid @xl:grid-cols-2 @4xl:grid-cols-3 gap-2">
            {suggestions.map((row) => (
              <label key={row.ledgerAccountId} className="text-sm">
                {row.label}
                {row.locked ? (
                  <div className="mt-1 px-2 py-2 font-mono tnum border border-border bg-bg-elevated">
                    {formatMoneyWithCurrency(row.amountPesewas)}
                  </div>
                ) : (
                  <Input className="mt-1 px-2 font-mono" inputMode="decimal"
                    value={records[row.ledgerAccountId] ?? formatMoney(row.amountPesewas)}
                    onChange={(e) => setRecords((current) => ({ ...current, [row.ledgerAccountId]: e.target.value }))} />
                )}
                <span className="block text-xs text-text-tertiary mt-1">{row.note}</span>
              </label>
            ))}
          </div>
        </section>
      )}

      {otherAccounts.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-text-secondary">
            Other balances (loans, deposits, equipment) — only if the shop has them
          </summary>
          <div className="grid @xl:grid-cols-2 @4xl:grid-cols-3 gap-2 mt-2">
            {otherAccounts.map((account) => (
              <label key={account.id} className="text-sm">
                {account.name}
                <Input className="mt-1 px-2 font-mono" inputMode="decimal" placeholder="GH¢ 0.00"
                  value={other[account.id] ?? ''}
                  onChange={(e) => setOther((current) => ({ ...current, [account.id]: e.target.value }))} />
              </label>
            ))}
          </div>
        </details>
      )}

      {preview && stockKnown && (
        <p className="text-sm">
          {stake >= 0
            ? <>The owner's stake when the books start: <span className="font-mono tnum">{formatMoneyWithCurrency(stake)}</span></>
            : <>The shop starts <span className="font-mono tnum text-danger">{formatMoneyWithCurrency(-stake)}</span> short: it owes more than it has.</>}
          <span className="block text-xs text-text-tertiary">Money and stock, less what the shop owes.</span>
        </p>
      )}

      {message && <FeedbackBanner tone={message.tone}>{message.text}</FeedbackBanner>}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!ready || !pin || busy} onClick={() => void start()}>
          {busy ? 'Starting…' : `Start the books on ${startDate}`}
        </Button>
        {ready && !pin && (
          <span className="text-xs text-text-secondary">Type your PIN in “Fresh PIN for changes” at the top first.</span>
        )}
      </div>
    </div>
  );
}
