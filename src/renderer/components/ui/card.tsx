import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn';

// The Harbour card: a white surface just off the page, 12px corners, a
// hairline border and a soft shadow (none in high contrast).

export function Card({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="card"
      className={cn('flex flex-col gap-4 rounded-xl border border-border bg-bg-elevated py-5 text-text-primary shadow-card', className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn('grid auto-rows-min items-start gap-1 px-5 has-data-[slot=card-action]:grid-cols-[1fr_auto]', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentPropsWithoutRef<'h3'>) {
  return <h3 data-slot="card-title" className={cn('text-base leading-snug font-semibold', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentPropsWithoutRef<'p'>) {
  return <p data-slot="card-description" className={cn('text-sm text-text-secondary', className)} {...props} />;
}

export function CardAction({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="card-action" className={cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="card-content" className={cn('px-5', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="card-footer" className={cn('flex items-center gap-2 border-t border-border px-5 pt-4', className)} {...props} />;
}
