import { z } from 'zod';
import { guestSummaryDto } from './guests';
import { nightlyRate } from './rooms';

// ---------------------------------------------------------------------------------------------------------------
// Business dates. Stays are half-open [arrival, departure) on the property's business dates (decision P2-1).
// ---------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

export const businessDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-19.')
  // An impossible date (2026-13-01) is an Invalid Date, whose toISOString() would throw: check it first.
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, 'Enter a real date.');

function toUtc(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

export function addDays(date: string, days: number): string {
  return new Date(toUtc(date) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Number of nights in [arrival, departure). */
export function nightsBetween(arrival: string, departure: string): number {
  // Both are UTC midnights (no DST in UTC), so the difference is an exact multiple of a day.
  return (toUtc(departure) - toUtc(arrival)) / DAY_MS;
}

/** Each night of the stay, as the date the night starts. */
export function stayNights(arrival: string, departure: string): string[] {
  return Array.from({ length: Math.max(0, nightsBetween(arrival, departure)) }, (_, i) =>
    addDays(arrival, i),
  );
}

/** Two half-open stays overlap when each starts before the other ends; same-day turnover does not overlap. */
export function staysOverlap(
  a: { arrival: string; departure: string },
  b: { arrival: string; departure: string },
): boolean {
  return a.arrival < b.departure && b.arrival < a.departure;
}

export const MAX_STAY_NIGHTS = 60;
export const BOOKING_HORIZON_DAYS = 730;

/** Readable, unambiguous booking codes (no 0/O, 1/I/L). Not a fiscal document number, so gaps are fine. */
export const BOOKING_REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const BOOKING_REFERENCE_LENGTH = 8;

// ---------------------------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------------------------

export const RESERVATION_SOURCES = ['walk_in', 'phone', 'email', 'website', 'agent', 'ota', 'other'] as const;
export const RESERVATION_STATUSES = [
  'pending',
  'confirmed',
  'checked_in',
  'checked_out',
  'cancelled',
  'no_show',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
/** Statuses that hold rooms. */
export const ACTIVE_RESERVATION_STATUSES: readonly ReservationStatus[] = [
  'pending',
  'confirmed',
  'checked_in',
];

export const reservationRoomInput = z
  .object({
    roomTypeId: z.string().uuid(),
    /** Optional at booking time; can be assigned later. */
    roomId: z.string().uuid().nullable().optional(),
    arrival: businessDate,
    departure: businessDate,
    adults: z.coerce.number().int().min(1).max(20),
    children: z.coerce.number().int().min(0).max(20).default(0),
    /** Leave out to use the room type's rate on the arrival date. Overriding needs reservation.rate_override. */
    nightlyRate: nightlyRate.optional(),
    rateOverrideReason: z.string().trim().min(3).max(300).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const nights = nightsBetween(v.arrival, v.departure);
    if (nights < 1)
      ctx.addIssue({ code: 'custom', path: ['departure'], message: 'Departure must be after arrival.' });
    else if (nights > MAX_STAY_NIGHTS) {
      ctx.addIssue({
        code: 'custom',
        path: ['departure'],
        message: `A stay can be at most ${MAX_STAY_NIGHTS} nights.`,
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
export type ReservationRoomInput = z.infer<typeof reservationRoomInput>;

export const createReservationRequest = z
  .object({
    guestId: z.string().uuid(),
    source: z.enum(RESERVATION_SOURCES),
    /** Tentative bookings start as pending; most are confirmed straight away. */
    status: z.enum(['pending', 'confirmed']).default('confirmed'),
    notes: z.string().trim().max(2000).optional(),
    rooms: z.array(reservationRoomInput).min(1, 'Add at least one room.').max(20),
  })
  .strict();
export type CreateReservationRequest = z.infer<typeof createReservationRequest>;

export const updateReservationRequest = z
  .object({
    source: z.enum(RESERVATION_SOURCES).optional(),
    notes: z
      .string()
      .trim()
      .max(2000)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateReservationRequest = z.infer<typeof updateReservationRequest>;

export const cancelReservationRequest = z
  .object({
    reason: z.string().trim().min(3, 'Give a reason for cancelling.').max(500),
    /** Required when the booking holds a deposit: refund it, or keep it as a fee. */
    deposit: z.enum(['refund', 'forfeit']).optional(),
  })
  .strict();
export type CancelReservationRequest = z.infer<typeof cancelReservationRequest>;

export const noShowRequest = z
  .object({
    reason: z.string().trim().max(500).optional(),
    /** Required when the booking holds a deposit: refund it, or keep it as a fee. */
    deposit: z.enum(['refund', 'forfeit']).optional(),
  })
  .strict();
export type NoShowRequest = z.infer<typeof noShowRequest>;

export const assignRoomRequest = z.object({ roomId: z.string().uuid().nullable() }).strict();
export type AssignRoomRequest = z.infer<typeof assignRoomRequest>;

/** Plain object form, for documentation; validate with `availabilityQuery`. */
export const availabilityQueryObject = z.object({ arrival: businessDate, departure: businessDate });
export const availabilityQuery = availabilityQueryObject.superRefine((v, ctx) => {
  const nights = nightsBetween(v.arrival, v.departure);
  if (nights < 1 || nights > MAX_STAY_NIGHTS) {
    ctx.addIssue({ code: 'custom', path: ['departure'], message: `Choose 1–${MAX_STAY_NIGHTS} nights.` });
  }
});
export type AvailabilityQuery = z.infer<typeof availabilityQuery>;

/** Plain object form, for documentation; validate with `reservationListQuery`. */
export const reservationListQueryObject = z.object({
  /** Stays overlapping [from, to). */
  from: businessDate.optional(),
  to: businessDate.optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const reservationListQuery = reservationListQueryObject.superRefine((v, ctx) => {
  if (v.from && v.to && nightsBetween(v.from, v.to) > 120) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'Choose at most 120 days.' });
  }
});
export type ReservationListQuery = z.infer<typeof reservationListQuery>;

// ---------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------

export const availabilityDto = z.object({
  arrival: z.string(),
  departure: z.string(),
  nights: z.number().int(),
  roomTypes: z.array(
    z.object({
      roomTypeId: z.string().uuid(),
      code: z.string(),
      name: z.string(),
      capacityAdults: z.number().int(),
      capacityChildren: z.number().int(),
      /** Rooms of this type still sellable on every night of the range. */
      available: z.number().int(),
      /** Specific rooms with no assigned booking in the range. */
      freeRooms: z.array(z.object({ id: z.string().uuid(), roomNumber: z.string() })),
      /** Rate in effect on the arrival date, or null if none is set. */
      nightlyRate: z.string().nullable(),
      currencyCode: z.string(),
    }),
  ),
});
export type AvailabilityDto = z.infer<typeof availabilityDto>;

export const reservationRoomDto = z.object({
  id: z.string().uuid(),
  roomTypeId: z.string().uuid(),
  roomTypeCode: z.string(),
  roomId: z.string().uuid().nullable(),
  roomNumber: z.string().nullable(),
  arrival: z.string(),
  departure: z.string(),
  nights: z.number().int(),
  adults: z.number().int(),
  children: z.number().int(),
  nightlyRate: z.string(),
  currencyCode: z.string(),
  rateOverridden: z.boolean(),
  /** nights × nightly rate, before taxes and extras (those come with folios). */
  roomTotal: z.string(),
  status: z.enum(['active', 'released']),
  /** Set once the guest is checked in to this booked room. */
  stayId: z.string().uuid().nullable(),
});
export type ReservationRoomDto = z.infer<typeof reservationRoomDto>;

export const reservationDto = z.object({
  id: z.string().uuid(),
  bookingReference: z.string(),
  status: z.enum(RESERVATION_STATUSES),
  source: z.enum(RESERVATION_SOURCES),
  notes: z.string().nullable(),
  guest: guestSummaryDto,
  rooms: z.array(reservationRoomDto),
  arrival: z.string(),
  departure: z.string(),
  createdAt: z.string().datetime(),
  cancelReason: z.string().nullable(),
});
export type ReservationDto = z.infer<typeof reservationDto>;
