// The shape of a report while its numbers load: a row of stat cards over a
// table. It holds the layout still, so the page doesn't jump when the data
// lands, and says what's happening to screen readers.

import { Card } from './ui/card';
import { Skeleton } from './ui/skeleton';

export function ReportSkeleton({ label = 'Loading…', stats = 4, rows = 6 }: {
  /** Announced to screen readers; the same words the report used to show. */
  label?: string;
  stats?: number;
  rows?: number;
}) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-4">
      <span className="sr-only">{label}</span>
      {stats > 0 && (
        <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
          {Array.from({ length: stats }, (_, i) => (
            <Card key={i} className="gap-2 p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-6 w-28" />
            </Card>
          ))}
        </div>
      )}
      <Card className="gap-3 p-4">
        <Skeleton className="h-4 w-40" />
        {Array.from({ length: rows }, (_, i) => (
          <Skeleton key={i} className="h-4" style={{ width: `${92 - ((i * 17) % 30)}%` }} />
        ))}
      </Card>
    </div>
  );
}
