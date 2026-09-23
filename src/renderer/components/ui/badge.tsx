import type { ComponentPropsWithoutRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

// A status pill. The tone carries the meaning — pending is `warning`,
// approved `success`, declined or voided `danger` — and the label says it in
// words, so colour is never the only signal.
export const badgeVariants = cva(
  'inline-flex h-6 w-fit shrink-0 items-center gap-1 rounded-full border px-2.5 text-xs font-bold tracking-wide whitespace-nowrap capitalize [&>svg]:size-3.5',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-bg-elevated text-text-secondary',
        accent: 'border-accent/35 bg-accent/10 text-accent',
        success: 'border-success/32 bg-success/12 text-success',
        warning: 'border-warning/35 bg-warning/13 text-warning',
        danger: 'border-danger/32 bg-danger/11 text-danger',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({ className, tone, ...props }: ComponentPropsWithoutRef<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}
