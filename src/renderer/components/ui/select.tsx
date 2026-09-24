import { Select as SelectPrimitive } from '@base-ui/react/select';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { cn } from '../../lib/cn';
import { fieldClasses } from './input';

export const Select = SelectPrimitive.Root;

export function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value data-slot="select-value" className={cn('flex-1 truncate text-left', className)} {...props} />;
}

export function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        fieldClasses,
        'flex h-10 items-center justify-between gap-2 px-3 text-sm whitespace-nowrap select-none data-placeholder:text-text-tertiary data-popup-open:border-accent [&_svg]:pointer-events-none [&_svg]:shrink-0',
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon render={<ChevronDownIcon className="size-4 text-text-secondary" aria-hidden="true" />} />
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'start',
  alignItemWithTrigger = false,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<SelectPrimitive.Positioner.Props, 'align' | 'side' | 'sideOffset' | 'alignItemWithTrigger'>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignItemWithTrigger={alignItemWithTrigger}
        className="z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(
            'max-h-(--available-height) w-(--anchor-width) min-w-40 origin-(--transform-origin) overflow-y-auto rounded-lg border border-border bg-bg-modal p-1 text-sm text-text-primary shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-fast) ease-(--ease-standard) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0',
            className,
          )}
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow className="flex h-6 items-center justify-center text-text-secondary">
            <ChevronUpIcon className="size-4" aria-hidden="true" />
          </SelectPrimitive.ScrollUpArrow>
          <SelectPrimitive.List>{children}</SelectPrimitive.List>
          <SelectPrimitive.ScrollDownArrow className="flex h-6 items-center justify-center text-text-secondary">
            <ChevronDownIcon className="size-4" aria-hidden="true" />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        'relative flex min-h-9 cursor-default items-center gap-2 rounded-md py-1.5 pr-8 pl-2.5 outline-none select-none data-disabled:opacity-50 data-highlighted:bg-accent/10',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex-1">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute right-2.5 flex items-center text-accent">
        <CheckIcon className="size-4" aria-hidden="true" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" className={cn('py-1', className)} {...props} />;
}

export function SelectLabel({ className, ...props }: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn('px-2.5 py-1 text-xs font-bold tracking-wide text-text-tertiary uppercase', className)}
      {...props}
    />
  );
}

export function SelectSeparator({ className, ...props }: SelectPrimitive.Separator.Props) {
  return <SelectPrimitive.Separator data-slot="select-separator" className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}
