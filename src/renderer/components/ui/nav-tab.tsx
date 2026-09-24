import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn';

/**
 * One tab in a row of section tabs across the top of a screen (Settings,
 * Reports, a customer's record). The screen owns which section shows; the
 * current one is marked with aria-current and an accent underline, like
 * Tabs' `line` look. Put them in a flex row with `border-b border-border`.
 */
export function NavTab({ active, className, ...props }: ComponentPropsWithoutRef<'button'> & { active: boolean }) {
  return (
    <button
      type="button"
      data-slot="nav-tab"
      aria-current={active ? 'true' : undefined}
      className={cn(
        '-mb-px inline-flex min-h-10 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-semibold whitespace-nowrap transition-colors duration-(--duration-fast) outline-none focus-visible:ring-3 focus-visible:ring-accent/40',
        active ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary',
        className,
      )}
      {...props}
    />
  );
}
