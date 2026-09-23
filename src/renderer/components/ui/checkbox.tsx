import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { CheckIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

/**
 * 20px box: large enough to hit on a touch till, with a teal fill when
 * checked. Pair it with a <label> (wrapping it, or htmlFor on its id).
 */
export function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'peer inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] border border-border-strong bg-bg-input text-ink transition-colors duration-(--duration-fast) outline-none focus-visible:ring-3 focus-visible:ring-accent/40 data-checked:border-accent data-checked:bg-accent data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-danger',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center">
        <CheckIcon className="size-3.5" strokeWidth={3} aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
