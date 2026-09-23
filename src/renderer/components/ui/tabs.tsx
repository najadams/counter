import { Tabs as TabsPrimitive } from '@base-ui/react/tabs';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

// Two looks: `segmented` (a pill group, for switching a view in place — price
// type, date range) and `line` (an underlined row, for sections of a screen —
// report tabs). Arrow keys move between tabs; Base UI handles that.

export function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn('flex flex-col gap-3', className)} {...props} />;
}

const tabsListVariants = cva('relative inline-flex items-center', {
  variants: {
    variant: {
      segmented: 'gap-1 rounded-xl border border-border bg-bg-surface p-1',
      line: 'gap-1 border-b border-border',
    },
  },
  defaultVariants: { variant: 'segmented' },
});

export function TabsList({ className, variant = 'segmented', ...props }: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={cn('group/tabs-list', tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        'inline-flex min-h-9 items-center justify-center gap-2 px-3 text-sm font-semibold whitespace-nowrap text-text-secondary transition-colors duration-(--duration-fast) outline-none hover:text-text-primary focus-visible:ring-3 focus-visible:ring-accent/40 data-disabled:opacity-50',
        // segmented: the active tab is a raised pill
        'group-data-[variant=segmented]/tabs-list:rounded-lg group-data-[variant=segmented]/tabs-list:data-active:bg-bg-elevated group-data-[variant=segmented]/tabs-list:data-active:text-text-primary group-data-[variant=segmented]/tabs-list:data-active:shadow-card',
        // line: the active tab is underlined in the accent
        'group-data-[variant=line]/tabs-list:-mb-px group-data-[variant=line]/tabs-list:border-b-2 group-data-[variant=line]/tabs-list:border-transparent group-data-[variant=line]/tabs-list:data-active:border-accent group-data-[variant=line]/tabs-list:data-active:text-text-primary',
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return <TabsPrimitive.Panel data-slot="tabs-content" className={cn('outline-none', className)} {...props} />;
}
