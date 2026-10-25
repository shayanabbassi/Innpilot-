import type { ReservationStatus } from '@innpilot/contracts';

export const STATUS_TONE: Record<ReservationStatus, 'success' | 'neutral' | 'danger' | 'warning'> = {
  pending: 'warning',
  confirmed: 'success',
  checked_in: 'neutral',
  checked_out: 'neutral',
  cancelled: 'danger',
  no_show: 'danger',
};
