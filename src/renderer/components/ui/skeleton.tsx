import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn';

/** A placeholder block while data loads. Its pulse stops under reduced motion. */
export function Skeleton({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="skeleton" aria-hidden="true" className={cn('animate-pulse rounded bg-bg-surface', className)} {...props} />;
}
