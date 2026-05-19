// DateRangePicker — preset chips (Today / Yesterday / This week / Last week
// / This month / Last month / Last 7 days / Last 30 days) plus two custom
// date inputs. Reports tabs all share this.
//
// Dates are always YYYY-MM-DD (no time, no timezone). The backend converts
// to local-midnight boundaries.

import { useMemo } from 'react';

export interface DateRange {
  fromDate: string;
  toDate: string;
  /** Which preset matched the current range; null = custom. */
  presetKey: PresetKey | null;
}

export type PresetKey =
  | 'today' | 'yesterday'
  | 'thisWeek' | 'lastWeek'
  | 'thisMonth' | 'lastMonth'
  | 'last7' | 'last30';

interface Props {
  value: DateRange;
  onChange: (r: DateRange) => void;
}

function pad(n: number): string { return String(n).padStart(2, '0'); }
function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d); out.setDate(out.getDate() + n); return out;
}
function startOfWeek(d: Date): Date {
  // Monday start
  const out = new Date(d); out.setHours(0, 0, 0, 0);
  const dow = out.getDay();
  out.setDate(out.getDate() - (dow === 0 ? 6 : dow - 1));
  return out;
}
function startOfMonth(d: Date): Date {
  const out = new Date(d); out.setHours(0, 0, 0, 0); out.setDate(1); return out;
}

export function rangeForPreset(key: PresetKey, now = new Date()): DateRange {
  const today = isoLocal(now);
  switch (key) {
    case 'today':
      return { fromDate: today, toDate: today, presetKey: key };
    case 'yesterday': {
      const y = isoLocal(addDays(now, -1));
      return { fromDate: y, toDate: y, presetKey: key };
    }
    case 'thisWeek':
      return { fromDate: isoLocal(startOfWeek(now)), toDate: today, presetKey: key };
    case 'lastWeek': {
      const thisWk = startOfWeek(now);
      const lastWkStart = addDays(thisWk, -7);
      const lastWkEnd = addDays(thisWk, -1);
      return { fromDate: isoLocal(lastWkStart), toDate: isoLocal(lastWkEnd), presetKey: key };
    }
    case 'thisMonth':
      return { fromDate: isoLocal(startOfMonth(now)), toDate: today, presetKey: key };
    case 'lastMonth': {
      const thisMon = startOfMonth(now);
      const lastMonEnd = addDays(thisMon, -1);
      const lastMonStart = startOfMonth(lastMonEnd);
      return { fromDate: isoLocal(lastMonStart), toDate: isoLocal(lastMonEnd), presetKey: key };
    }
    case 'last7':
      return { fromDate: isoLocal(addDays(now, -6)), toDate: today, presetKey: key };
    case 'last30':
      return { fromDate: isoLocal(addDays(now, -29)), toDate: today, presetKey: key };
  }
}

/** Default range when first opening a tab: this month. */
export function defaultDateRange(now = new Date()): DateRange {
  return rangeForPreset('thisMonth', now);
}

const PRESETS: Array<{ key: PresetKey; label: string }> = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'last30', label: 'Last 30 days' },
  { key: 'thisWeek', label: 'This week' },
  { key: 'lastWeek', label: 'Last week' },
  { key: 'thisMonth', label: 'This month' },
  { key: 'lastMonth', label: 'Last month' },
];

export function DateRangePicker({ value, onChange }: Props) {
  const summary = useMemo(() => formatRangeLabel(value), [value]);

  function pick(key: PresetKey) {
    onChange(rangeForPreset(key));
  }
  function setFrom(s: string) {
    onChange({ fromDate: s, toDate: value.toDate, presetKey: null });
  }
  function setTo(s: string) {
    onChange({ fromDate: value.fromDate, toDate: s, presetKey: null });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            onClick={() => pick(p.key)}
            className={[
              'px-3 py-1.5 text-xs border rounded-sm',
              value.presetKey === p.key
                ? 'bg-accent text-bg-deep border-accent font-semibold'
                : 'border-border text-text-secondary hover:text-text-primary hover:border-border-strong',
            ].join(' ')}
          >
            {p.label}
          </button>
        ))}
        <div className="flex items-center gap-2 ml-auto">
          <label className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wider text-text-tertiary">From</span>
            <input type="date" value={value.fromDate} onChange={(e) => setFrom(e.target.value)}
              className="bg-bg-input border border-border-strong px-2 py-1 text-sm font-mono" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-xs uppercase tracking-wider text-text-tertiary">To</span>
            <input type="date" value={value.toDate} onChange={(e) => setTo(e.target.value)}
              className="bg-bg-input border border-border-strong px-2 py-1 text-sm font-mono" />
          </label>
        </div>
      </div>
      <div className="text-xs text-text-tertiary">{summary}</div>
    </div>
  );
}

function formatRangeLabel(r: DateRange): string {
  if (r.fromDate === r.toDate) return `${r.fromDate} · 1 day`;
  const days = daysBetween(r.fromDate, r.toDate) + 1;
  return `${r.fromDate} → ${r.toDate} · ${days} days`;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}
