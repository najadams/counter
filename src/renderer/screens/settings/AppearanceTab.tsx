// AppearanceTab — theme switcher AND receipt customization.
//
// Theme persistence and the synchronous boot script that prevents FOUC live
// in src/renderer/store/theme.ts and index.html.
//
// Receipt customization is stored as a JSON blob in device_config
// (receipt_config) plus the existing shop_name / shop_subtitle keys. OWNER
// or FOUNDER only; cashiers see a read-only view with the same live
// preview.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTheme } from '../../store/theme';
import { useSession } from '../../store/session';
import { counter } from '../../lib/ipc';
import { ReceiptBody } from '../../components/ReceiptPrintModal';
import type {
  ReceiptConfigResponse, ReceiptDensity, ReceiptPaperWidth,
} from '../../../shared/types/ipc';
import type { SaleReceipt } from '../../../shared/lib/receipt';

export function AppearanceTab() {
  const choice = useTheme((s) => s.choice);
  const resolved = useTheme((s) => s.resolved);
  const setChoice = useTheme((s) => s.setChoice);

  return (
    <div className="max-w-6xl flex flex-col gap-8">
      <section>
        <h2 className="text-text-secondary uppercase tracking-wider text-xs mb-3">Theme</h2>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <ThemeCard
            label="Dark"
            description="Original. Sharp gold on near-black."
            active={choice === 'dark'}
            onClick={() => setChoice('dark')}
            swatch={<Swatch bg="#0A0C10" fg="#EDE8DF" accent="#C9A84C" border="#3A4150" />}
          />
          <ThemeCard
            label="Light"
            description="Warm parchment. Darker gold for legibility."
            active={choice === 'light'}
            onClick={() => setChoice('light')}
            swatch={<Swatch bg="#F6F3EB" fg="#1A1C20" accent="#B28A38" border="#A8A394" />}
          />
          <ThemeCard
            label="Violet"
            description="Modern. Cool grey with vivid violet accent."
            active={choice === 'violet'}
            onClick={() => setChoice('violet')}
            swatch={<Swatch bg="#EDEDF3" fg="#121218" accent="#7C3AED" border="#C4C4D2" />}
          />
          <ThemeCard
            label="System"
            description={`Follow OS · currently ${resolved}.`}
            active={choice === 'system'}
            onClick={() => setChoice('system')}
            swatch={<DiagonalSwatch />}
          />
        </div>
        <p className="text-xs text-text-tertiary mt-3">
          The choice is remembered on this device only. Printed receipts always use
          white paper with black ink, regardless of the screen theme.
        </p>
      </section>

      <ReceiptSection />
    </div>
  );
}

// --- Receipt customization section ---------------------------------------

const SAMPLE_RECEIPT: SaleReceipt = {
  shopName: 'COUNTER SHOP',
  shopSubtitle: 'Accra, Ghana',
  receiptId: 'sale-preview-7c4b9aa1',
  workerName: 'Beatrice',
  saleAt: new Date().toISOString(),
  channel: 'WALK_IN',
  customerName: null,
  lines: [
    { quantity: 1, name: '5star', unitPricePesewas: 4400, lineTotalPesewas: 4400 },
    { quantity: 1, name: '5star choco malt', unitPricePesewas: 4700, lineTotalPesewas: 4700 },
    { quantity: 2, name: '5star kids', unitPricePesewas: 3100, lineTotalPesewas: 6200 },
  ],
  subtotalPesewas: 15300,
  discountPesewas: 0,
  totalPesewas: 15300,
  payment: {
    method: 'CASH',
    cashGivenPesewas: 15300,
    changePesewas: 0,
  },
  payments: [{
    method: 'CASH',
    amountPesewas: 15300,
    cashGivenPesewas: 15300,
    changePesewas: 0,
  }],
};

interface InlineMessage { kind: 'success' | 'danger'; text: string }

function ReceiptSection(): JSX.Element {
  const role = useSession((s) => s.workerRole);
  const isOwner = role === 'OWNER' || role === 'FOUNDER';

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [config, setConfig] = useState<ReceiptConfigResponse | null>(null);
  const [draft, setDraft] = useState<ReceiptConfigResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<InlineMessage | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await counter.receiptGetConfig();
      if (!r.success) {
        setLoadError(r.error);
        setLoaded(true);
        return;
      }
      setConfig(r.data);
      setDraft(r.data);
      setLoaded(true);
    })();
  }, []);

  const dirty = useMemo(
    () => !!config && !!draft && JSON.stringify(config) !== JSON.stringify(draft),
    [config, draft],
  );

  async function save() {
    if (!draft) return;
    setSaving(true);
    setMessage(null);
    const r = await counter.receiptSetConfig(draft);
    setSaving(false);
    if (!r.success) {
      setMessage({ kind: 'danger', text: r.error });
      return;
    }
    setConfig(r.data);
    setDraft(r.data);
    setMessage({ kind: 'success', text: 'Receipt settings saved.' });
  }

  function reset() {
    if (!config) return;
    setDraft(config);
    setMessage(null);
  }

  function patch<K extends keyof ReceiptConfigResponse>(key: K, value: ReceiptConfigResponse[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
    setMessage(null);
  }

  if (!loaded) {
    return (
      <section className="border-t border-border-subtle pt-6">
        <h2 className="text-text-secondary uppercase tracking-wider text-xs mb-3">Receipts</h2>
        <p className="text-text-tertiary text-sm">Loading…</p>
      </section>
    );
  }
  if (loadError || !draft) {
    return (
      <section className="border-t border-border-subtle pt-6">
        <h2 className="text-text-secondary uppercase tracking-wider text-xs mb-3">Receipts</h2>
        <p className="text-rose-400 text-sm">Could not load receipt settings: {loadError ?? 'unknown error'}</p>
      </section>
    );
  }

  return (
    <section className="border-t border-border-subtle pt-6 space-y-4">
      <div>
        <h2 className="text-text-secondary uppercase tracking-wider text-xs">Receipts</h2>
        <p className="text-xs text-text-tertiary mt-1">
          Header, footer, layout — applied to every printed receipt and the on-screen reprint preview.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] gap-8 items-start">
        {/* Form */}
        <fieldset disabled={!isOwner} className="space-y-5 min-w-0">
          {/* Header */}
          <FormGroup label="Shop header">
            <TextField
              label="Shop name"
              value={draft.shopName}
              onChange={(v) => patch('shopName', v)}
              placeholder="My Shop"
            />
            <TextField
              label="Subtitle (line 2)"
              value={draft.shopSubtitle ?? ''}
              onChange={(v) => patch('shopSubtitle', v || null)}
              placeholder="Accra, Ghana"
            />
            <TextField
              label="Line 3 (e.g. phone)"
              value={draft.headerLine3 ?? ''}
              onChange={(v) => patch('headerLine3', v || null)}
              placeholder="0244-123456"
            />
            <TextField
              label="Line 4 (e.g. address)"
              value={draft.headerLine4 ?? ''}
              onChange={(v) => patch('headerLine4', v || null)}
              placeholder="Adabraka High St."
            />
          </FormGroup>

          {/* Footer */}
          <FormGroup label="Footer message">
            <TextField
              label="Bottom line"
              value={draft.footerText}
              onChange={(v) => patch('footerText', v)}
              placeholder="Thank you. Come again."
            />
          </FormGroup>

          {/* Paper / layout */}
          <FormGroup label="Paper & layout">
            <RadioRow
              label="Paper width"
              options={[
                { value: 58, label: '58 mm', hint: 'Narrow roll' },
                { value: 80, label: '80 mm', hint: 'Standard roll' },
              ]}
              value={draft.paperWidthMm}
              onChange={(v) => patch('paperWidthMm', v as ReceiptPaperWidth)}
            />
            <NumberField
              label="Side margin"
              suffix="mm"
              min={0}
              max={6}
              value={draft.sideMarginMm}
              onChange={(v) => patch('sideMarginMm', v)}
              hint="0–6 mm. Smaller = more text width."
            />
            <RadioRow
              label="Density"
              options={[
                { value: 'compact', label: 'Compact', hint: 'Save paper' },
                { value: 'normal', label: 'Normal', hint: 'Recommended' },
                { value: 'spacious', label: 'Spacious', hint: 'Easier reading' },
              ]}
              value={draft.density}
              onChange={(v) => patch('density', v as ReceiptDensity)}
            />
            <Checkbox
              label="Use bold text"
              checked={draft.bold}
              onChange={(v) => patch('bold', v)}
              hint="Bolder ink — darker print on faint thermal paper."
            />
          </FormGroup>

          {/* Visibility */}
          <FormGroup label="Show on receipt">
            <Checkbox
              label="Cashier name"
              checked={draft.showCashier}
              onChange={(v) => patch('showCashier', v)}
            />
            <Checkbox
              label="Channel (wholesale / route)"
              checked={draft.showChannel}
              onChange={(v) => patch('showChannel', v)}
              hint="Walk-in sales never display the channel line."
            />
            <Checkbox
              label="Customer name"
              checked={draft.showCustomer}
              onChange={(v) => patch('showCustomer', v)}
              hint="Only shown for credit / named-customer sales."
            />
          </FormGroup>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => void save()}
              disabled={!isOwner || !dirty || saving}
              className="bg-accent text-ink px-4 py-2 font-semibold hover:bg-accent-light disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save receipt settings'}
            </button>
            <button
              onClick={reset}
              disabled={!dirty || saving}
              className="border border-border px-4 py-2 hover:bg-bg-elevated disabled:opacity-50"
            >
              Revert
            </button>
            {!isOwner && (
              <span className="text-xs text-text-tertiary">
                Only OWNER or FOUNDER can change receipt settings.
              </span>
            )}
          </div>
          {message && (
            <p className={`text-sm ${message.kind === 'success' ? 'text-emerald-400' : 'text-rose-400'}`}>
              {message.text}
            </p>
          )}
        </fieldset>

        {/* Live preview */}
        <div className="lg:sticky lg:top-4">
          <div className="text-text-secondary uppercase tracking-wider text-xs mb-2">
            Live preview · {draft.paperWidthMm} mm
          </div>
          <div
            className="bg-white shadow-2xl border border-border-strong"
            style={{ width: `${Math.round(draft.paperWidthMm * 3.78)}px` }}
          >
            <ReceiptBody
              receipt={{
                ...SAMPLE_RECEIPT,
                shopName: draft.shopName || SAMPLE_RECEIPT.shopName,
                shopSubtitle: draft.shopSubtitle ?? SAMPLE_RECEIPT.shopSubtitle,
              }}
              config={draft}
            />
          </div>
          <p className="text-[11px] text-text-tertiary mt-2 max-w-[80mm]">
            Preview at roll width. Actual paper output depends on the printer driver,
            but spacing and weight match.
          </p>
        </div>
      </div>
    </section>
  );
}

// --- small form primitives ----------------------------------------------

function FormGroup({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-2">
      <div className="text-text-secondary uppercase tracking-wider text-xs">{label}</div>
      <div className="space-y-3 pl-1">{children}</div>
    </div>
  );
}

function TextField({
  label, value, onChange, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }): JSX.Element {
  return (
    <label className="block text-sm">
      <span className="text-text-secondary">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full bg-bg-surface border border-border px-3 py-2 text-text-primary disabled:opacity-60"
      />
    </label>
  );
}

function NumberField({
  label, value, onChange, min, max, suffix, hint,
}: { label: string; value: number; onChange: (v: number) => void; min: number; max: number; suffix?: string; hint?: string }): JSX.Element {
  return (
    <label className="block text-sm">
      <span className="text-text-secondary">{label}</span>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
          }}
          className="w-24 bg-bg-surface border border-border px-3 py-2 text-text-primary disabled:opacity-60"
        />
        {suffix && <span className="text-text-tertiary">{suffix}</span>}
      </div>
      {hint && <span className="block text-xs text-text-tertiary mt-1">{hint}</span>}
    </label>
  );
}

function Checkbox({
  label, checked, onChange, hint,
}: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }): JSX.Element {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="text-text-primary">{label}</span>
        {hint && <span className="block text-xs text-text-tertiary">{hint}</span>}
      </span>
    </label>
  );
}

function RadioRow<T extends string | number>({
  label, value, onChange, options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; hint?: string }>;
}): JSX.Element {
  return (
    <fieldset className="text-sm">
      <legend className="text-text-secondary">{label}</legend>
      <div className="flex flex-wrap gap-2 mt-1">
        {options.map((opt) => (
          <label
            key={String(opt.value)}
            className={[
              'flex-1 min-w-[110px] border px-3 py-2 cursor-pointer transition-colors',
              value === opt.value
                ? 'border-accent bg-bg-elevated'
                : 'border-border bg-bg-surface hover:bg-bg-elevated',
            ].join(' ')}
          >
            <input
              type="radio"
              name={label}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              className="sr-only"
            />
            <div className="font-medium text-text-primary">{opt.label}</div>
            {opt.hint && <div className="text-xs text-text-tertiary">{opt.hint}</div>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

// --- theme swatches (unchanged) -----------------------------------------

function ThemeCard({
  label, description, active, onClick, swatch,
}: {
  label: string;
  description: string;
  active: boolean;
  onClick: () => void;
  swatch: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex flex-col text-left border p-4 transition-colors',
        active
          ? 'border-accent bg-bg-elevated'
          : 'border-border bg-bg-surface hover:bg-bg-elevated',
      ].join(' ')}
    >
      <div className="mb-3">{swatch}</div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-text-primary">{label}</span>
        {active && <span className="text-[10px] uppercase tracking-wider text-accent">Active</span>}
      </div>
      <span className="text-xs text-text-tertiary mt-1">{description}</span>
    </button>
  );
}

function Swatch({ bg, fg, accent, border }: { bg: string; fg: string; accent: string; border: string }) {
  return (
    <div
      className="w-full h-16 border flex items-end gap-1 p-2"
      style={{ background: bg, borderColor: border }}>
      <span className="block w-6 h-3" style={{ background: accent }} />
      <span className="block w-10 h-2" style={{ background: fg, opacity: 0.7 }} />
      <span className="block w-4 h-2" style={{ background: fg, opacity: 0.4 }} />
    </div>
  );
}

function DiagonalSwatch() {
  return (
    <div className="w-full h-16 border border-border-strong relative overflow-hidden">
      <div className="absolute inset-0" style={{ background: '#0A0C10' }} />
      <div
        className="absolute inset-0"
        style={{
          background: '#F6F3EB',
          clipPath: 'polygon(100% 0, 100% 100%, 0 100%)',
        }} />
      <span
        className="absolute left-2 top-2 block w-6 h-3"
        style={{ background: '#C9A84C' }} />
      <span
        className="absolute right-2 bottom-2 block w-6 h-3"
        style={{ background: '#B28A38' }} />
    </div>
  );
}
