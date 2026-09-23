import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

/**
 * A small group of mutually exclusive buttons that switch a view or a mode
 * in place (Pending / History, FIFO / Manual). Each is a real button with
 * aria-pressed, so tests and screen readers see the choice. For switching
 * between whole panels with arrow-key movement, use Tabs.
 */
export function Segmented<T extends string>({ value, onChange, options, label, className, disabled }: {
  value: T;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  /** Names the group for screen readers. */
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} data-slot="segmented" className={cn('inline-flex gap-1 rounded-xl border border-border bg-bg-surface p-1', className)}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className="inline-flex min-h-8 items-center justify-center gap-2 rounded-lg px-3 text-xs font-semibold whitespace-nowrap text-text-secondary transition-colors duration-(--duration-fast) outline-none hover:not-disabled:text-text-primary focus-visible:ring-3 focus-visible:ring-accent/40 disabled:opacity-50 aria-pressed:bg-bg-elevated aria-pressed:text-text-primary aria-pressed:shadow-card"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
