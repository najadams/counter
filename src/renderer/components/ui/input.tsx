import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { cn } from '../../lib/cn';

/** Shared by Input, Textarea and the Select trigger so every field matches. */
export const fieldClasses =
  'w-full min-w-0 rounded border border-border-strong bg-bg-input text-text-primary transition-[border-color,box-shadow] duration-(--duration-fast) ease-(--ease-standard) outline-none placeholder:text-text-tertiary focus:border-accent focus:ring-3 focus:ring-accent/20 disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20';

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<'input'>>(function Input(
  { className, type = 'text', ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(fieldClasses, 'h-10 px-3 text-sm file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-semibold file:text-text-primary', className)}
      {...props}
    />
  );
});
