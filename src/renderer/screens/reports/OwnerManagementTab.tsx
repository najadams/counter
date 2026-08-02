import { useEffect, useState } from 'react';
import { counter } from '../../lib/ipc';
import { formatMoneyWithCurrency } from '../../../shared/lib/money';
import type {
  ManagementCashflowResponse,
  ManagementConcentrationResponse,
  ManagementDataQuality,
  ManagementDownsideResponse,
  ManagementIncomeStatementResponse,
  ManagementAccountsListResponse,
  ManagementCutoverPreviewResponse,
  ManagementObligationsResponse,
  ManagementPositionResponse,
  ManagementRiskConfigResponse,
  ManagementFixedAssetsListResponse,
  ManagementDrilldownRequest,
  ManagementDrilldownResponse,
  ManagementScenarioDrivers,
  ManagementSavedScenario,
  ManagementShadowResponse,
} from '../../../shared/types/ipc';
import { FeedbackBanner } from '../../components/FeedbackBanner';
import { DateRangePicker, defaultDateRange, type DateRange } from '../../components/DateRangePicker';
import { buildCsvFilename, exportRowsAsCsv, pesewasToCsvNumber } from '../../lib/csv';

export type OwnerManagementView =
  | 'summary' | 'profit' | 'position' | 'cash'
  | 'obligations' | 'concentration' | 'downside';

interface LoadedPack {
  profit: ManagementIncomeStatementResponse;
  position: ManagementPositionResponse;
  cash: ManagementCashflowResponse;
  obligations: ManagementObligationsResponse;
  concentration: ManagementConcentrationResponse;
  downside: ManagementDownsideResponse;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function OwnerManagementTab({ view, reportAccessToken }: { view: OwnerManagementView; reportAccessToken: string }) {
  const [range, setRange] = useState<DateRange>(defaultDateRange());
  const [asOfDate, setAsOfDate] = useState(today);
  const [pin, setPin] = useState('');
  const [preset, setPreset] = useState<ManagementDownsideResponse['preset']>('MILD');
  const [horizonDays, setHorizonDays] = useState<30 | 90 | 180>(90);
  const [customDrivers, setCustomDrivers] = useState<ManagementScenarioDrivers>({
    salesVolumeChangeBps: -1000,
    sellingPriceChangeBps: 0,
    cogsChangeBps: 500,
    fixedExpenseChangeBps: 500,
    variableExpenseChangeBps: 500,
    collectionChangeBps: -1000,
    badDebtBps: 0,
    additionalInventoryLossBps: 100,
    removeTopCustomer: false,
    removeTopProduct: false,
  });
  const [data, setData] = useState<Partial<LoadedPack> | null>(null);
  const [accountData, setAccountData] = useState<ManagementAccountsListResponse | null>(null);
  const [riskConfig, setRiskConfig] = useState<ManagementRiskConfigResponse | null>(null);
  const [fixedAssets, setFixedAssets] = useState<ManagementFixedAssetsListResponse | null>(null);
  const [shadow, setShadow] = useState<ManagementShadowResponse | null>(null);
  const [drilldown, setDrilldown] = useState<ManagementDrilldownResponse | null>(null);
  const [drilldownError, setDrilldownError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (loading) return;
    setLoading(true);
    setError(null);
    const rangeReq = { ...range, reportAccessToken };
    const asOfReq = { asOfDate, reportAccessToken };
    if (view === 'summary') {
      const [profit, position, cash, obligations, concentration, downside, accounts, risks, assets, shadowStatus] = await Promise.all([
        counter.managementIncomeStatement(rangeReq),
        counter.managementPosition(asOfReq),
        counter.managementCashflow(rangeReq),
        counter.managementObligations(asOfReq),
        counter.managementConcentration(rangeReq),
        counter.managementDownside({
          ...asOfReq, preset, horizonDays,
          drivers: preset === 'CUSTOM' ? customDrivers : undefined,
        }),
        counter.managementAccounts({ reportAccessToken }),
        counter.managementRiskConfig({ reportAccessToken }),
        counter.managementFixedAssets({ reportAccessToken }),
        counter.managementShadowStatus({ reportAccessToken }),
      ] as const);
      if (!profit.success || !position.success || !cash.success
          || !obligations.success || !concentration.success || !downside.success
          || !accounts.success) {
        const message =
          (!profit.success && profit.error)
          || (!position.success && position.error)
          || (!cash.success && cash.error)
          || (!obligations.success && obligations.error)
          || (!concentration.success && concentration.error)
          || (!downside.success && downside.error)
          || (!accounts.success && accounts.error)
          || 'Management pack could not be built.';
        setData(null);
        setError(message);
      } else {
        setAccountData(accounts.data);
        if (risks.success) setRiskConfig(risks.data);
        if (assets.success) setFixedAssets(assets.data);
        if (shadowStatus.success) setShadow(shadowStatus.data);
        setData({
          profit: profit.data,
          position: position.data,
          cash: cash.data,
          obligations: obligations.data,
          concentration: concentration.data,
          downside: downside.data,
        });
      }
      setLoading(false);
      return;
    }
    const response =
      view === 'profit' ? await counter.managementIncomeStatement(rangeReq)
      : view === 'position' ? await counter.managementPosition(asOfReq)
      : view === 'cash' ? await counter.managementCashflow(rangeReq)
      : view === 'obligations' ? await counter.managementObligations(asOfReq)
      : view === 'concentration' ? await counter.managementConcentration(rangeReq)
      : await counter.managementDownside({
          ...asOfReq, preset, horizonDays,
          drivers: preset === 'CUSTOM' ? customDrivers : undefined,
        });
    setLoading(false);
    if (!response.success) {
      setData(null);
      setError(response.error);
      return;
    }
    setData({ [view]: response.data });
    const [accounts, risks, assets, shadowStatus] = await Promise.all([
      counter.managementAccounts({ reportAccessToken }),
      counter.managementRiskConfig({ reportAccessToken }),
      counter.managementFixedAssets({ reportAccessToken }),
      counter.managementShadowStatus({ reportAccessToken }),
    ] as const);
    if (accounts.success) setAccountData(accounts.data);
    if (risks.success) setRiskConfig(risks.data);
    if (assets.success) setFixedAssets(assets.data);
    if (shadowStatus.success) setShadow(shadowStatus.data);
  }

  async function openDrilldown(req: Omit<ManagementDrilldownRequest, 'reportAccessToken'>) {
    setDrilldownError(null);
    const result = await counter.managementDrilldown({ ...req, reportAccessToken });
    if (!result.success) {
      setDrilldown(null);
      setDrilldownError(result.error);
      return;
    }
    setDrilldown(result.data);
  }

  async function printMonthlyPack() {
    if (view !== 'summary' || !data?.profit || !data.position || !data.cash
        || !data.obligations || !data.concentration || !data.downside) {
      setLoading(true);
      const [profit, position, cash, obligations, concentration, downside] = await Promise.all([
        counter.managementIncomeStatement({ ...range, reportAccessToken }),
        counter.managementPosition({ asOfDate, reportAccessToken }),
        counter.managementCashflow({ ...range, reportAccessToken }),
        counter.managementObligations({ asOfDate, reportAccessToken }),
        counter.managementConcentration({ ...range, reportAccessToken }),
        counter.managementDownside({ asOfDate, reportAccessToken, preset, horizonDays, drivers: preset === 'CUSTOM' ? customDrivers : undefined }),
      ] as const);
      setLoading(false);
      if (!profit.success || !position.success || !cash.success || !obligations.success
          || !concentration.success || !downside.success) {
        setError('The complete monthly pack could not be assembled for printing.');
        return;
      }
      setData({ profit: profit.data, position: position.data, cash: cash.data,
        obligations: obligations.data, concentration: concentration.data, downside: downside.data });
    }
    const audited = await counter.reportsAuditAction({
      reportAccessToken, action: 'PRINT', report: 'OWNER_MANAGEMENT_PACK',
    });
    if (!audited.success) { setError(audited.error); return; }
    window.setTimeout(() => window.print(), 50);
  }

  async function exportCurrentPack() {
    if (!data) return;
    const audited = await counter.reportsAuditAction({
      reportAccessToken, action: 'EXPORT', report: 'OWNER_MANAGEMENT_PACK',
    });
    if (!audited.success) { setError(audited.error); return; }
    exportPackCsv(data, range.fromDate, range.toDate);
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [view, reportAccessToken]);
  useEffect(() => { setPin(''); }, [view]);

  const quality = data
    ? Object.values(data).find(Boolean)?.dataQuality
    : null;

  return (
    <div className="flex flex-col gap-5">
      <section className="bg-bg-surface border border-border p-4 flex flex-wrap items-end gap-3">
        {(view === 'summary' || view === 'profit' || view === 'cash' || view === 'concentration') && (
          <DateRangePicker value={range} onChange={(next) => { setRange(next); setData(null); }} />
        )}
        {(view === 'summary' || view === 'position' || view === 'obligations' || view === 'downside') && (
          <label>
            <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">As of</span>
            <input type="date" value={asOfDate}
              onChange={(e) => { setAsOfDate(e.target.value); setData(null); }}
              className="bg-bg-input border border-border-strong px-3 py-2 font-mono" />
          </label>
        )}
        {(view === 'summary' || view === 'downside') && (
          <>
            <label>
              <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Scenario</span>
              <select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}
                className="bg-bg-input border border-border-strong px-3 py-2">
                <option value="BASELINE">Baseline</option>
                <option value="MILD">Mild stress</option>
                <option value="SEVERE">Severe stress</option>
                <option value="TOP_DEPENDENCY">Top dependency loss</option>
                <option value="CUSTOM">Custom drivers</option>
              </select>
            </label>
            <label>
              <span className="block text-text-secondary text-xs uppercase tracking-wider mb-1">Horizon</span>
              <select value={horizonDays}
                onChange={(e) => setHorizonDays(Number(e.target.value) as 30 | 90 | 180)}
                className="bg-bg-input border border-border-strong px-3 py-2">
                <option value={30}>30 days</option>
                <option value={90}>90 days</option>
                <option value={180}>180 days</option>
              </select>
            </label>
          </>
        )}
        {(view === 'downside' || view === 'summary') && preset === 'CUSTOM' && (
          <div className="basis-full grid grid-cols-2 md:grid-cols-4 gap-2">
            {([
              ['salesVolumeChangeBps', 'Sales volume %'],
              ['sellingPriceChangeBps', 'Selling price %'],
              ['cogsChangeBps', 'COGS %'],
              ['fixedExpenseChangeBps', 'Fixed expense %'],
              ['variableExpenseChangeBps', 'Variable expense %'],
              ['collectionChangeBps', 'Collection rate %'],
              ['badDebtBps', 'Bad debt %'],
              ['additionalInventoryLossBps', 'Additional loss %'],
            ] as const).map(([key, label]) => (
              <label key={key} className="text-xs text-text-secondary">
                {label}
                <input type="number" step="0.1" value={customDrivers[key] / 100}
                  onChange={(e) => setCustomDrivers((current) => ({
                    ...current, [key]: Math.round(Number(e.target.value) * 100),
                  }))}
                  className="block w-full mt-1 bg-bg-input border border-border px-2 py-2 text-text-primary" />
              </label>
            ))}
          </div>
        )}
        <label>
          <span className="block text-text-secondary text-xs mb-1">Fresh PIN for changes</span>
          <input type="password" inputMode="numeric" value={pin} maxLength={6}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="Required only to change financial records"
            className="bg-bg-input border border-border-strong px-3 py-2 font-mono tnum w-64" />
        </label>
        <button onClick={() => void load()} disabled={loading}
          className="px-4 py-2 bg-accent text-ink font-semibold disabled:opacity-40">
          {loading ? 'Building pack…' : 'Refresh'}
        </button>
        {data && (
          <>
            <button onClick={() => void exportCurrentPack()}
              className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Export CSV
            </button>
            <button onClick={() => void printMonthlyPack()}
              className="px-4 py-2 border border-border hover:bg-bg-elevated text-sm">
              Print monthly pack
            </button>
          </>
        )}
      </section>

      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      {quality && <QualityBanner quality={quality} />}
      {(drilldown || drilldownError) && (
        <DrilldownPanel data={drilldown} error={drilldownError} onClose={() => {
          setDrilldown(null); setDrilldownError(null);
        }} />
      )}
      {!data && !loading && (
        <section className="bg-bg-surface border border-border p-6 text-text-tertiary text-sm">
          No management data is available for this selection.
        </section>
      )}
      <div className={view === 'summary' ? 'contents print:hidden' : 'contents'}>
      {data?.profit && (view === 'summary' || view === 'profit') && <ProfitView data={data.profit} compact={view === 'summary'} onDrilldown={openDrilldown} />}
      {data?.position && (view === 'summary' || view === 'position') && <PositionView data={data.position} compact={view === 'summary'} onDrilldown={openDrilldown} />}
      {data?.cash && (view === 'summary' || view === 'cash') && <CashView data={data.cash} compact={view === 'summary'} onDrilldown={openDrilldown} />}
      {data?.obligations && (view === 'summary' || view === 'obligations') && (
        <ObligationsView
          data={data.obligations}
          compact={view === 'summary'}
          pin={pin}
          accounts={accountData?.accounts ?? []}
          onPaid={load}
          onPinConsumed={() => setPin('')}
          onDrilldown={openDrilldown}
        />
      )}
      {data?.concentration && (view === 'summary' || view === 'concentration') && (
        <ConcentrationView
          data={data.concentration}
          compact={view === 'summary'}
          pin={pin}
          onRefresh={load}
          onPinConsumed={() => setPin('')}
        />
      )}
      {data?.downside && (view === 'summary' || view === 'downside') && <DownsideView data={data.downside} compact={view === 'summary'} pin={pin} riskConfig={riskConfig} onRefresh={load} onPinConsumed={() => setPin('')} onUseScenario={(scenario) => {
        setPreset('CUSTOM'); setHorizonDays(scenario.horizonDays);
        setCustomDrivers(scenario.drivers as unknown as ManagementScenarioDrivers); setData(null);
      }} />}
      {view === 'summary' && data && accountData && (
        <FinancialControls
          pin={pin}
          reportAccessToken={reportAccessToken}
          onPinConsumed={() => setPin('')}
          data={accountData}
          fixedAssets={fixedAssets?.assets ?? []}
          shadow={shadow}
          onRefresh={async () => {
            const [accounts, assets, shadowStatus] = await Promise.all([
              counter.managementAccounts({ reportAccessToken }), counter.managementFixedAssets({ reportAccessToken }),
              counter.managementShadowStatus({ reportAccessToken }),
            ] as const);
            if (accounts.success) setAccountData(accounts.data);
            else setError(accounts.error);
            if (assets.success) setFixedAssets(assets.data);
            if (shadowStatus.success) setShadow(shadowStatus.data);
          }}
        />
      )}
      </div>
      {view === 'summary' && data?.profit && data.position && data.cash && data.obligations
        && data.concentration && data.downside && (
        <div className="hidden print:block">
          <h1 className="text-2xl mb-1">Counter Owner Management Pack</h1>
          <p className="text-sm mb-5">{range.fromDate} to {range.toDate} · position as of {asOfDate}</p>
          <ProfitView data={data.profit} compact={false} onDrilldown={openDrilldown} />
          <PositionView data={data.position} compact={false} onDrilldown={openDrilldown} />
          <CashView data={data.cash} compact={false} onDrilldown={openDrilldown} />
          <ObligationsView data={data.obligations} compact pin={pin} accounts={[]} onPaid={load} onPinConsumed={() => setPin('')} onDrilldown={openDrilldown} />
          <ConcentrationView data={data.concentration} compact pin={pin} onRefresh={load} onPinConsumed={() => setPin('')} />
          <DownsideView data={data.downside} compact pin={pin} riskConfig={riskConfig} onRefresh={load} onPinConsumed={() => setPin('')} onUseScenario={() => undefined} />
        </div>
      )}
    </div>
  );
}

function FinancialControls({ pin, reportAccessToken, data, fixedAssets, shadow, onRefresh, onPinConsumed }: {
  pin: string;
  reportAccessToken: string;
  data: ManagementAccountsListResponse;
  fixedAssets: ManagementFixedAssetsListResponse['assets'];
  shadow: ManagementShadowResponse | null;
  onRefresh: () => Promise<void>;
  onPinConsumed: () => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [accountName, setAccountName] = useState('');
  const [accountKind, setAccountKind] = useState<'TILL' | 'SAFE' | 'BANK' | 'MOMO' | 'OTHER_CASH'>('BANK');
  const [provider, setProvider] = useState('');
  const [masked, setMasked] = useState('');
  const [editAccountId, setEditAccountId] = useState(data.accounts[0]?.id ?? '');
  const editAccount = data.accounts.find((account) => account.id === editAccountId);
  const [editAccountName, setEditAccountName] = useState(editAccount?.name ?? '');
  const [editProvider, setEditProvider] = useState(editAccount?.provider ?? '');
  const [editMasked, setEditMasked] = useState(editAccount?.maskedIdentifier ?? '');
  const [editActive, setEditActive] = useState(editAccount?.active ?? true);
  const [mapMethod, setMapMethod] = useState('CASH');
  const [mapDirection, setMapDirection] = useState<'IN' | 'OUT'>('IN');
  const [mapAccountId, setMapAccountId] = useState(data.accounts[0]?.id ?? '');
  const [fromId, setFromId] = useState(data.accounts[0]?.id ?? '');
  const [toId, setToId] = useState(data.accounts[1]?.id ?? '');
  const [transferAmount, setTransferAmount] = useState('');
  const [reconcileId, setReconcileId] = useState(data.accounts[0]?.id ?? '');
  const [observed, setObserved] = useState('');
  const [cutoverDate, setCutoverDate] = useState(today);
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ManagementCutoverPreviewResponse | null>(null);
  const [expenseCategory, setExpenseCategory] = useState('RENT');
  const [expensePayee, setExpensePayee] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDueDate, setExpenseDueDate] = useState('');
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [loanKind, setLoanKind] = useState<'BANK_LOAN' | 'OWNER_LOAN' | 'LEASE' | 'OTHER'>('BANK_LOAN');
  const [loanCreditor, setLoanCreditor] = useState('');
  const [loanPrincipal, setLoanPrincipal] = useState('');
  const [loanStartDate, setLoanStartDate] = useState(today);
  const [loanReceivedAccountId, setLoanReceivedAccountId] = useState(data.accounts[0]?.id ?? '');
  const [loanScheduleCsv, setLoanScheduleCsv] = useState('');
  const [assetName, setAssetName] = useState('');
  const [assetClass, setAssetClass] = useState('EQUIPMENT');
  const [assetCost, setAssetCost] = useState('');
  const [assetDate, setAssetDate] = useState(today);
  const [assetLife, setAssetLife] = useState('');
  const [assetAccountId, setAssetAccountId] = useState('');
  const [assetVendor, setAssetVendor] = useState('');
  const [assetDueDate, setAssetDueDate] = useState('');
  const activeAssets = fixedAssets.filter((asset) => !asset.disposedAt);
  const [manageAssetId, setManageAssetId] = useState(activeAssets[0]?.id ?? '');
  const [assetActionDate, setAssetActionDate] = useState(today);
  const [assetProceeds, setAssetProceeds] = useState('');
  const [assetProceedsAccountId, setAssetProceedsAccountId] = useState(data.accounts[0]?.id ?? '');
  const [capitalAccountId, setCapitalAccountId] = useState(data.accounts[0]?.id ?? '');
  const [capitalAmount, setCapitalAmount] = useState('');
  const cutoverActive = data.dataQuality.cutoverDate != null;
  const balanceAccounts = data.ledgerAccounts.filter((account) =>
    account.accountClass === 'ASSET'
    || account.accountClass === 'LIABILITY'
    || account.accountClass === 'EQUITY');

  async function runMutation<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } finally { onPinConsumed(); }
  }

  async function createAccount() {
    const result = await runMutation(() => counter.managementCreateAccount({
      name: accountName, kind: accountKind, provider: provider || null,
      maskedIdentifier: masked || null, pin,
    }));
    if (!result.success) return setMessage(result.error);
    setMessage(`${result.data.name} created.`);
    setAccountName('');
    await onRefresh();
  }

  async function saveAccount() {
    if (!editAccount) return;
    const result = await runMutation(() => counter.managementUpdateAccount({
      financialAccountId: editAccount.id,
      name: editAccountName,
      provider: editProvider || null,
      maskedIdentifier: editMasked || null,
      allowNegative: editAccount.allowNegative,
      active: editActive,
      pin,
    }));
    setMessage(result.success ? `${result.data.name} updated.` : result.error);
    if (result.success) await onRefresh();
  }

  async function saveMapping() {
    const result = await runMutation(() => counter.managementMapAccount({
      paymentMethod: mapMethod, direction: mapDirection,
      financialAccountId: mapAccountId, pin,
    }));
    setMessage(result.success ? 'Payment mapping saved.' : result.error);
    if (result.success) await onRefresh();
  }

  async function transfer() {
    const amountPesewas = Math.round(Number(transferAmount) * 100);
    const result = await runMutation(() => counter.managementTransfer({
      fromFinancialAccountId: fromId, toFinancialAccountId: toId,
      amountPesewas, pin,
    }));
    setMessage(result.success ? 'Transfer posted to both money accounts.' : result.error);
    if (result.success) {
      setTransferAmount('');
      await onRefresh();
    }
  }

  async function reconcile() {
    const observedPesewas = Math.round(Number(observed) * 100);
    const result = await runMutation(() => counter.managementReconcileAccount({
      financialAccountId: reconcileId, observedPesewas, pin,
    }));
    setMessage(result.success
      ? `Reconciled; variance ${formatMoneyWithCurrency(result.data.variancePesewas)}.`
      : result.error);
    if (result.success) {
      setObserved('');
      await onRefresh();
    }
  }

  function cutoverBalances() {
    return balanceAccounts.map((account) => ({
      ledgerAccountId: account.id,
      amountPesewas: Math.max(0, Math.round(Number(balances[account.id] || 0) * 100)),
    }));
  }

  async function previewCutover() {
    const result = await counter.managementCutoverPreview({
      cutoverDate, balances: cutoverBalances(), reportAccessToken,
    });
    if (!result.success) return setMessage(result.error);
    setPreview(result.data);
    setMessage(result.data.issues.length === 0
      ? 'Opening position is ready to activate.'
      : 'Resolve every blocking issue before activation.');
  }

  async function toggleShadow(enabled: boolean) {
    const result = await runMutation(() => counter.managementSetShadow({ enabled, pin }));
    setMessage(result.success
      ? enabled ? 'Shadow ledger started. Operational events will now be dual-posted for comparison.' : 'Shadow ledger stopped.'
      : result.error);
    if (result.success) await onRefresh();
  }

  async function activateCutover() {
    const result = await runMutation(() => counter.managementCutoverActivate({
      cutoverDate, balances: cutoverBalances(), pin,
      notes: 'Activated through Owner Management Pack',
    }));
    if (!result.success) return setMessage(result.error);
    setMessage(`Ledger activated. Opening equity is ${formatMoneyWithCurrency(result.data.openingEquityPesewas)}.`);
    setPreview(null);
    await onRefresh();
  }

  async function createExpense() {
    const result = await runMutation(() => counter.managementCreateExpense({
      category: expenseCategory,
      payee: expensePayee || null,
      incurredDate: today(),
      dueDate: expenseDueDate || null,
      amountPesewas: Math.round(Number(expenseAmount) * 100),
      financialAccountId: expenseAccountId || null,
      pin,
    }));
    if (!result.success) return setMessage(result.error);
    setMessage(expenseAccountId ? 'Paid operating expense posted.' : 'Unpaid bill and obligation recorded.');
    setExpenseAmount('');
    setExpensePayee('');
    await onRefresh();
  }

  async function createLoan() {
    const schedule = loanScheduleCsv.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [dueDate = '', principal = '', interest = '0'] = line.split(',').map((value) => value.trim());
        return {
          dueDate,
          principalPesewas: Math.round(Number(principal) * 100),
          interestPesewas: Math.round(Number(interest) * 100),
        };
      });
    const result = await runMutation(() => counter.managementCreateLoan({
      kind: loanKind,
      creditorName: loanCreditor,
      originalPrincipalPesewas: Math.round(Number(loanPrincipal) * 100),
      receivedFinancialAccountId: loanReceivedAccountId || null,
      startDate: loanStartDate,
      schedule,
      pin,
    }));
    if (!result.success) return setMessage(result.error);
    setMessage(`Loan recorded with ${result.data.obligationIds.length} installment(s).`);
    setLoanCreditor('');
    setLoanPrincipal('');
    setLoanScheduleCsv('');
    await onRefresh();
  }

  async function createAsset() {
    const result = await runMutation(() => counter.managementCreateFixedAsset({
      name: assetName,
      assetClass,
      acquiredDate: assetDate,
      costPesewas: Math.round(Number(assetCost) * 100),
      usefulLifeMonths: assetLife ? Number(assetLife) : null,
      sourceFinancialAccountId: assetAccountId || null,
      vendorName: assetVendor || null,
      dueDate: assetAccountId ? null : assetDueDate || null,
      pin,
    }));
    if (!result.success) return setMessage(result.error);
    setMessage(`${assetName} recorded as a fixed asset.`);
    setAssetName('');
    setAssetCost('');
    setAssetVendor('');
    setAssetDueDate('');
    await onRefresh();
  }

  async function depreciateAsset() {
    const result = await runMutation(() => counter.managementDepreciateFixedAsset({
      fixedAssetId: manageAssetId, throughDate: assetActionDate, pin,
    }));
    setMessage(result.success
      ? `${formatMoneyWithCurrency(result.data.depreciationPesewas)} depreciation posted.`
      : result.error);
    if (result.success) await onRefresh();
  }

  async function disposeAsset() {
    const proceedsPesewas = Math.round(Number(assetProceeds || 0) * 100);
    const result = await runMutation(() => counter.managementDisposeFixedAsset({
      fixedAssetId: manageAssetId,
      disposedDate: assetActionDate,
      proceedsPesewas,
      receivingFinancialAccountId: proceedsPesewas > 0 ? assetProceedsAccountId : null,
      pin,
    }));
    setMessage(result.success
      ? `Asset disposed; gain/(loss) ${formatMoneyWithCurrency(result.data.gainLossPesewas)}.`
      : result.error);
    if (result.success) {
      setAssetProceeds('');
      await onRefresh();
    }
  }

  async function addOwnerCapital() {
    const result = await runMutation(() => counter.managementOwnerContribution({
      financialAccountId: capitalAccountId,
      amountPesewas: Math.round(Number(capitalAmount) * 100),
      pin,
    }));
    if (!result.success) return setMessage(result.error);
    setMessage('Owner contribution posted to capital, not business profit.');
    setCapitalAmount('');
    await onRefresh();
  }

  return (
    <ReportSection title="Financial controls" answer="Configure where money lives, reconcile it, and activate the ledger only from a verified opening position.">
      {message && <FeedbackBanner>{message}</FeedbackBanner>}
      <div className="grid lg:grid-cols-2 gap-4">
        <ControlBox title="Money-location accounts">
          <div className="space-y-2 mb-3">
            {data.accounts.map((account) => (
              <div key={account.id} className="flex justify-between gap-3 text-sm border-b border-border-subtle pb-2">
                <span>{account.name} <span className="text-text-tertiary">({account.kind})</span></span>
                <span className="font-mono">{formatMoneyWithCurrency(account.balancePesewas)}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input value={accountName} onChange={(e) => setAccountName(e.target.value)}
              placeholder="Account name" className="bg-bg-input border border-border px-2 py-2" />
            <select value={accountKind} onChange={(e) => setAccountKind(e.target.value as typeof accountKind)}
              className="bg-bg-input border border-border px-2 py-2">
              <option value="TILL">Till</option><option value="SAFE">Safe</option>
              <option value="BANK">Bank</option><option value="MOMO">MoMo</option>
              <option value="OTHER_CASH">Other cash</option>
            </select>
            <input value={provider} onChange={(e) => setProvider(e.target.value)}
              placeholder="Provider" className="bg-bg-input border border-border px-2 py-2" />
            <input value={masked} onChange={(e) => setMasked(e.target.value)}
              placeholder="Masked ID ••••1234" className="bg-bg-input border border-border px-2 py-2" />
          </div>
          <button onClick={() => void createAccount()} disabled={!accountName.trim()}
            className="mt-2 px-3 py-2 border border-border disabled:opacity-40">Add account</button>
        </ControlBox>

        <ControlBox title="Edit or deactivate account">
          <div className="grid grid-cols-2 gap-2">
            <select value={editAccountId} onChange={(e) => {
              const next = data.accounts.find((account) => account.id === e.target.value);
              setEditAccountId(e.target.value);
              setEditAccountName(next?.name ?? '');
              setEditProvider(next?.provider ?? '');
              setEditMasked(next?.maskedIdentifier ?? '');
              setEditActive(next?.active ?? true);
            }} className="col-span-2 bg-bg-input border border-border px-2 py-2">
              {data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}{account.active ? '' : ' — inactive'}</option>)}
            </select>
            <input value={editAccountName} onChange={(e) => setEditAccountName(e.target.value)}
              placeholder="Account name" className="bg-bg-input border border-border px-2 py-2" />
            <input value={editProvider} onChange={(e) => setEditProvider(e.target.value)}
              placeholder="Provider" className="bg-bg-input border border-border px-2 py-2" />
            <input value={editMasked} onChange={(e) => setEditMasked(e.target.value)}
              placeholder="Masked identifier" className="bg-bg-input border border-border px-2 py-2" />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={editActive} onChange={(e) => setEditActive(e.target.checked)} /> Active
            </label>
          </div>
          <button onClick={() => void saveAccount()} disabled={!editAccount || !editAccountName.trim()}
            className="mt-2 px-3 py-2 border border-border disabled:opacity-40">Save account</button>
          <p className="text-xs text-text-tertiary mt-2">An account must be unmapped, unused by an open shift and at zero before deactivation.</p>
        </ControlBox>

        <ControlBox title="Payment-method mapping">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <select value={mapMethod} onChange={(e) => setMapMethod(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2">
              {['CASH', 'MOMO_MTN', 'MOMO_VODAFONE', 'MOMO_AIRTELTIGO', 'BANK_TRANSFER']
                .map((method) => <option key={method}>{method}</option>)}
            </select>
            <select value={mapDirection} onChange={(e) => setMapDirection(e.target.value as 'IN' | 'OUT')}
              className="bg-bg-input border border-border px-2 py-2">
              <option value="IN">Incoming</option><option value="OUT">Outgoing</option>
            </select>
            <select value={mapAccountId} onChange={(e) => setMapAccountId(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2">
              {data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          </div>
          <button onClick={() => void saveMapping()} className="mt-2 px-3 py-2 border border-border">Save mapping</button>
        </ControlBox>

        <ControlBox title="Internal transfer">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <select value={fromId} onChange={(e) => setFromId(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2">
              {data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            <select value={toId} onChange={(e) => setToId(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2">
              {data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            <input value={transferAmount} onChange={(e) => setTransferAmount(e.target.value)}
              inputMode="decimal" placeholder="GH¢ amount"
              className="bg-bg-input border border-border px-2 py-2" />
          </div>
          <button onClick={() => void transfer()}
            disabled={fromId === toId || !(Number(transferAmount) > 0)}
            className="mt-2 px-3 py-2 border border-border disabled:opacity-40">Post transfer</button>
        </ControlBox>

        <ControlBox title="Reconcile account">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select value={reconcileId} onChange={(e) => setReconcileId(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2">
              {data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            <input value={observed} onChange={(e) => setObserved(e.target.value)}
              inputMode="decimal" placeholder="Counted/statement GH¢"
              className="bg-bg-input border border-border px-2 py-2" />
          </div>
          <button onClick={() => void reconcile()} disabled={!(Number(observed) >= 0)}
            className="mt-2 px-3 py-2 border border-border disabled:opacity-40">Reconcile and post variance</button>
        </ControlBox>

        <ControlBox title="Expense or unpaid bill">
          <div className="grid grid-cols-2 gap-2">
            <select value={expenseCategory} onChange={(e) => setExpenseCategory(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2">
              {['RENT', 'UTILITIES', 'TRANSPORT', 'SUPPLIES', 'COMMS', 'REPAIRS',
                'BANK_FEES', 'STAFF_WAGES', 'STAFF_ADVANCE', 'COMMISSION',
                'STAFF_WELFARE', 'OTHER', 'INTEREST', 'INCOME_TAX']
                .map((category) => <option key={category}>{category}</option>)}
            </select>
            <input value={expensePayee} onChange={(e) => setExpensePayee(e.target.value)}
              placeholder="Payee" className="bg-bg-input border border-border px-2 py-2" />
            <input value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)}
              placeholder="GH¢ amount" inputMode="decimal"
              className="bg-bg-input border border-border px-2 py-2" />
            <input type="date" value={expenseDueDate} onChange={(e) => setExpenseDueDate(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2" />
            <select value={expenseAccountId} onChange={(e) => setExpenseAccountId(e.target.value)}
              className="col-span-2 bg-bg-input border border-border px-2 py-2">
              <option value="">Unpaid — create obligation</option>
              {data.accounts.map((account) => <option key={account.id} value={account.id}>Paid from {account.name}</option>)}
            </select>
          </div>
          <button onClick={() => void createExpense()} disabled={!(Number(expenseAmount) > 0)}
            className="mt-2 px-3 py-2 border border-border disabled:opacity-40">Record expense</button>
        </ControlBox>

        <ControlBox title="Loan with explicit schedule">
          <div className="grid grid-cols-2 gap-2">
            <select value={loanKind} onChange={(e) => setLoanKind(e.target.value as typeof loanKind)}
              className="bg-bg-input border border-border px-2 py-2">
              <option value="BANK_LOAN">Bank loan</option><option value="OWNER_LOAN">Owner/director loan</option>
              <option value="LEASE">Lease</option><option value="OTHER">Other financing</option>
            </select>
            <input value={loanCreditor} onChange={(e) => setLoanCreditor(e.target.value)}
              placeholder="Creditor" className="bg-bg-input border border-border px-2 py-2" />
            <input value={loanPrincipal} onChange={(e) => setLoanPrincipal(e.target.value)}
              placeholder="Principal GH¢" inputMode="decimal"
              className="bg-bg-input border border-border px-2 py-2" />
            <input type="date" value={loanStartDate} onChange={(e) => setLoanStartDate(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2" />
            <select value={loanReceivedAccountId} onChange={(e) => setLoanReceivedAccountId(e.target.value)}
              className="col-span-2 bg-bg-input border border-border px-2 py-2">
              <option value="">Opening/existing loan — no cash receipt</option>
              {data.accounts.map((account) => <option key={account.id} value={account.id}>Receive into {account.name}</option>)}
            </select>
            <textarea value={loanScheduleCsv} onChange={(e) => setLoanScheduleCsv(e.target.value)}
              placeholder={'One installment per line:\n2026-08-31, 1000.00, 75.00'}
              className="col-span-2 min-h-24 bg-bg-input border border-border px-2 py-2 font-mono text-xs" />
          </div>
          <button onClick={() => void createLoan()}
            disabled={!loanCreditor.trim() || !(Number(loanPrincipal) > 0) || !loanScheduleCsv.trim()}
            className="mt-2 px-3 py-2 border border-border disabled:opacity-40">Record loan and schedule</button>
        </ControlBox>

        <ControlBox title="Fixed asset acquisition">
          <div className="grid grid-cols-2 gap-2">
            <input value={assetName} onChange={(e) => setAssetName(e.target.value)}
              placeholder="Asset name" className="bg-bg-input border border-border px-2 py-2" />
            <input value={assetClass} onChange={(e) => setAssetClass(e.target.value)}
              placeholder="Asset class" className="bg-bg-input border border-border px-2 py-2" />
            <input value={assetCost} onChange={(e) => setAssetCost(e.target.value)}
              placeholder="Cost GH¢" inputMode="decimal"
              className="bg-bg-input border border-border px-2 py-2" />
            <input type="date" value={assetDate} onChange={(e) => setAssetDate(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2" />
            <input value={assetLife} onChange={(e) => setAssetLife(e.target.value)}
              placeholder="Useful life, months" inputMode="numeric"
              className="bg-bg-input border border-border px-2 py-2" />
            <select value={assetAccountId} onChange={(e) => setAssetAccountId(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2">
              <option value="">Unpaid asset bill</option>
              {data.accounts.map((account) => <option key={account.id} value={account.id}>Pay from {account.name}</option>)}
            </select>
            {!assetAccountId && (
              <>
                <input value={assetVendor} onChange={(e) => setAssetVendor(e.target.value)}
                  placeholder="Vendor/creditor" className="bg-bg-input border border-border px-2 py-2" />
                <input type="date" value={assetDueDate} onChange={(e) => setAssetDueDate(e.target.value)}
                  className="bg-bg-input border border-border px-2 py-2" />
              </>
            )}
          </div>
          <button onClick={() => void createAsset()}
            disabled={!assetName.trim() || !(Number(assetCost) > 0) || (!assetAccountId && !assetDueDate)}
            className="mt-2 px-3 py-2 border border-border disabled:opacity-40">Record fixed asset</button>
        </ControlBox>

        <ControlBox title="Depreciate or dispose fixed asset">
          {activeAssets.length === 0 ? (
            <p className="text-sm text-text-tertiary">No active fixed assets.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <select value={manageAssetId} onChange={(e) => setManageAssetId(e.target.value)}
                  className="col-span-2 bg-bg-input border border-border px-2 py-2">
                  {activeAssets.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name} — carrying {formatMoneyWithCurrency(asset.carryingValuePesewas)}
                    </option>
                  ))}
                </select>
                <input type="date" value={assetActionDate} onChange={(e) => setAssetActionDate(e.target.value)}
                  className="bg-bg-input border border-border px-2 py-2" />
                <input value={assetProceeds} onChange={(e) => setAssetProceeds(e.target.value)}
                  placeholder="Disposal proceeds GH¢" inputMode="decimal"
                  className="bg-bg-input border border-border px-2 py-2" />
                <select value={assetProceedsAccountId} onChange={(e) => setAssetProceedsAccountId(e.target.value)}
                  className="col-span-2 bg-bg-input border border-border px-2 py-2">
                  {data.accounts.filter((account) => account.active).map((account) => (
                    <option key={account.id} value={account.id}>Receive proceeds into {account.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2 mt-2">
                <button onClick={() => void depreciateAsset()} className="px-3 py-2 border border-border">
                  Post straight-line depreciation
                </button>
                <button onClick={() => void disposeAsset()} className="px-3 py-2 border border-danger/60 text-danger">
                  Dispose asset
                </button>
              </div>
            </>
          )}
        </ControlBox>

        <ControlBox title="Owner capital contribution">
          <div className="grid grid-cols-2 gap-2">
            <select value={capitalAccountId} onChange={(e) => setCapitalAccountId(e.target.value)}
              className="bg-bg-input border border-border px-2 py-2">
              {data.accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            <input value={capitalAmount} onChange={(e) => setCapitalAmount(e.target.value)}
              inputMode="decimal" placeholder="GH¢ amount"
              className="bg-bg-input border border-border px-2 py-2" />
          </div>
          <button onClick={() => void addOwnerCapital()} disabled={!(Number(capitalAmount) > 0)}
            className="mt-2 px-3 py-2 border border-border disabled:opacity-40">Record contribution</button>
        </ControlBox>
      </div>

      {!cutoverActive && (
        <>
        <ControlBox title="Shadow verification">
          <p className="text-sm text-text-secondary mb-3">
            Dual-post normal sales and stock events before cutover. Shadow journals stay outside official statements.
          </p>
          <div className="text-sm mb-2">
            Status: <span className={shadow?.status === 'PASS' ? 'text-success' : shadow?.status === 'FAIL' ? 'text-danger' : 'text-text-tertiary'}>
              {shadow?.status ?? 'NOT RUNNING'}
            </span>
            {shadow?.startedAt && ` · since ${shadow.startedAt.slice(0, 10)}`}
          </div>
          {shadow && <div className="text-xs text-text-secondary mb-2">
            {shadow.salesChecked} sale(s) and {shadow.stockMovementsChecked} stock movement(s) checked.
          </div>}
          {shadow?.issues.map((issue) => (
            <div key={issue.code} className="text-xs text-danger">{issue.message}</div>
          ))}
          <button onClick={() => void toggleShadow(!shadow?.enabled)}
            className="mt-2 px-3 py-2 border border-border">
            {shadow?.enabled ? 'Stop shadow run' : 'Start shadow run'}
          </button>
        </ControlBox>
        <ControlBox title="Controlled cutover">
          <p className="text-sm text-text-secondary mb-3">
            Close all shifts, seal the prior day, complete a recent stocktake, then enter verified opening balances.
            Counter will use opening equity only as the balancing equity account.
          </p>
          <input type="date" value={cutoverDate} onChange={(e) => { setCutoverDate(e.target.value); setPreview(null); }}
            className="bg-bg-input border border-border px-2 py-2 mb-3" />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {balanceAccounts.map((account) => (
              <label key={account.id} className="text-xs text-text-secondary">
                {account.name} <span className="text-text-tertiary">({account.code})</span>
                <input value={balances[account.id] ?? ''}
                  onChange={(e) => {
                    setBalances((current) => ({ ...current, [account.id]: e.target.value }));
                    setPreview(null);
                  }}
                  inputMode="decimal" placeholder="GH¢ 0.00"
                  className="block w-full mt-1 bg-bg-input border border-border px-2 py-2 text-text-primary" />
              </label>
            ))}
          </div>
          {preview && (
            <div className="mt-3 border border-border p-3 text-sm">
              <div>Debits {formatMoneyWithCurrency(preview.debitPesewas)} · Credits {formatMoneyWithCurrency(preview.creditPesewas)}</div>
              <div>Opening equity {formatMoneyWithCurrency(preview.openingEquityPesewas)}</div>
              {preview.issues.map((issue) => (
                <div key={issue.code} className={issue.severity === 'BLOCKING' ? 'text-danger' : 'text-warning'}>
                  {issue.message}
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2 mt-3">
            <button onClick={() => void previewCutover()} className="px-3 py-2 border border-border">Preview opening position</button>
            {preview && !preview.issues.some((issue) => issue.severity === 'BLOCKING') && (
              <button onClick={() => void activateCutover()} className="px-3 py-2 bg-accent text-ink font-semibold">
                Activate balanced ledger
              </button>
            )}
          </div>
        </ControlBox>
        </>
      )}
    </ReportSection>
  );
}

function ControlBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-deep border border-border p-4">
      <h3 className="text-xs uppercase tracking-wider text-text-tertiary mb-3">{title}</h3>
      {children}
    </div>
  );
}

function QualityBanner({ quality }: { quality: ManagementDataQuality }) {
  const tone = quality.status === 'COMPLETE'
    ? 'border-success/50 bg-success/10'
    : quality.status === 'PROVISIONAL'
      ? 'border-warning/50 bg-warning/10'
      : 'border-danger/50 bg-danger/10';
  return (
    <section className={`border p-4 ${tone}`}>
      <div className="font-semibold">Data quality: {quality.status}</div>
      <div className="text-sm text-text-secondary mt-1">
        {quality.cutoverDate ? `Management ledger active from ${quality.cutoverDate}.` : 'Pre-cutover figures are legacy estimates.'}
      </div>
      {quality.issues.length > 0 && (
        <ul className="mt-3 list-disc pl-5 text-sm text-text-secondary space-y-1">
          {quality.issues.map((issue) => <li key={`${issue.code}-${issue.message}`}>{issue.message}</li>)}
        </ul>
      )}
    </section>
  );
}

function DrilldownPanel({ data, error, onClose }: {
  data: ManagementDrilldownResponse | null;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <section className="bg-bg-surface border border-accent/50 p-4 print:hidden">
      <div className="flex justify-between gap-3 items-center mb-3">
        <div>
          <h2 className="font-semibold">Source events</h2>
          {data?.legacyUnavailable && <p className="text-xs text-warning">Pre-cutover source detail remains in legacy operational reports.</p>}
        </div>
        <button onClick={onClose} className="px-3 py-1 border border-border">Close</button>
      </div>
      {error && <FeedbackBanner>{error}</FeedbackBanner>}
      {data && (
        <div className="overflow-x-auto max-h-96">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-text-tertiary border-b border-border">
              <th className="py-2">Date</th><th>Source</th><th>Description</th><th>Account</th><th className="text-right">Debit</th><th className="text-right">Credit</th>
            </tr></thead>
            <tbody>{data.rows.map((row) => (
              <tr key={`${row.journalEntryId}-${row.accountCode}`} className="border-b border-border-subtle">
                <td className="py-2 font-mono">{row.businessDate}</td>
                <td>{row.sourceType}<div className="text-text-tertiary font-mono">{row.sourceId}</div></td>
                <td>{row.description}</td><td>{row.accountName}</td>
                <td className="text-right font-mono">{row.debitPesewas ? formatMoneyWithCurrency(row.debitPesewas) : '—'}</td>
                <td className="text-right font-mono">{row.creditPesewas ? formatMoneyWithCurrency(row.creditPesewas) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
          {data.rows.length === 0 && <p className="text-sm text-text-tertiary py-3">No posted ledger source lines match this selection.</p>}
          {data.truncated && <p className="text-xs text-warning mt-2">Showing the latest 500 source lines.</p>}
        </div>
      )}
    </section>
  );
}

function ProfitView({ data, compact, onDrilldown }: {
  data: ManagementIncomeStatementResponse; compact: boolean;
  onDrilldown: (req: Omit<ManagementDrilldownRequest, 'reportAccessToken'>) => Promise<void>;
}) {
  const a = data.accrual;
  return (
    <ReportSection title="Profit — are we profitable?"
      answer={`Net management profit was ${formatMoneyWithCurrency(a.netManagementProfitPesewas)}${a.changePct == null ? '' : `, ${a.changePct >= 0 ? 'up' : 'down'} ${Math.abs(a.changePct).toFixed(1)}% from the preceding period`}.`}>
      <CardGrid items={[
        ['Net sales', a.netSalesPesewas], ['COGS', a.cogsPesewas],
        ['Gross profit', a.grossProfitPesewas], ['Operating profit', a.operatingProfitPesewas],
        ['Net management profit', a.netManagementProfitPesewas],
        ['Cash operating surplus', data.cash.cashOperatingSurplusPesewas],
      ]} />
      {!compact && (
        <LineTable lines={[
          ...a.operatingExpenseLines,
          ...a.inventoryLossLines,
          ...data.cash.reconciliationLines,
        ]} onDrilldown={(line) => onDrilldown({
          accountCode: line.code, fromDate: data.fromDate, toDate: data.toDate,
        })} />
      )}
    </ReportSection>
  );
}

function PositionView({ data, compact, onDrilldown }: {
  data: ManagementPositionResponse; compact: boolean;
  onDrilldown: (req: Omit<ManagementDrilldownRequest, 'reportAccessToken'>) => Promise<void>;
}) {
  return (
    <ReportSection title="Position — what do we own and owe?"
      answer={`Assets are ${formatMoneyWithCurrency(data.assets.totalPesewas)} against ${formatMoneyWithCurrency(data.liabilities.totalPesewas)} of liabilities. The accounting equation ${data.integrityOk ? 'balances exactly' : 'has an integrity error'}.`}>
      <CardGrid items={[
        ['Assets', data.assets.totalPesewas], ['Liabilities', data.liabilities.totalPesewas],
        ['Equity', data.equity.totalPesewas], ['Working capital', data.workingCapitalPesewas],
      ]} />
      {!compact && (
        <div className="grid lg:grid-cols-3 gap-3">
          <LineTable title="Assets" lines={data.assets.lines} onDrilldown={(line) => onDrilldown({ accountCode: line.code, asOfDate: data.asOfDate })} />
          <LineTable title="Liabilities" lines={data.liabilities.lines} onDrilldown={(line) => onDrilldown({ accountCode: line.code, asOfDate: data.asOfDate })} />
          <LineTable title="Equity" lines={data.equity.lines} onDrilldown={(line) => onDrilldown({ accountCode: line.code, asOfDate: data.asOfDate })} />
        </div>
      )}
    </ReportSection>
  );
}

function CashView({ data, compact, onDrilldown }: {
  data: ManagementCashflowResponse; compact: boolean;
  onDrilldown: (req: Omit<ManagementDrilldownRequest, 'reportAccessToken'>) => Promise<void>;
}) {
  return (
    <ReportSection title="Cash — where is the actual money?"
      answer={`Ending cash is ${formatMoneyWithCurrency(data.endingCashPesewas)}. Opening cash plus external flow ${data.integrityOk ? 'reconciles exactly' : 'does not reconcile'}.`}>
      <CardGrid items={[
        ['Opening cash', data.openingCashPesewas], ['Operating cash', data.operatingPesewas],
        ['Investing cash', data.investingPesewas], ['Financing cash', data.financingPesewas],
        ['Ending cash', data.endingCashPesewas],
      ]} />
      {!compact && (
        <LineTable title="Money by location" lines={data.accounts.map((account) => ({
          code: account.id, label: `${account.name}${account.lastReconciledAt ? '' : ' — unreconciled'}`,
          amountPesewas: account.balancePesewas,
        }))} onDrilldown={(line) => onDrilldown({
          financialAccountId: line.code, fromDate: data.fromDate, toDate: data.toDate,
        })} />
      )}
    </ReportSection>
  );
}

function ObligationsView({ data, compact, pin, accounts, onPaid, onPinConsumed, onDrilldown }: {
  data: ManagementObligationsResponse;
  compact: boolean;
  pin: string;
  accounts: ManagementAccountsListResponse['accounts'];
  onPaid: () => Promise<void>;
  onPinConsumed: () => void;
  onDrilldown: (req: Omit<ManagementDrilldownRequest, 'reportAccessToken'>) => Promise<void>;
}) {
  const [obligationId, setObligationId] = useState(data.rows[0]?.id ?? '');
  const selectedObligation = data.rows.find((row) => row.id === obligationId);
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState(selectedObligation?.dueDate ?? '');
  const [disputed, setDisputed] = useState(selectedObligation?.disputed ?? false);
  const [obligationNotes, setObligationNotes] = useState('');

  async function pay() {
    const result = await counter.managementPayObligation({
      obligationId, financialAccountId: accountId,
      amountPesewas: Math.round(Number(amount) * 100), pin,
    }).finally(onPinConsumed);
    if (!result.success) return setMessage(result.error);
    setMessage(`Payment posted; ${formatMoneyWithCurrency(result.data.outstandingPesewas)} remains.`);
    setAmount('');
    await onPaid();
  }
  async function maintain() {
    const result = await counter.managementUpdateObligation({
      obligationId, dueDate, disputed, notes: obligationNotes || null, pin,
    }).finally(onPinConsumed);
    setMessage(result.success ? 'Obligation details updated.' : result.error);
    if (result.success) await onPaid();
  }
  return (
    <ReportSection title="Obligations — what must we repay, and when?"
      answer={`${formatMoneyWithCurrency(data.dueNext30DaysPesewas)} is due in the next 30 days; ${formatMoneyWithCurrency(data.overduePesewas)} is overdue.`}>
      <CardGrid items={[
        ['Total outstanding', data.totalOutstandingPesewas], ['Overdue', data.overduePesewas],
        ['Due in 7 days', data.dueNext7DaysPesewas], ['Due in 30 days', data.dueNext30DaysPesewas],
        ['Reconciled cash', data.availableReconciledCashPesewas],
      ]} />
      {!compact && (
        <>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-text-tertiary border-b border-border">
              <th className="py-2">Due</th><th>Creditor</th><th>Type</th><th>Status</th><th className="text-right">Outstanding</th><th></th>
            </tr></thead>
            <tbody>{data.rows.map((row) => (
              <tr key={row.id} className="border-b border-border-subtle">
                <td className="py-2 font-mono">{row.dueDate ?? 'MISSING'}</td>
                <td>{row.creditorName}</td><td>{row.obligationType.replace(/_/g, ' ')}</td><td>{row.status}</td>
                <td className="text-right font-mono">{formatMoneyWithCurrency(row.outstandingPesewas)}</td>
                <td className="text-right"><button onClick={() => void onDrilldown({
                  sourceType: row.sourceType, sourceId: row.sourceId, asOfDate: data.asOfDate,
                })} className="underline text-xs">Source</button></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {data.rows.length > 0 && accounts.length > 0 && (
          <div className="border border-border p-3">
            <div className="text-xs uppercase text-text-tertiary mb-2">Pay an obligation</div>
            {message && <div className="text-sm mb-2">{message}</div>}
            <div className="grid sm:grid-cols-3 gap-2">
              <select value={obligationId} onChange={(e) => {
                const row = data.rows.find((item) => item.id === e.target.value);
                setObligationId(e.target.value); setDueDate(row?.dueDate ?? '');
                setDisputed(row?.disputed ?? false); setObligationNotes('');
              }}
                className="bg-bg-input border border-border px-2 py-2">
                {data.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.creditorName} — {formatMoneyWithCurrency(row.outstandingPesewas)}
                  </option>
                ))}
              </select>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}
                className="bg-bg-input border border-border px-2 py-2">
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
              </select>
              <input value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="GH¢ amount" inputMode="decimal"
                className="bg-bg-input border border-border px-2 py-2" />
            </div>
            <button onClick={() => void pay()} disabled={!(Number(amount) > 0)}
              className="mt-2 px-3 py-2 border border-border disabled:opacity-40">
              Allocate payment
            </button>
            <div className="grid sm:grid-cols-3 gap-2 mt-3 pt-3 border-t border-border-subtle">
              <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)}
                className="bg-bg-input border border-border px-2 py-2" />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={disputed} onChange={(e) => setDisputed(e.target.checked)} /> Disputed
              </label>
              <input value={obligationNotes} onChange={(e) => setObligationNotes(e.target.value)}
                placeholder="Maintenance note" className="bg-bg-input border border-border px-2 py-2" />
            </div>
            <button onClick={() => void maintain()} disabled={!dueDate}
              className="mt-2 px-3 py-2 border border-border disabled:opacity-40">Save due date/status</button>
          </div>
        )}
        </>
      )}
    </ReportSection>
  );
}

function ConcentrationView({ data, compact, pin, onRefresh, onPinConsumed }: {
  data: ManagementConcentrationResponse;
  compact: boolean;
  pin: string;
  onRefresh: () => Promise<void>;
  onPinConsumed: () => void;
}) {
  const danger = data.dimensions.filter((item) => item.risk === 'DANGER');
  const [message, setMessage] = useState<string | null>(null);
  async function saveThreshold(
    dimension: ManagementConcentrationResponse['dimensions'][number],
    warningPct: number,
    dangerPct: number,
  ) {
    const result = await counter.managementUpdateThreshold({
      dimension: dimension.dimension as 'CUSTOMER' | 'PRODUCT' | 'SUPPLIER' | 'CATEGORY' | 'PAYMENT_RAIL',
      warningBps: Math.round(warningPct * 100),
      dangerBps: Math.round(dangerPct * 100),
      pin,
    }).finally(onPinConsumed);
    setMessage(result.success ? `${dimension.dimension} thresholds saved.` : result.error);
    if (result.success) await onRefresh();
  }
  return (
    <ReportSection title="Concentration — where are we dangerously dependent?"
      answer={danger.length > 0
        ? `${danger.map((item) => item.dimension.toLowerCase().replace('_', ' ')).join(', ')} concentration is above the danger threshold.`
        : 'No measured concentration is above its configured danger threshold.'}>
      <div className="grid md:grid-cols-2 xl:grid-cols-5 gap-3">
        {data.dimensions.map((item) => (
          <div key={item.dimension} className="bg-bg-deep border border-border p-3">
            <div className="text-xs uppercase text-text-tertiary">{item.dimension.replace('_', ' ')}</div>
            <div className="font-mono text-xl mt-1">{(item.topOneBps / 100).toFixed(1)}%</div>
            <div className={`text-xs mt-1 ${item.risk === 'DANGER' ? 'text-danger' : item.risk === 'WARNING' ? 'text-warning' : 'text-success'}`}>
              {item.risk} · HHI {item.hhi}
            </div>
            {!compact && item.exposures[0] && <div className="text-xs text-text-secondary mt-2">{item.exposures[0].name}</div>}
            {!compact && (
              <ThresholdInputs
                warningBps={item.warningBps}
                dangerBps={item.dangerBps}
                onSave={(warning, danger) => void saveThreshold(item, warning, danger)}
              />
            )}
          </div>
        ))}
      </div>
      {message && <div className="text-sm text-text-secondary">{message}</div>}
    </ReportSection>
  );
}

function ThresholdInputs({ warningBps, dangerBps, onSave }: {
  warningBps: number;
  dangerBps: number;
  onSave: (warningPct: number, dangerPct: number) => void;
}) {
  const [warning, setWarning] = useState(String(warningBps / 100));
  const [danger, setDanger] = useState(String(dangerBps / 100));
  return (
    <div className="mt-3 grid grid-cols-2 gap-1">
      <input value={warning} onChange={(e) => setWarning(e.target.value)}
        aria-label="Warning threshold percent"
        className="min-w-0 bg-bg-input border border-border px-1 py-1 text-xs" />
      <input value={danger} onChange={(e) => setDanger(e.target.value)}
        aria-label="Danger threshold percent"
        className="min-w-0 bg-bg-input border border-border px-1 py-1 text-xs" />
      <button onClick={() => onSave(Number(warning), Number(danger))}
        className="col-span-2 border border-border py-1 text-xs">Save thresholds</button>
    </div>
  );
}

function DownsideView({ data, compact, pin, riskConfig, onRefresh, onPinConsumed, onUseScenario }: {
  data: ManagementDownsideResponse;
  compact: boolean;
  pin: string;
  riskConfig: ManagementRiskConfigResponse | null;
  onRefresh: () => Promise<void>;
  onPinConsumed: () => void;
  onUseScenario: (scenario: ManagementSavedScenario) => void;
}) {
  const [scenarioName, setScenarioName] = useState('');
  const [assumptionDriver, setAssumptionDriver] = useState('salesVolumeChangeBps');
  const [assumptionBaseline, setAssumptionBaseline] = useState('0');
  const [assumptionDownside, setAssumptionDownside] = useState('-10');
  const [assumptionRationale, setAssumptionRationale] = useState('');
  const [assumptionReviewDate, setAssumptionReviewDate] = useState(today);
  const [message, setMessage] = useState<string | null>(null);

  async function saveCurrentScenario() {
    const result = await counter.managementSaveScenario({
      name: scenarioName,
      horizonDays: data.horizonDays,
      drivers: data.drivers,
      pin,
    }).finally(onPinConsumed);
    setMessage(result.success ? `${result.data.name} saved.` : result.error);
    if (result.success) { setScenarioName(''); await onRefresh(); }
  }

  async function saveAssumption() {
    const result = await counter.managementSaveRiskAssumption({
      driver: assumptionDriver,
      baselineBps: Math.round(Number(assumptionBaseline) * 100),
      downsideBps: Math.round(Number(assumptionDownside) * 100),
      rationale: assumptionRationale || null,
      reviewDate: assumptionReviewDate || null,
      pin,
    }).finally(onPinConsumed);
    setMessage(result.success ? `${result.data.driver} assumption saved.` : result.error);
    if (result.success) { setAssumptionRationale(''); await onRefresh(); }
  }
  return (
    <ReportSection title="Downside — what happens if our assumptions are wrong?"
      answer={`${data.preset.replace('_', ' ')} leaves projected ending cash at ${formatMoneyWithCurrency(data.projected.endingCashPesewas)}${data.projected.firstNegativeCashDate ? ` and first turns negative on ${data.projected.firstNegativeCashDate}` : ''}.`}>
      <CardGrid items={[
        ['Revenue', data.projected.revenuePesewas],
        ['Gross profit', data.projected.grossProfitPesewas],
        ['Operating profit', data.projected.operatingProfitPesewas],
        ['Cash operating surplus', data.projected.cashOperatingSurplusPesewas],
        ['Minimum cash', data.projected.minimumCashPesewas],
        ['Break-even revenue', data.projected.breakEvenRevenuePesewas ?? 0],
      ]} />
      {!compact && (
        <>
          <p className="text-xs text-text-tertiary">{data.disclaimer}</p>
          {message && <FeedbackBanner>{message}</FeedbackBanner>}
          <div className="grid lg:grid-cols-2 gap-3 print:hidden">
            <ControlBox title="Saved management scenarios">
              <div className="space-y-2 mb-3">
                {(riskConfig?.scenarios ?? []).map((scenario) => (
                  <div key={scenario.id} className="flex justify-between items-center gap-2 text-sm">
                    <span>{scenario.name} · {scenario.horizonDays} days</span>
                    <button onClick={() => onUseScenario(scenario)} className="underline text-xs">Use</button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <input value={scenarioName} onChange={(e) => setScenarioName(e.target.value)}
                  placeholder="Scenario name" className="flex-1 bg-bg-input border border-border px-2 py-2" />
                <button onClick={() => void saveCurrentScenario()} disabled={!scenarioName.trim()}
                  className="px-3 py-2 border border-border disabled:opacity-40">Save current</button>
              </div>
            </ControlBox>
            <ControlBox title="Risk assumption register">
              <div className="space-y-2 mb-3">
                {(riskConfig?.assumptions ?? []).map((assumption) => (
                  <div key={assumption.id} className="text-sm border-b border-border-subtle pb-2">
                    <span className="font-medium">{assumption.driver}</span>
                    <span className="text-text-tertiary"> · {(assumption.baselineBps / 100).toFixed(1)}% → {(assumption.downsideBps / 100).toFixed(1)}% · review {assumption.reviewDate ?? 'not set'}</span>
                    {assumption.rationale && <div className="text-xs text-text-secondary">{assumption.rationale}</div>}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <select value={assumptionDriver} onChange={(e) => setAssumptionDriver(e.target.value)}
                  className="col-span-2 bg-bg-input border border-border px-2 py-2">
                  {Object.keys(data.drivers).map((driver) => <option key={driver}>{driver}</option>)}
                </select>
                <input value={assumptionBaseline} onChange={(e) => setAssumptionBaseline(e.target.value)}
                  placeholder="Baseline %" className="bg-bg-input border border-border px-2 py-2" />
                <input value={assumptionDownside} onChange={(e) => setAssumptionDownside(e.target.value)}
                  placeholder="Downside %" className="bg-bg-input border border-border px-2 py-2" />
                <input value={assumptionRationale} onChange={(e) => setAssumptionRationale(e.target.value)}
                  placeholder="Rationale" className="col-span-2 bg-bg-input border border-border px-2 py-2" />
                <input type="date" value={assumptionReviewDate} onChange={(e) => setAssumptionReviewDate(e.target.value)}
                  className="bg-bg-input border border-border px-2 py-2" />
                <button onClick={() => void saveAssumption()} className="px-3 py-2 border border-border">Save assumption</button>
              </div>
            </ControlBox>
          </div>
        </>
      )}
    </ReportSection>
  );
}

function ReportSection({ title, answer, children }: {
  title: string; answer: string; children: React.ReactNode;
}) {
  return (
    <section className="bg-bg-surface border border-border p-5 flex flex-col gap-4 break-inside-avoid">
      <div>
        <h2 className="text-xs uppercase tracking-wider text-text-tertiary">{title}</h2>
        <p className="text-lg mt-2">{answer}</p>
      </div>
      {children}
    </section>
  );
}

function CardGrid({ items }: { items: Array<[string, number]> }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
      {items.map(([label, amount]) => (
        <div key={label} className="bg-bg-deep border border-border p-3">
          <div className="text-xs uppercase text-text-tertiary">{label}</div>
          <div className={`font-mono tnum text-lg mt-1 ${amount < 0 ? 'text-danger' : ''}`}>
            {formatMoneyWithCurrency(amount)}
          </div>
        </div>
      ))}
    </div>
  );
}

function LineTable({ title, lines, onDrilldown }: {
  title?: string;
  lines: Array<{ code: string; label: string; amountPesewas: number; note?: string | null }>;
  onDrilldown?: (line: { code: string; label: string; amountPesewas: number; note?: string | null }) => void | Promise<void>;
}) {
  return (
    <div className="border border-border overflow-hidden">
      {title && <div className="px-3 py-2 text-xs uppercase text-text-tertiary bg-bg-deep">{title}</div>}
      <table className="w-full text-sm"><tbody>
        {lines.map((line, index) => (
          <tr key={`${line.code}-${index}`} className="border-t border-border-subtle">
            <td className="px-3 py-2">{line.label}{line.note && <div className="text-xs text-text-tertiary">{line.note}</div>}</td>
            <td className="px-3 py-2 text-right font-mono tnum">{formatMoneyWithCurrency(line.amountPesewas)}</td>
            {onDrilldown && <td className="px-3 py-2 text-right print:hidden">
              <button onClick={() => void onDrilldown(line)} className="underline text-xs">Source</button>
            </td>}
          </tr>
        ))}
      </tbody></table>
    </div>
  );
}

function exportPackCsv(data: Partial<LoadedPack>, fromDate: string, toDate: string) {
  const rows: Array<{ section: string; label: string; amountPesewas: number; note: string }> = [];
  if (data.profit) {
    const a = data.profit.accrual;
    rows.push(
      { section: 'Profit', label: 'Net sales', amountPesewas: a.netSalesPesewas, note: '' },
      { section: 'Profit', label: 'COGS', amountPesewas: a.cogsPesewas, note: '' },
      { section: 'Profit', label: 'Gross profit', amountPesewas: a.grossProfitPesewas, note: '' },
      { section: 'Profit', label: 'Operating profit', amountPesewas: a.operatingProfitPesewas, note: '' },
      { section: 'Profit', label: 'Net management profit', amountPesewas: a.netManagementProfitPesewas, note: '' },
      { section: 'Profit', label: 'Cash operating surplus', amountPesewas: data.profit.cash.cashOperatingSurplusPesewas, note: '' },
    );
  }
  if (data.position) {
    for (const line of data.position.assets.lines) rows.push({ section: 'Assets', label: line.label, amountPesewas: line.amountPesewas, note: line.note ?? '' });
    for (const line of data.position.liabilities.lines) rows.push({ section: 'Liabilities', label: line.label, amountPesewas: line.amountPesewas, note: line.note ?? '' });
    for (const line of data.position.equity.lines) rows.push({ section: 'Equity', label: line.label, amountPesewas: line.amountPesewas, note: line.note ?? '' });
  }
  if (data.cash) {
    for (const account of data.cash.accounts) {
      rows.push({
        section: 'Cash accounts', label: account.name,
        amountPesewas: account.balancePesewas,
        note: account.lastReconciledAt ? `Reconciled ${account.lastReconciledAt}` : 'Unreconciled',
      });
    }
  }
  if (data.obligations) {
    for (const obligation of data.obligations.rows) {
      rows.push({
        section: 'Obligations', label: obligation.creditorName,
        amountPesewas: obligation.outstandingPesewas,
        note: `${obligation.obligationType}; due ${obligation.dueDate ?? 'MISSING'}`,
      });
    }
  }
  if (data.concentration) {
    for (const item of data.concentration.dimensions) {
      rows.push({
        section: 'Concentration', label: `${item.dimension} top-one share`,
        amountPesewas: item.totalPesewas,
        note: `${(item.topOneBps / 100).toFixed(2)}%; HHI ${item.hhi}; ${item.risk}`,
      });
    }
  }
  if (data.downside) {
    rows.push(
      { section: 'Downside', label: 'Projected revenue', amountPesewas: data.downside.projected.revenuePesewas, note: data.downside.preset },
      { section: 'Downside', label: 'Projected operating profit', amountPesewas: data.downside.projected.operatingProfitPesewas, note: data.downside.preset },
      { section: 'Downside', label: 'Projected ending cash', amountPesewas: data.downside.projected.endingCashPesewas, note: data.downside.preset },
    );
  }
  exportRowsAsCsv(
    buildCsvFilename('owner_management_pack', [fromDate, toDate]),
    rows,
    [
      { header: 'section', get: (row) => row.section },
      { header: 'label', get: (row) => row.label },
      { header: 'amount_ghs', get: (row) => pesewasToCsvNumber(row.amountPesewas) },
      { header: 'note', get: (row) => row.note },
    ],
  );
}
