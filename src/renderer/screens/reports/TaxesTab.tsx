import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../../shared/lib/money';
import type { ReportsTaxesResponse, ReportsTaxPaymentRecordRequest } from '../../../shared/types/ipc';
import { DateRangePicker, defaultDateRange, type DateRange } from '../../components/DateRangePicker';
import { FeedbackBanner } from '../../components/FeedbackBanner';

type TaxPaymentMethod = ReportsTaxPaymentRecordRequest['paymentMethod'];

const PAYMENT_METHODS: Array<{ code: TaxPaymentMethod; label: string }> = [
  { code: 'BANK_TRANSFER', label: 'Bank transfer' },
  { code: 'MOMO_MTN', label: 'MTN MoMo' },
  { code: 'MOMO_VODAFONE', label: 'Telecel Cash' },
  { code: 'MOMO_AIRTELTIGO', label: 'AirtelTigo Money' },
  { code: 'CASH', label: 'Cash' },
];

export function TaxesTab() {
  const [range, setRange] = useState<DateRange>(defaultDateRange());
  const [data, setData] = useState<ReportsTaxesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<TaxPaymentMethod>('BANK_TRANSFER');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentDate, setPaymentDate] = useState(todayInputDate());
  const [paymentNotes, setPaymentNotes] = useState('');
  const [savingPayment, setSavingPayment] = useState(false);

  async function load() {
    setLoading(true);
    const r = await counter.reportsTaxes({ fromDate: range.fromDate, toDate: range.toDate });
    setLoading(false);
    if (!r.success) { setError(r.error); return; }
    setData(r.data);
    setError(null);
  }

  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [range.fromDate, range.toDate]);

  function openPaymentForm() {
    const balance = Math.max(0, data?.taxBalancePesewas ?? data?.netVatPayablePesewas ?? 0);
    setPaymentAmount(formatMoney(balance));
    setPaymentMethod('BANK_TRANSFER');
    setPaymentReference('');
    setPaymentDate(todayInputDate());
    setPaymentNotes('');
    setShowPaymentForm(true);
    setError(null);
  }

  async function submitTaxPayment() {
    if (!data || savingPayment) return;
    const amountPesewas = parseCedisToPesewas(paymentAmount);
    if (amountPesewas == null || amountPesewas <= 0) {
      setError('Enter a valid tax payment amount.');
      return;
    }
    if (paymentMethod !== 'CASH' && paymentReference.trim() === '') {
      setError('Enter a payment reference for MoMo or bank tax payments.');
      return;
    }
    setSavingPayment(true);
    const r = await counter.recordTaxPayment({
      taxPeriodFrom: data.fromDate,
      taxPeriodTo: data.toDate,
      amountPesewas,
      paymentMethod,
      paymentReference: paymentReference.trim() || null,
      paidAt: `${paymentDate}T12:00:00.000Z`,
      notes: paymentNotes.trim() || null,
    });
    setSavingPayment(false);
    if (!r.success) {
      setError(r.error);
      return;
    }
    setShowPaymentForm(false);
    await load();
  }

  const balancePesewas = data?.taxBalancePesewas ?? 0;
  const balanceIsCredit = balancePesewas < 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-bg-surface border border-border p-4 flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <DateRangePicker value={range} onChange={setRange} />
        <button
          type="button"
          onClick={openPaymentForm}
          disabled={!data || loading}
          className="bg-accent text-white px-5 py-2 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Record tax payment
        </button>
      </div>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      {loading && !data && <div className="text-text-tertiary text-sm">Loading…</div>}

      {data && (
        <>
          <section className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-[1.25fr_1fr_1fr_1fr_1fr] gap-4">
            <Stat
              label={data.netVatPayablePesewas >= 0 ? 'Tax to pay' : 'Tax credit'}
              value={formatMoneyWithCurrency(Math.abs(data.netVatPayablePesewas))}
              accent={data.netVatPayablePesewas >= 0 ? 'warning' : 'success'}
              large
            />
            <Stat label="Tax paid" value={formatMoneyWithCurrency(data.taxPaidPesewas)} accent="success" />
            <Stat
              label={balanceIsCredit ? 'Overpaid credit' : 'Balance outstanding'}
              value={formatMoneyWithCurrency(Math.abs(balancePesewas))}
              accent={balanceIsCredit ? 'success' : balancePesewas > 0 ? 'warning' : undefined}
            />
            <Stat label="Output tax" value={formatMoneyWithCurrency(data.outputTaxTotalPesewas)} />
            <Stat label="Input tax from cost" value={formatMoneyWithCurrency(data.inputTaxTotalPesewas)} />
          </section>

          {showPaymentForm && (
            <section className="bg-bg-surface border border-border p-4">
              <div className="flex items-center justify-between gap-3 mb-4">
                <h3 className="text-text-secondary uppercase tracking-wider text-xs">Record tax payment</h3>
                <button type="button" onClick={() => setShowPaymentForm(false)} className="text-text-tertiary hover:text-text-primary text-sm">
                  Cancel
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1.4fr] gap-3">
                <label className="flex flex-col gap-1">
                  <span className="text-text-tertiary uppercase tracking-wider text-xs">Amount (cedis)</span>
                  <input
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    className="bg-bg-input border border-border px-3 py-2 font-mono tnum"
                    inputMode="decimal"
                    placeholder="0.00"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-text-tertiary uppercase tracking-wider text-xs">Paid by</span>
                  <select
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as TaxPaymentMethod)}
                    className="bg-bg-input border border-border px-3 py-2"
                  >
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method.code} value={method.code}>{method.label}</option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-text-tertiary uppercase tracking-wider text-xs">Paid date</span>
                  <input
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="bg-bg-input border border-border px-3 py-2"
                    type="date"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-text-tertiary uppercase tracking-wider text-xs">Reference</span>
                  <input
                    value={paymentReference}
                    onChange={(e) => setPaymentReference(e.target.value)}
                    className="bg-bg-input border border-border px-3 py-2"
                    placeholder={paymentMethod === 'CASH' ? 'Optional' : 'Required'}
                  />
                </label>
              </div>
              <label className="flex flex-col gap-1 mt-3">
                <span className="text-text-tertiary uppercase tracking-wider text-xs">Notes</span>
                <textarea
                  value={paymentNotes}
                  onChange={(e) => setPaymentNotes(e.target.value)}
                  className="bg-bg-input border border-border px-3 py-2 min-h-20"
                />
              </label>
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => void submitTaxPayment()}
                  disabled={savingPayment}
                  className="bg-accent text-white px-5 py-2 font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {savingPayment ? 'Saving…' : 'Save tax payment'}
                </button>
              </div>
            </section>
          )}

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Stat
              label="Voided receipts"
              value={`${data.voidedSaleCount} · ${formatMoneyWithCurrency(data.voidedOutputTaxTotalPesewas)}`}
              accent={data.voidedSaleCount > 0 ? 'warning' : undefined}
            />
            <Stat label="Supplier invoice rows" value={`${data.supplierInputs.length}`} />
          </section>

          <section className="bg-bg-surface border border-border p-4">
            <div className="text-text-secondary uppercase tracking-wider text-xs mb-3">Payable calculation</div>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3 text-sm">
              <CalcStep label="VAT-inclusive sales" value={data.salesInclusivePesewas} />
              <CalcStep label="VAT-inclusive cost sold" value={data.soldGoodsInclusiveCostPesewas} />
              <CalcStep label="Value added" value={data.salesInclusivePesewas - data.soldGoodsInclusiveCostPesewas} />
              <CalcStep label="Tax to pay" value={data.netVatPayablePesewas} accent />
              <CalcStep label={balanceIsCredit ? 'Credit after payments' : 'Balance after payments'} value={balancePesewas} accent />
            </div>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Breakdown
              title="Sales output tax"
              rows={[
                ['VAT-inclusive sales', data.salesInclusivePesewas],
                ['Taxable base', data.salesTaxablePesewas],
                ['VAT 15%', data.outputVatPesewas],
                ['NHIL 2.5%', data.outputNhilPesewas],
                ['GETFund 2.5%', data.outputGetfundPesewas],
                ['Total output tax', data.outputTaxTotalPesewas],
                ['Voided sales excluded', data.voidedSalesInclusivePesewas],
                ['Voided output tax reversed', data.voidedOutputTaxTotalPesewas],
              ]}
            />
            <Breakdown
              title="Input tax from goods sold"
              rows={[
                ['VAT-inclusive cost of goods sold', data.soldGoodsInclusiveCostPesewas],
                ['Taxable cost base', data.soldGoodsTaxableCostPesewas],
                ['VAT 15%', data.inputVatPesewas],
                ['NHIL 2.5%', data.inputNhilPesewas],
                ['GETFund 2.5%', data.inputGetfundPesewas],
                ['Total input tax', data.inputTaxTotalPesewas],
                ['Tax to pay', data.netVatPayablePesewas],
                ['Tax paid', data.taxPaidPesewas],
                ['Balance outstanding', data.taxBalancePesewas],
              ]}
            />
          </section>

          <section className="bg-bg-surface border border-border">
            <Header title="Tax payments recorded" count={data.taxPayments.length} />
            <table className="w-full text-sm">
              <thead className="bg-bg-deep/60 text-text-tertiary text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-4 py-2">Paid at</th>
                  <th className="text-left px-4 py-2">Method</th>
                  <th className="text-left px-4 py-2">Reference</th>
                  <th className="text-left px-4 py-2">Recorded by</th>
                  <th className="text-right px-4 py-2">Amount</th>
                  <th className="text-left px-4 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {data.taxPayments.map((r) => (
                  <tr key={r.id} className="border-t border-border-subtle">
                    <td className="px-4 py-2 text-text-secondary text-xs">{new Date(r.paidAt).toLocaleString()}</td>
                    <td className="px-4 py-2">{paymentMethodLabel(r.paymentMethod)}</td>
                    <td className="px-4 py-2 text-text-secondary">{r.paymentReference ?? '—'}</td>
                    <td className="px-4 py-2">{r.workerName}</td>
                    <td className="px-4 py-2 text-right font-mono tnum text-success">{formatMoneyWithCurrency(r.amountPesewas)}</td>
                    <td className="px-4 py-2 text-text-secondary">{r.notes ?? '—'}</td>
                  </tr>
                ))}
                {data.taxPayments.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-text-tertiary">No tax payments recorded in this period.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="bg-bg-surface border border-border">
            <Header title="Daily net tax" count={data.byDay.length} />
            <table className="w-full text-sm">
              <thead className="bg-bg-deep/60 text-text-tertiary text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-4 py-2">Date</th>
                  <th className="text-right px-4 py-2">Sales</th>
                  <th className="text-right px-4 py-2">Output tax</th>
                  <th className="text-right px-4 py-2">Voided</th>
                  <th className="text-right px-4 py-2">Void tax</th>
                  <th className="text-right px-4 py-2">Cost sold</th>
                  <th className="text-right px-4 py-2">Input tax</th>
                  <th className="text-right px-4 py-2">Net</th>
                </tr>
              </thead>
              <tbody>
                {data.byDay.map((r) => (
                  <tr key={r.date} className="border-t border-border-subtle">
                    <td className="px-4 py-2">{r.date}</td>
                    <td className="px-4 py-2 text-right font-mono tnum">{formatMoneyWithCurrency(r.salesInclusivePesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum">{formatMoneyWithCurrency(r.outputTaxPesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum text-warning">{formatMoneyWithCurrency(r.voidedSalesInclusivePesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum text-warning">{formatMoneyWithCurrency(r.voidedOutputTaxPesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum">{formatMoneyWithCurrency(r.soldGoodsInclusiveCostPesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum">{formatMoneyWithCurrency(r.inputTaxPesewas)}</td>
                    <td className={`px-4 py-2 text-right font-mono tnum ${r.netPayablePesewas < 0 ? 'text-success' : 'text-warning'}`}>
                      {formatMoneyWithCurrency(r.netPayablePesewas)}
                    </td>
                  </tr>
                ))}
                {data.byDay.length === 0 && (
                  <tr><td colSpan={8} className="px-4 py-6 text-center text-text-tertiary">No sales, voids, or supplier invoices in this period.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="bg-bg-surface border border-border">
            <Header title="Voided receipt tax audit" count={data.voidedReceipts.length} />
            <table className="w-full text-sm">
              <thead className="bg-bg-deep/60 text-text-tertiary text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-4 py-2">Voided at</th>
                  <th className="text-left px-4 py-2">Sale</th>
                  <th className="text-left px-4 py-2">Cashier</th>
                  <th className="text-left px-4 py-2">Voided by</th>
                  <th className="text-right px-4 py-2">Receipt total</th>
                  <th className="text-right px-4 py-2">Output tax</th>
                  <th className="text-left px-4 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {data.voidedReceipts.map((r) => (
                  <tr key={r.saleId} className="border-t border-border-subtle">
                    <td className="px-4 py-2 text-text-secondary text-xs">{new Date(r.voidedAt).toLocaleString()}</td>
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs">{r.saleId.slice(0, 8)}</div>
                      <div className="text-text-tertiary text-xs">{new Date(r.saleAt).toLocaleString()}</div>
                    </td>
                    <td className="px-4 py-2">{r.cashierName}</td>
                    <td className="px-4 py-2">{r.voidedByName ?? '—'}</td>
                    <td className="px-4 py-2 text-right font-mono tnum">{formatMoneyWithCurrency(r.totalPesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum text-warning">{formatMoneyWithCurrency(r.outputTaxPesewas)}</td>
                    <td className="px-4 py-2 text-text-secondary">{r.voidReason ?? '—'}</td>
                  </tr>
                ))}
                {data.voidedReceipts.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-6 text-center text-text-tertiary">No voided receipts in this period.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          <section className="bg-bg-surface border border-border">
            <Header title="Supplier invoice evidence" count={data.supplierInputs.length} />
            <div className="px-4 py-3 text-xs text-text-tertiary border-b border-border-subtle">
              These rows help audit supplier purchases. The payable amount above uses the VAT-inclusive cost of goods sold so a product with a recorded cost still gets its input-tax credit.
            </div>
            <table className="w-full text-sm">
              <thead className="bg-bg-deep/60 text-text-tertiary text-xs uppercase tracking-wider">
                <tr>
                  <th className="text-left px-4 py-2">Supplier</th>
                  <th className="text-right px-4 py-2">Invoices</th>
                  <th className="text-right px-4 py-2">Purchases</th>
                  <th className="text-right px-4 py-2">Input tax</th>
                </tr>
              </thead>
              <tbody>
                {data.supplierInputs.map((r) => (
                  <tr key={r.supplierId} className="border-t border-border-subtle">
                    <td className="px-4 py-2">{r.supplierName}</td>
                    <td className="px-4 py-2 text-right font-mono tnum">{r.invoiceCount}</td>
                    <td className="px-4 py-2 text-right font-mono tnum">{formatMoneyWithCurrency(r.purchaseInclusivePesewas)}</td>
                    <td className="px-4 py-2 text-right font-mono tnum">{formatMoneyWithCurrency(r.inputTaxPesewas)}</td>
                  </tr>
                ))}
                {data.supplierInputs.length === 0 && (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-text-tertiary">No supplier invoices recorded in this period.</td></tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function todayInputDate() {
  return new Date().toISOString().slice(0, 10);
}

function paymentMethodLabel(code: string) {
  return PAYMENT_METHODS.find((method) => method.code === code)?.label ?? code.replace(/_/g, ' ');
}

function Stat({
  label,
  value,
  accent,
  large,
}: {
  label: string;
  value: string;
  accent?: 'warning' | 'success';
  large?: boolean;
}) {
  const color = accent === 'warning' ? 'text-warning' : accent === 'success' ? 'text-success' : 'text-text-primary';
  return (
    <div className="bg-bg-surface border border-border p-4">
      <div className="text-text-secondary uppercase tracking-wider text-xs">{label}</div>
      <div className={`font-mono tnum mt-1 ${large ? 'text-3xl' : 'text-xl'} ${color}`}>{value}</div>
    </div>
  );
}

function CalcStep({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  const tone = accent ? (value < 0 ? 'text-success' : 'text-warning') : 'text-text-primary';
  return (
    <div className="border border-border-subtle bg-bg-deep/30 p-3">
      <div className="text-text-tertiary uppercase tracking-wider text-xs">{label}</div>
      <div className={`font-mono tnum text-lg mt-1 ${tone}`}>{formatMoneyWithCurrency(value)}</div>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: Array<[string, number]> }) {
  return (
    <section className="bg-bg-surface border border-border">
      <Header title={title} />
      <div className="divide-y divide-border-subtle">
        {rows.map(([label, value], idx) => (
          <div key={label} className={`px-4 py-2 flex justify-between gap-4 text-sm ${idx === rows.length - 1 ? 'font-semibold' : ''}`}>
            <span className="text-text-secondary">{label}</span>
            <span className="font-mono tnum">{formatMoneyWithCurrency(value)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Header({ title, count }: { title: string; count?: number }) {
  return (
    <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
      <h3 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h3>
      {count != null && <span className="text-text-tertiary text-xs">{count} row{count === 1 ? '' : 's'}</span>}
    </div>
  );
}
