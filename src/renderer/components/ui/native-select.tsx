import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn';
import { fieldClasses } from './input';

/**
 * The browser's own <select>, dressed like the other fields. Prefer it for
 * short fixed lists in forms: it keeps native keyboard behaviour (type to
 * jump, arrows to change without opening) that cashiers already rely on.
 * Use Select for lists that need rich items or custom rendering.
 */
export const NativeSelect = forwardRef<HTMLSelectElement, ComponentPropsWithoutRef<'select'>>(function NativeSelect(
  { className, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      data-slot="native-select"
      className={cn(fieldClasses, 'h-10 px-3 text-sm', className)}
      {...props}
    />
  );
});
