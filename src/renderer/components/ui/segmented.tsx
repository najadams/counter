import type { ReactNode } from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '../../lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
}

const segmentVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap text-text-secondary transition-colors duration-(--duration-fast) outline-none hover:not-disabled:text-text-primary focus-visible:ring-3 focus-visible:ring-accent/40 disabled:opacity-50 aria-pressed:bg-bg-elevated aria-pressed:text-text-primary aria-pressed:shadow-card',
  {
    variants: {
      size: {
        sm: 'min-h-7 px-2.5 text-xs',
        md: 'min-h-8 px-3 text-xs',
        /** Counter Friendly: big enough to tap without looking twice. */
        lg: 'min-h-12 px-4 text-base',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

/**
 * A small group of mutually exclusive buttons that switch a view or a mode
 * in place (Pending / History, Walk-in / Wholesale / Route, date presets).
 * Each is a real button with aria-pressed, so tests and screen readers see
 * the choice. `value` may be null when none applies (custom dates). For
 * whole sections of a screen, use NavTab; for panels with arrow-key
 * movement, Tabs.
 */
export function Segmented<T extends string>({ value, onChange, options, label, className, disabled, size, fill }: {
  value: T | null;
  onChange: (value: T) => void;
  options: ReadonlyArray<SegmentedOption<T>>;
  /** Names the group for screen readers. */
  label: string;
  className?: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  /** Stretch across the container, options sharing the width equally. */
  fill?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="segmented"
      className={cn('gap-1 rounded-xl border border-border bg-bg-surface p-1', fill ? 'flex w-full' : 'inline-flex', className)}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(segmentVariants({ size }), fill && 'flex-1')}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
