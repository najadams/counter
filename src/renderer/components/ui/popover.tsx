import { Popover as PopoverPrimitive } from '@base-ui/react/popover';
import { cn } from '../../lib/cn';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverClose = PopoverPrimitive.Close;

export function PopoverContent({
  className, side = 'bottom', sideOffset = 6, align = 'center', children, ...props
}: PopoverPrimitive.Popup.Props & Pick<PopoverPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align'>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} className="z-50">
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            'flex w-72 origin-(--transform-origin) flex-col gap-3 rounded-lg border border-border bg-bg-modal p-4 text-sm text-text-primary shadow-overlay outline-none transition-[opacity,scale] duration-(--duration-fast) ease-(--ease-standard) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return <PopoverPrimitive.Title data-slot="popover-title" className={cn('font-semibold', className)} {...props} />;
}

export function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return <PopoverPrimitive.Description data-slot="popover-description" className={cn('text-text-secondary', className)} {...props} />;
}
