import { z } from 'zod';
import { businessDate } from './reservations';

/**
 * Interim business-date close (Phase 2 slice 2.7, decision D3). Operational checks only: no money is posted. The
 * full night audit (room charge posting) replaces it in Phase 4.
 */
export const DAY_CLOSE_CHECKS = ['arrivals_pending', 'overstays', 'rooms_not_clean', 'open_tasks'] as const;
export type DayCloseCheck = (typeof DAY_CLOSE_CHECKS)[number];

export const dayCloseIssueDto = z.object({
  check: z.enum(DAY_CLOSE_CHECKS),
  /** Short label of the item, e.g. a booking reference or room number. */
  label: z.string(),
  detail: z.string().nullable(),
  reservationId: z.string().uuid().nullable(),
  roomId: z.string().uuid().nullable(),
});
export type DayCloseIssueDto = z.infer<typeof dayCloseIssueDto>;

export const roomServiceChangeDto = z.object({
  roomId: z.string().uuid(),
  roomNumber: z.string(),
  to: z.enum(['in_service', 'out_of_order']),
});

export const dayClosePreviewDto = z.object({
  businessDate: z.string(),
  nextDate: z.string(),
  issues: z.array(dayCloseIssueDto),
  /** Out-of-order periods that start or end on the next date. */
  serviceChanges: z.array(roomServiceChangeDto),
  counts: z.object({
    inHouse: z.number().int(),
    arrivalsCheckedIn: z.number().int(),
    arrivalsPending: z.number().int(),
    sellableRooms: z.number().int(),
  }),
});
export type DayClosePreviewDto = z.infer<typeof dayClosePreviewDto>;

export const dayCloseRequest = z
  .object({
    /** The date the user saw; guards against closing twice from two screens. */
    businessDate,
    /** Mark every arrival still not checked in as a no-show as part of the close. */
    markNoShows: z.boolean().default(false),
    /** Required when anything is still unresolved; recorded with the close. */
    reason: z.string().trim().min(3, 'Explain why the day is closed with open items.').max(500).optional(),
  })
  .strict();
export type DayCloseRequest = z.infer<typeof dayCloseRequest>;

export const dayCloseDto = z.object({
  id: z.string().uuid(),
  businessDate: z.string(),
  nextDate: z.string(),
  closedAt: z.string().datetime(),
  closedByName: z.string().nullable(),
  noShowsMarked: z.number().int(),
  unresolved: z.array(dayCloseIssueDto),
  reason: z.string().nullable(),
  snapshot: z.object({
    inHouse: z.number().int(),
    arrivalsCheckedIn: z.number().int(),
    sellableRooms: z.number().int(),
  }),
});
export type DayCloseDto = z.infer<typeof dayCloseDto>;
