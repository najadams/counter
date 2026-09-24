import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

/**
 * A visible label around one form control, with an optional hint below.
 * Wrapping the control in the <label> names it without ids.
 */
export function Field({ label, hint, className, children }: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label data-slot="field" className={cn('flex flex-col gap-1.5 text-sm', className)}>
      <span className="text-text-secondary">{label}</span>
      {children}
      {hint && <span className="text-xs text-text-tertiary">{hint}</span>}
    </label>
  );
}
