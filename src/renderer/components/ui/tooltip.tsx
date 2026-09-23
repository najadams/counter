import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cn } from '../../lib/cn';

// A tooltip explains; it never holds the only copy of something a cashier
// needs (touch screens cannot hover). Wrap the app once in TooltipProvider.

export function TooltipProvider({ delay = 400, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider delay={delay} {...props} />;
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({
  className, side = 'top', sideOffset = 6, align = 'center', children, ...props
}: TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} className="z-50">
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'max-w-xs origin-(--transform-origin) rounded-md bg-text-primary px-2.5 py-1.5 text-xs text-bg-elevated shadow-overlay transition-[opacity,scale] duration-(--duration-fast) data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:opacity-0',
            className,
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}
