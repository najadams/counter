import type { BadgeTone } from '../components/ui/badge';

/** Void and stock-receipt requests: PENDING, APPROVED, DECLINED, WITHDRAWN. */
export function reviewStatusTone(status: string): BadgeTone {
  if (status === 'PENDING') return 'warning';
  if (status === 'APPROVED') return 'success';
  if (status === 'DECLINED') return 'danger';
  return 'neutral';
}

/** Intelligence findings: CRITICAL, HIGH, and everything calmer. */
export function severityTone(severity: string): BadgeTone {
  if (severity === 'CRITICAL') return 'danger';
  if (severity === 'HIGH') return 'warning';
  return 'neutral';
}
