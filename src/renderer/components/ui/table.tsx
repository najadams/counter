import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn';

// Plain semantic table parts in the Harbour look. Money and quantity cells
// take `className="text-right font-mono tnum"` so columns line up.

export function Table({ className, scroll = true, ...props }: ComponentPropsWithoutRef<'table'> & {
  /**
   * Wrap the table in its own horizontal scroller (the default) so a wide
   * table scrolls instead of widening the page. Pass false when the table
   * sits in a panel that already scrolls and has a sticky header: the
   * wrapper would become the header's scroll container and it would stop
   * sticking.
   */
  scroll?: boolean;
}) {
  const table = <table data-slot="table" className={cn('w-full caption-bottom border-collapse text-sm', className)} {...props} />;
  return scroll
    ? <div data-slot="table-container" className="relative w-full overflow-x-auto">{table}</div>
    : table;
}

export function TableHeader({ className, ...props }: ComponentPropsWithoutRef<'thead'>) {
  return <thead data-slot="table-header" className={cn('bg-bg-deep/65 text-text-secondary', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentPropsWithoutRef<'tbody'>) {
  return <tbody data-slot="table-body" className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableFooter({ className, ...props }: ComponentPropsWithoutRef<'tfoot'>) {
  return <tfoot data-slot="table-footer" className={cn('border-t border-border bg-bg-surface font-semibold', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentPropsWithoutRef<'tr'>) {
  return (
    <tr
      data-slot="table-row"
      className={cn('border-b border-border-subtle transition-colors hover:bg-bg-surface/60 data-[state=selected]:bg-accent/10', className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentPropsWithoutRef<'th'>) {
  return (
    <th
      data-slot="table-head"
      className={cn('h-10 px-4 text-left text-xs font-bold tracking-wide whitespace-nowrap uppercase', className)}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: ComponentPropsWithoutRef<'td'>) {
  return <td data-slot="table-cell" className={cn('px-4 py-3 align-top', className)} {...props} />;
}

export function TableCaption({ className, ...props }: ComponentPropsWithoutRef<'caption'>) {
  return <caption data-slot="table-caption" className={cn('mt-3 text-sm text-text-secondary', className)} {...props} />;
}
