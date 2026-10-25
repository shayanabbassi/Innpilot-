import { z } from 'zod';

/**
 * Room status is three independent facts (Phase 2 plan P2-2). Only housekeeping and service state are
 * stored on the room; occupancy comes from stays, and the board label is derived from all three.
 */
export const HOUSEKEEPING_STATES = ['dirty', 'cleaning', 'clean', 'inspected'] as const;
export type HousekeepingState = (typeof HOUSEKEEPING_STATES)[number];
export const SERVICE_STATES = ['in_service', 'out_of_order'] as const;
export type ServiceState = (typeof SERVICE_STATES)[number];

export const BOARD_STATES = [
  'vacant_ready',
  'vacant_dirty',
  'cleaning',
  'occupied',
  'out_of_order',
  'inactive',
] as const;
export type BoardState = (typeof BOARD_STATES)[number];

/** The room board label. `occupied` is passed in by the caller once stays exist (slice 2.5). */
export function boardState(room: {
  active: boolean;
  serviceState: ServiceState;
  housekeepingState: HousekeepingState;
  occupied?: boolean;
}): BoardState {
  if (!room.active) return 'inactive';
  if (room.serviceState === 'out_of_order') return 'out_of_order';
  if (room.occupied) return 'occupied';
  if (room.housekeepingState === 'cleaning') return 'cleaning';
  if (room.housekeepingState === 'dirty') return 'vacant_dirty';
  return 'vacant_ready';
}

/**
 * A nightly rate as entered by staff: positive, at most 2 decimal places (PKR has paisa), as a string.
 * Never a JavaScript number.
 */
export const nightlyRate = z
  .string()
  .trim()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, 'Enter an amount such as 4999 or 4999.50 (at most 2 decimal places).')
  .refine((v) => /[1-9]/.test(v), 'The rate must be more than zero.');

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-19.')
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v),
    'Enter a real date.',
  );

const roomTypeCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,11}$/, 'Use up to 12 letters, digits or hyphens, e.g. DLX or STD-K.');

export const roomNumber = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,9}$/, 'Use up to 10 letters, digits or hyphens, e.g. 101 or A-12.');

const capacity = (min: number) => z.coerce.number().int().min(min).max(20);

// ---------------------------------------------------------------------------------------------------------------
// Room types and rates
// ---------------------------------------------------------------------------------------------------------------

export const roomTypeRateDto = z.object({
  id: z.string().uuid(),
  effectiveFrom: z.string(),
  nightlyRate: z.string(),
  currencyCode: z.string(),
  createdAt: z.string().datetime(),
});
export type RoomTypeRateDto = z.infer<typeof roomTypeRateDto>;

export const roomTypeDto = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  capacityAdults: z.number().int(),
  capacityChildren: z.number().int(),
  active: z.boolean(),
  sortOrder: z.number().int(),
  roomCount: z.number().int(),
  /** Rate in effect on the property's business date; null if none yet. */
  currentRate: roomTypeRateDto.nullable(),
});
export type RoomTypeDto = z.infer<typeof roomTypeDto>;

export const createRoomTypeRequest = z
  .object({
    code: roomTypeCode,
    name: z.string().trim().min(1, 'Enter the room type name.').max(100),
    description: z.string().trim().max(500).optional(),
    capacityAdults: capacity(1),
    capacityChildren: capacity(0),
    /** Optional first rate, effective from the business date. */
    nightlyRate: nightlyRate.optional(),
  })
  .strict();
export type CreateRoomTypeRequest = z.infer<typeof createRoomTypeRequest>;

export const updateRoomTypeRequest = z
  .object({
    name: z.string().trim().min(1, 'Enter the room type name.').max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    capacityAdults: capacity(1).optional(),
    capacityChildren: capacity(0).optional(),
    active: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).max(1000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateRoomTypeRequest = z.infer<typeof updateRoomTypeRequest>;

export const createRateRequest = z
  .object({
    /** Defaults to the business date. Past dates are refused so history cannot be rewritten. */
    effectiveFrom: isoDate.optional(),
    nightlyRate,
  })
  .strict();
export type CreateRateRequest = z.infer<typeof createRateRequest>;

// ---------------------------------------------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------------------------------------------

export const roomDto = z.object({
  id: z.string().uuid(),
  roomNumber: z.string(),
  floor: z.string().nullable(),
  roomTypeId: z.string().uuid(),
  roomTypeCode: z.string(),
  housekeepingState: z.enum(HOUSEKEEPING_STATES),
  serviceState: z.enum(SERVICE_STATES),
  active: z.boolean(),
});
export type RoomDto = z.infer<typeof roomDto>;

const floor = z.string().trim().max(10).optional();

export const createRoomRequest = z.object({ roomNumber, floor, roomTypeId: z.string().uuid() }).strict();
export type CreateRoomRequest = z.infer<typeof createRoomRequest>;

export const MAX_BULK_ROOMS = 200;

export const bulkCreateRoomsRequest = z
  .object({
    /** Numeric range, e.g. "101" to "120". Leading zeros in `from` set the width ("01" → 01, 02 …). */
    from: z
      .string()
      .trim()
      .regex(/^\d{1,6}$/, 'Use digits only, e.g. 101.'),
    to: z
      .string()
      .trim()
      .regex(/^\d{1,6}$/, 'Use digits only, e.g. 120.'),
    prefix: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{0,4}$/, 'Use up to 4 letters, digits or hyphens.')
      .optional(),
    floor,
    roomTypeId: z.string().uuid(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const count = Number(v.to) - Number(v.from) + 1;
    if (count < 1)
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'Must not be less than the first number.' });
    else if (count > MAX_BULK_ROOMS) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: `At most ${MAX_BULK_ROOMS} rooms at a time.` });
    } else if (expandRoomRange(v).some((n) => !roomNumber.safeParse(n).success)) {
      ctx.addIssue({
        code: 'custom',
        path: ['prefix'],
        message: 'The resulting room numbers would not be valid (they must start with a letter or digit).',
      });
    }
  });
export type BulkCreateRoomsRequest = z.infer<typeof bulkCreateRoomsRequest>;

/** The room numbers a bulk request produces, in order. */
export function expandRoomRange(v: { from: string; to: string; prefix?: string | undefined }): string[] {
  const start = Number(v.from);
  const end = Number(v.to);
  const width = v.from.startsWith('0') ? v.from.length : 0;
  const out: string[] = [];
  for (let n = start; n <= end && out.length <= MAX_BULK_ROOMS; n++) {
    out.push(`${v.prefix ?? ''}${String(n).padStart(width, '0')}`);
  }
  return out;
}

export const updateRoomRequest = z
  .object({
    roomNumber: roomNumber.optional(),
    floor: z.string().trim().max(10).nullable().optional(),
    roomTypeId: z.string().uuid().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateRoomRequest = z.infer<typeof updateRoomRequest>;

// ---------------------------------------------------------------------------------------------------------------
// Room board
// ---------------------------------------------------------------------------------------------------------------

export const roomBoardDto = z.object({
  businessDate: z.string(),
  rooms: z.array(roomDto.extend({ roomTypeName: z.string(), boardState: z.enum(BOARD_STATES) })),
  counts: z.partialRecord(z.enum(BOARD_STATES), z.number().int()),
});
export type RoomBoardDto = z.infer<typeof roomBoardDto>;
