import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { counter } from '../lib/ipc';
import { useSession } from '../store/session';
import { FeedbackBanner } from '../components/FeedbackBanner';
import { SupervisorPinModal } from '../components/SupervisorPinModal';
import { formatMoney, formatMoneyWithCurrency, parseCedisToPesewas } from '../../shared/lib/money';
import type {
  CashDropListResponse,
  DrawingPolicyRow,
  ExpenseCategory,
  ExpenseRow,
  ExpenseTotalsForShiftResponse,
} from '../../shared/types/ipc';
import { SupplierPaymentsTab } from './settings/SupplierPaymentsTab';

type Tab = 'expenses' | 'drawings' | 'suppliers' | 'taxes';
type CashDropCategory = CashDropListResponse['drops'][number]['category'];

const EXPENSE_CATEGORIES: Array<{ value: ExpenseCategory; label: string }> = [
  { value: 'STAFF_WAGES', label: 'Staff wages' },
  { value: 'STAFF_ADVANCE', label: 'Staff advance' },
  { value: 'COMMISSION', label: 'Commission / bonus' },
  { value: 'STAFF_WELFARE', label: 'Staff welfare' },
  { value: 'UTILITIES', label: 'Utilities' },
  { value: 'TRANSPORT', label: 'Transport' },
  { value: 'SUPPLIES', label: 'Supplies' },
  { value: 'COMMS', label: 'Communications' },
  { value: 'REPAIRS', label: 'Repairs' },
  { value: 'RENT', label: 'Rent' },
  { value: 'BANK_FEES', label: 'Bank / MoMo fees' },
  { value: 'OTHER', label: 'Other' },
];

const CASH_DROP_CATEGORIES: Array<{ value: CashDropCategory; label: string }> = [
  { value: 'GENERIC_DROP', label: 'Cash moved out' },
  { value: 'OWNER_DRAWING', label: 'Owner drawing' },
  { value: 'FAMILY_SUPPORT', label: 'Family support' },
  { value: 'OWNER_SALARY', label: 'Owner salary' },
  { value: 'OTHER_DRAWING', label: 'Other drawing' },
];

const COMMON_RECIPIENTS = ['Owner', 'Bank deposit', 'Supplier payment', 'Other'];
const PHOTO_THRESHOLD = 5000;
const SUPERVISOR_THRESHOLD = 10000;

export default function MoneyOutScreen({ shiftId, onExit }: { shiftId: string; onExit: () => void }) {
  const [tab, setTab] = useState<Tab>('expenses');

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'F9') { e.preventDefault(); onExit(); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onExit]);

  return (
    <div className="min-h-screen bg-bg-deep text-text-primary flex flex-col">
      <header className="border-b border-border bg-bg-surface px-6 py-4 flex items-center justify-between">
        <div>
          <div className="text-text-tertiary uppercase tracking-wider text-xs">Money out</div>
          <h1 className="text-2xl font-semibold">Expenses, drawings, suppliers, tax</h1>
        </div>
        <button onClick={onExit} className="border border-border px-4 py-2 hover:bg-bg-elevated">
          Back <span className="ml-2 text-xs border border-border-subtle px-1">F9</span>
        </button>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6 flex flex-col gap-5">
        <nav className="bg-bg-surface border border-border p-2 flex flex-wrap gap-2">
          <TabButton active={tab === 'expenses'} onClick={() => setTab('expenses')}>Expenses</TabButton>
          <TabButton active={tab === 'drawings'} onClick={() => setTab('drawings')}>Drawings & cash</TabButton>
          <TabButton active={tab === 'suppliers'} onClick={() => setTab('suppliers')}>Supplier payments</TabButton>
          <TabButton active={tab === 'taxes'} onClick={() => setTab('taxes')}>Tax payments</TabButton>
        </nav>

        {tab === 'expenses' && <ExpensesPanel shiftId={shiftId} />}
        {tab === 'drawings' && <DrawingsPanel shiftId={shiftId} />}
        {tab === 'suppliers' && <SupplierPaymentsTab />}
        {tab === 'taxes' && <section className="panel p-6 text-sm text-text-secondary">Tax balances and payment recording now live in Reports → Taxes, protected by the five-minute report session. Recording a payment also requires a fresh one-time PIN.</section>}
      </main>
    </div>
  );
}

function ExpensesPanel({ shiftId }: { shiftId: string }) {
  const myRole = useSession((s) => s.workerRole);
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [totals, setTotals] = useState<ExpenseTotalsForShiftResponse | null>(null);
  const [amountRaw, setAmountRaw] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('UTILITIES');
  const [payee, setPayee] = useState('');
  const [notes, setNotes] = useState('');
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoExt, setPhotoExt] = useState<string | null>(null);
  const [supervisorWorkerId, setSupervisorWorkerId] = useState('');
  const [supervisorPin, setSupervisorPin] = useState('');
  const [supervisors, setSupervisors] = useState<Array<{ id: string; fullName: string; role: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const amount = parseCedisToPesewas(amountRaw);
  const needsPhoto = amount != null && amount >= PHOTO_THRESHOLD;
  const needsSupervisor = amount != null && amount >= SUPERVISOR_THRESHOLD;
  const cashierCanApprove = myRole === 'SUPERVISOR' || myRole === 'OWNER' || myRole === 'FOUNDER';

  async function refresh() {
    const [list, total] = await Promise.all([
      counter.listExpensesForShift(shiftId),
      counter.expenseTotalsForShift(shiftId),
    ]);
    if (!list.success) { setError(list.error); return; }
    if (!total.success) { setError(total.error); return; }
    setRows(list.data.rows);
    setTotals(total.data);
    setError(null);
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [shiftId]);

  async function ensureSupervisors() {
    if (supervisors.length > 0) return;
    const r = await counter.adminListWorkers();
    if (!r.success) return;
    const ws = r.data.workers
      .filter((w) => w.active && ['SUPERVISOR', 'OWNER', 'FOUNDER'].includes(w.role))
      .map((w) => ({ id: w.id, fullName: w.fullName, role: w.role }));
    setSupervisors(ws);
    if (ws[0]) setSupervisorWorkerId(ws[0].id);
  }

  function onPickPhoto(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      const comma = result.indexOf(',');
      setPhotoBase64(comma >= 0 ? result.slice(comma + 1) : result);
      setPhotoExt(ext);
    };
    reader.readAsDataURL(file);
  }

  async function submit() {
    setError(null);
    if (amount == null || amount <= 0) { setError('Enter a positive amount.'); return; }
    if (needsPhoto && !photoBase64) { setError('Attach a receipt photo for expenses of GHS 50 or more.'); return; }
    if (needsSupervisor && (!supervisorWorkerId || !supervisorPin)) {
      setError('Supervisor PIN is required for expenses of GHS 100 or more.');
      return;
    }
    setSaving(true);
    const r = await counter.recordExpense({
      amountPesewas: amount,
      category,
      payee: payee.trim() || null,
      notes: notes.trim() || null,
      supervisorWorkerId: needsSupervisor ? supervisorWorkerId : null,
      supervisorPin: needsSupervisor ? supervisorPin : null,
      photoBase64,
      photoExtension: photoExt,
    });
    setSaving(false);
    if (!r.success) { setError(r.error); return; }
    setAmountRaw('');
    setPayee('');
    setNotes('');
    setPhotoBase64(null);
    setPhotoExt(null);
    setSupervisorPin('');
    setInfo('Expense recorded.');
    window.setTimeout(() => setInfo(null), 3000);
    await refresh();
  }

  const categoryTotals = totals?.byCategory ?? [];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[0.95fr_1.25fr] gap-5">
      <section className="bg-bg-surface border border-border p-4">
        <SectionTitle title="Record expense" subtitle="Bills, transport, repairs, staff wages, bank fees." />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
          <Field label="Amount">
            <input
              value={amountRaw}
              onChange={(e) => setAmountRaw(e.target.value)}
              autoFocus
              placeholder="0.00"
              inputMode="decimal"
              className="w-full bg-bg-input border border-border px-3 py-2 font-mono tnum text-right"
            />
          </Field>
          <Field label="Category">
            <select value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}
              className="w-full bg-bg-input border border-border px-3 py-2">
              {EXPENSE_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Paid to" className="mt-3">
          <input value={payee} onChange={(e) => setPayee(e.target.value)}
            placeholder="Worker, utility company, driver, vendor"
            className="w-full bg-bg-input border border-border px-3 py-2" />
        </Field>

        {needsPhoto && (
          <Field label="Receipt photo" className="mt-3">
            <input type="file" accept="image/*" onChange={onPickPhoto}
              className="w-full text-sm text-text-secondary" />
            {photoBase64 && <div className="text-success text-xs mt-1">Photo attached.</div>}
          </Field>
        )}

        {needsSupervisor && (
          <div className="mt-3 border border-warning/40 bg-warning/10 p-3">
            <div className="text-warning text-xs uppercase tracking-wider mb-2">
              Supervisor approval
            </div>
            {cashierCanApprove && (
              <div className="text-xs text-text-tertiary mb-2">
                Select your name and enter your PIN, or choose another supervisor.
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <select
                value={supervisorWorkerId}
                onFocus={() => void ensureSupervisors()}
                onChange={(e) => setSupervisorWorkerId(e.target.value)}
                className="bg-bg-input border border-border px-3 py-2">
                <option value="">Pick supervisor</option>
                {supervisors.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.role})</option>)}
              </select>
              <input
                value={supervisorPin}
                onChange={(e) => setSupervisorPin(e.target.value.replace(/\D/g, ''))}
                type="password"
                inputMode="numeric"
                maxLength={6}
                placeholder="PIN"
                className="bg-bg-input border border-border px-3 py-2"
              />
            </div>
          </div>
        )}

        <Field label="Notes" className="mt-3">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
            className="w-full bg-bg-input border border-border px-3 py-2 min-h-20" />
        </Field>

        {error && <div className="mt-3"><FeedbackBanner>{error}</FeedbackBanner></div>}
        {info && <div className="mt-3 border border-success/40 bg-success/10 text-success px-3 py-2 text-sm">{info}</div>}

        <button
          onClick={() => void submit()}
          disabled={saving || amount == null || amount <= 0}
          className="mt-4 bg-accent text-white px-5 py-2 font-semibold disabled:opacity-50 disabled:cursor-not-allowed">
          {saving ? 'Recording...' : amount != null && amount > 0 ? `Record ${formatMoney(amount)}` : 'Record expense'}
        </button>
      </section>

      <section className="bg-bg-surface border border-border">
        <Header title="This shift expenses" count={rows.length} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 p-4 border-b border-border-subtle">
          <Stat label="Total" value={formatMoneyWithCurrency(totals?.totalPesewas ?? 0)} />
          {categoryTotals.slice(0, 2).map((row) => (
            <Stat key={row.category} label={labelize(row.category)} value={formatMoneyWithCurrency(row.totalPesewas)} />
          ))}
        </div>
        <SimpleTable
          empty="No expenses recorded this shift."
          rows={rows.map((r) => ({
            id: r.id,
            left: labelize(r.category),
            sub: `${r.payee ?? 'No payee'} - ${new Date(r.createdAt).toLocaleTimeString()}`,
            right: formatMoneyWithCurrency(r.amountPesewas),
          }))}
        />
      </section>
    </div>
  );
}

function DrawingsPanel({ shiftId }: { shiftId: string }) {
  const [expected, setExpected] = useState<number | null>(null);
  const [drops, setDrops] = useState<CashDropListResponse['drops']>([]);
  const [policies, setPolicies] = useState<DrawingPolicyRow[]>([]);
  const [amountRaw, setAmountRaw] = useState('');
  const [recipient, setRecipient] = useState(COMMON_RECIPIENTS[0]!);
  const [customRecipient, setCustomRecipient] = useState('');
  const [category, setCategory] = useState<CashDropCategory>('GENERIC_DROP');
  const [drawingPolicyId, setDrawingPolicyId] = useState('');
  const [notes, setNotes] = useState('');
  const [askingSupervisor, setAskingSupervisor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const amount = parseCedisToPesewas(amountRaw);
  const selectedPolicy = policies.find((p) => p.id === drawingPolicyId);
  const finalRecipient = selectedPolicy?.beneficiaryName
    ?? (recipient === 'Other' ? customRecipient.trim() : recipient);
  const valid = amount != null && amount > 0 && finalRecipient.length > 0
    && (expected == null || amount <= expected);

  async function refresh() {
    const [exp, list, pol] = await Promise.all([
      counter.getExpectedCash(shiftId),
      counter.listCashDrops(shiftId),
      counter.listDrawingPolicies(),
    ]);
    if (exp.success) setExpected(exp.data.expectedCashPesewas);
    if (list.success) setDrops(list.data.drops);
    if (pol.success) setPolicies(pol.data.policies.filter((p) => p.active));
  }

  useEffect(() => { void refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [shiftId]);

  async function approve(supervisorWorkerId: string, supervisorPin: string) {
    if (!amount) return;
    setError(null);
    const r = await counter.recordCashDrop({
      shiftId,
      amountPesewas: amount,
      recipient: finalRecipient,
      category,
      drawingPolicyId: drawingPolicyId || null,
      notes: notes.trim() || null,
      supervisorWorkerId,
      supervisorPin,
    });
    setAskingSupervisor(false);
    if (!r.success) { setError(r.error); return; }
    setAmountRaw('');
    setNotes('');
    setCustomRecipient('');
    setDrawingPolicyId('');
    setExpected(r.data.expectedCashAfterDropPesewas);
    setInfo('Cash movement recorded.');
    window.setTimeout(() => setInfo(null), 3000);
    await refresh();
  }

  const total = useMemo(() => drops.reduce((sum, row) => sum + row.amountPesewas, 0), [drops]);
  const selectedPolicies = policies.filter((p) => p.category === category);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[0.95fr_1.25fr] gap-5">
      <section className="bg-bg-surface border border-border p-4">
        <SectionTitle title="Record drawing or cash movement" subtitle="Owner drawings, family support, safe drops, bank deposits." />
        {expected != null && (
          <div className="mt-3 bg-bg-deep/50 border border-border-subtle p-3 text-sm">
            Expected till cash <span className="font-mono tnum text-text-primary">{formatMoneyWithCurrency(expected)}</span>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
          <Field label="Amount">
            <input value={amountRaw} onChange={(e) => setAmountRaw(e.target.value)}
              placeholder="0.00" inputMode="decimal"
              className="w-full bg-bg-input border border-border px-3 py-2 font-mono tnum text-right" />
          </Field>
          <Field label="Category">
            <select value={category} onChange={(e) => { setCategory(e.target.value as CashDropCategory); setDrawingPolicyId(''); }}
              className="w-full bg-bg-input border border-border px-3 py-2">
              {CASH_DROP_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
        </div>

        {category !== 'GENERIC_DROP' && (
          <Field label="Drawing policy" className="mt-3">
            <select value={drawingPolicyId} onChange={(e) => setDrawingPolicyId(e.target.value)}
              className="w-full bg-bg-input border border-border px-3 py-2">
              <option value="">No recurring policy</option>
              {selectedPolicies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.beneficiaryName} - {p.cadence.toLowerCase()} cap {formatMoneyWithCurrency(p.limitPesewas)}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="Recipient" className="mt-3">
          <select value={recipient} onChange={(e) => setRecipient(e.target.value)}
            className="w-full bg-bg-input border border-border px-3 py-2">
            {COMMON_RECIPIENTS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </Field>
        {recipient === 'Other' && (
          <input value={customRecipient} onChange={(e) => setCustomRecipient(e.target.value)}
            placeholder="Recipient name"
            className="mt-3 w-full bg-bg-input border border-border px-3 py-2" />
        )}

        <Field label="Notes" className="mt-3">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
            className="w-full bg-bg-input border border-border px-3 py-2 min-h-20" />
        </Field>

        {amount != null && expected != null && amount > expected && (
          <div className="mt-3 text-danger text-sm">
            Exceeds expected cash by {formatMoneyWithCurrency(amount - expected)}.
          </div>
        )}
        {error && <div className="mt-3"><FeedbackBanner>{error}</FeedbackBanner></div>}
        {info && <div className="mt-3 border border-success/40 bg-success/10 text-success px-3 py-2 text-sm">{info}</div>}

        <button
          onClick={() => valid && setAskingSupervisor(true)}
          disabled={!valid}
          className="mt-4 bg-accent text-white px-5 py-2 font-semibold disabled:opacity-50 disabled:cursor-not-allowed">
          Get supervisor approval
        </button>
      </section>

      <section className="bg-bg-surface border border-border">
        <Header title="This shift cash out" count={drops.length} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4 border-b border-border-subtle">
          <Stat label="Total moved out" value={formatMoneyWithCurrency(total)} />
          <Stat label="Current expected" value={expected == null ? '...' : formatMoneyWithCurrency(expected)} />
        </div>
        <SimpleTable
          empty="No cash drops or drawings recorded this shift."
          rows={drops.map((r) => ({
            id: r.id,
            left: labelize(r.category),
            sub: `${r.beneficiaryName ?? extractRecipient(r.notes)} - ${new Date(r.createdAt).toLocaleTimeString()}`,
            right: formatMoneyWithCurrency(r.amountPesewas),
          }))}
        />
      </section>

      {askingSupervisor && (
        <SupervisorPinModal
          title={`Approve ${amount != null ? formatMoneyWithCurrency(amount) : ''} to ${finalRecipient}`}
          onCancel={() => setAskingSupervisor(false)}
          onApprove={approve}
        />
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm border ${active ? 'bg-accent text-white border-accent' : 'border-border hover:bg-bg-elevated text-text-secondary'}`}>
      {children}
    </button>
  );
}

function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h2 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h2>
      <div className="text-text-tertiary text-sm mt-1">{subtitle}</div>
    </div>
  );
}

function Field({ label, className = '', children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-text-tertiary uppercase tracking-wider text-xs mb-1">{label}</span>
      {children}
    </label>
  );
}

function Header({ title, count }: { title: string; count: number }) {
  return (
    <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
      <h3 className="text-text-secondary uppercase tracking-wider text-xs">{title}</h3>
      <span className="text-text-tertiary text-xs">{count} row{count === 1 ? '' : 's'}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border-subtle bg-bg-deep/30 p-3">
      <div className="text-text-tertiary uppercase tracking-wider text-xs">{label}</div>
      <div className="font-mono tnum text-lg mt-1">{value}</div>
    </div>
  );
}

function SimpleTable({
  rows,
  empty,
}: {
  rows: Array<{ id: string; left: string; sub: string; right: string }>;
  empty: string;
}) {
  return (
    <div className="divide-y divide-border-subtle">
      {rows.length === 0 && <div className="px-4 py-8 text-center text-text-tertiary text-sm">{empty}</div>}
      {rows.map((row) => (
        <div key={row.id} className="px-4 py-3 flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">{row.left}</div>
            <div className="text-text-tertiary text-xs">{row.sub}</div>
          </div>
          <div className="font-mono tnum">{row.right}</div>
        </div>
      ))}
    </div>
  );
}

function labelize(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractRecipient(notes: string | null): string {
  if (!notes) return 'Cash out';
  const match = notes.match(/^to:\s*([^-\u2014]+)/i);
  return match?.[1]?.trim() || 'Cash out';
}
