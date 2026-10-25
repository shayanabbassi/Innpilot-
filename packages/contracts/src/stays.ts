import { z } from 'zod';
import { createGuestRequest, guestSummaryDto } from './guests';
import { nightlyRate } from './rooms';
import { businessDate, RESERVATION_STATUSES } from './reservations';

/**
 * Why a room cannot take a guest right now (decision P2-10). `occupied` can never be overridden;
 * the others can, by a holder of stay.readiness_override with a reason.
 */
export const READINESS_PROBLEMS = ['occupied', 'out_of_order', 'dirty', 'cleaning', 'inactive'] as const;
export type ReadinessProblem = (typeof READINESS_PROBLEMS)[number];
export const OVERRIDABLE_PROBLEMS: readonly ReadinessProblem[] = ['out_of_order', 'dirty', 'cleaning'];

export function readinessProblem(room: {
  active: boolean;
  serviceState: 'in_service' | 'out_of_order';
  housekeepingState: 'dirty' | 'cleaning' | 'clean' | 'inspected';
  occupied: boolean;
}): ReadinessProblem | null {
  if (!room.active) return 'inactive';
  if (room.occupied) return 'occupied';
  if (room.serviceState === 'out_of_order') return 'out_of_order';
  if (room.housekeepingState === 'dirty') return 'dirty';
  if (room.housekeepingState === 'cleaning') return 'cleaning';
  return null;
}

const overrideReason = z.string().trim().min(3, 'Give a reason for using a room that is not ready.').max(300);

export const checkInRequest = z
  .object({
    /** Needed when the booked room has no room assigned yet. */
    roomId: z.string().uuid().optional(),
    /** Only for rooms that are dirty, being cleaned or out of order; needs stay.readiness_override. */
    readinessOverrideReason: overrideReason.optional(),
  })
  .strict();
export type CheckInRequest = z.infer<typeof checkInRequest>;

export const walkInRequest = z
  .object({
    guestId: z.string().uuid().optional(),
    /** Minimal new guest when there is no existing profile. */
    guest: createGuestRequest.optional(),
    roomId: z.string().uuid(),
    departure: businessDate,
    adults: z.coerce.number().int().min(1).max(20),
    children: z.coerce.number().int().min(0).max(20).default(0),
    nightlyRate: nightlyRate.optional(),
    rateOverrideReason: z.string().trim().min(3).max(300).optional(),
    readinessOverrideReason: overrideReason.optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.guestId === !v.guest) {
      ctx.addIssue({
        code: 'custom',
        path: ['guestId'],
        message: 'Choose an existing guest or enter a new one.',
      });
    }
    if (v.nightlyRate && !v.rateOverrideReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['rateOverrideReason'],
        message: 'Give a reason for changing the rate.',
      });
    }
  });
export type WalkInRequest = z.infer<typeof walkInRequest>;

export const moveRoomRequest = z
  .object({
    roomId: z.string().uuid(),
    reason: z.string().trim().min(3, 'Give a reason for the move.').max(300),
    readinessOverrideReason: overrideReason.optional(),
  })
  .strict();
export type MoveRoomRequest = z.infer<typeof moveRoomRequest>;

// ---------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------

export const staySegmentDto = z.object({
  roomId: z.string().uuid(),
  roomNumber: z.string(),
  fromDate: z.string(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  reason: z.string().nullable(),
});

export const stayDto = z.object({
  id: z.string().uuid(),
  reservationId: z.string().uuid(),
  bookingReference: z.string(),
  status: z.enum(['in_house', 'checked_out']),
  guest: guestSummaryDto,
  roomId: z.string().uuid(),
  roomNumber: z.string(),
  roomTypeCode: z.string(),
  arrival: z.string(),
  departure: z.string(),
  adults: z.number().int(),
  children: z.number().int(),
  checkedInAt: z.string().datetime(),
  segments: z.array(staySegmentDto),
});
export type StayDto = z.infer<typeof stayDto>;

export const arrivalDto = z.object({
  reservationId: z.string().uuid(),
  reservationRoomId: z.string().uuid(),
  bookingReference: z.string(),
  reservationStatus: z.enum(RESERVATION_STATUSES),
  guest: guestSummaryDto,
  roomTypeId: z.string().uuid(),
  roomTypeCode: z.string(),
  roomId: z.string().uuid().nullable(),
  roomNumber: z.string().nullable(),
  arrival: z.string(),
  departure: z.string(),
  adults: z.number().int(),
  children: z.number().int(),
  /** null when ready (or no room assigned yet). */
  readiness: z.enum(READINESS_PROBLEMS).nullable(),
});
export type ArrivalDto = z.infer<typeof arrivalDto>;

export const frontDeskTodayDto = z.object({
  businessDate: z.string(),
  arrivals: z.array(arrivalDto),
  inHouse: z.array(stayDto),
  /** In-house stays due out today or already past their departure date. */
  departures: z.array(stayDto),
});
export type FrontDeskTodayDto = z.infer<typeof frontDeskTodayDto>;
