import { z } from 'zod';
import { businessDate } from './reservations';

/**
 * The night audit (Phase 4 slice 4.5, P4-9), which replaced the interim day close of Phase 2 (D3). It checks the
 * day, marks no-shows with a decision on any deposit they hold, accrues the night's room revenue (D9), stores a
 * summary and advances the business date by exactly one day — once per date (OPS-004).
 */
export const DAY_CLOSE_CHECKS = [
  'arrivals_pending',
  'overstays',
  'rooms_not_clean',
  'open_tasks',
  'open_shifts',
] as const;
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

/** An arrival still due that holds a deposit: marking it a no-show needs a decision (refund later, or keep as fee). */
export const noShowDepositDto = z.object({
  reservationId: z.string().uuid(),
  bookingReference: z.string(),
  guestName: z.string(),
  held: z.string(),
});
export type NoShowDepositDto = z.infer<typeof noShowDepositDto>;

/** What the night audit stores about the day; totals come from the ledger and the source records. */
export const nightAuditSummaryDto = z.object({
  /** Revenue posted on the date, by account (credit minus debit), accruals included. */
  revenue: z.array(z.object({ accountCode: z.string(), accountName: z.string(), amount: z.string() })),
  revenueTotal: z.string(),
  accrued: z.object({ nights: z.number().int(), net: z.string() }),
  occupancy: z.object({ occupied: z.number().int(), sellable: z.number().int(), percent: z.string() }),
  arrivals: z.number().int(),
  departures: z.number().int(),
  inHouse: z.number().int(),
  /** Money received on the date by method, and refunds paid. */
  receipts: z.array(z.object({ method: z.string(), amount: z.string() })),
  refunds: z.string(),
  cashierVariances: z.array(
    z.object({ drawer: z.string(), cashier: z.string(), variance: z.string(), status: z.string() }),
  ),
  /** Cash moved on a drawer with no shift open (D11): listed so it is never invisible. */
  cashOutsideShift: z.object({ lines: z.number().int(), in: z.string(), out: z.string() }),
  foliosOnAccount: z.object({ count: z.number().int(), balance: z.string() }),
  /** Deposits of cancelled or no-show bookings still held, waiting to be refunded. */
  depositsToRefund: z.object({ count: z.number().int(), amount: z.string() }),
});
export type NightAuditSummaryDto = z.infer<typeof nightAuditSummaryDto>;

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
  /** Arrivals that would become no-shows while holding a deposit. */
  noShowDeposits: z.array(noShowDepositDto),
  /** Room nights the audit will accrue (D9). */
  accruals: z.object({ nights: z.number().int(), net: z.string() }),
  /** The summary as it stands now (accruals not yet posted). */
  summary: nightAuditSummaryDto,
});
export type DayClosePreviewDto = z.infer<typeof dayClosePreviewDto>;

export const dayCloseRequest = z
  .object({
    /** The date the user saw; guards against closing twice from two screens. */
    businessDate,
    /** Mark every arrival still not checked in as a no-show as part of the close. */
    markNoShows: z.boolean().default(false),
    /** For each no-show holding a deposit: refund it later, or keep it as a fee (needs folio.adjust). */
    deposits: z.record(z.string().uuid(), z.enum(['refund', 'forfeit'])).default({}),
    /** Required when anything is still unresolved (an override); recorded with the close. */
    reason: z.string().trim().min(3, 'Explain why the day is closed with open items.').max(500).optional(),
  })
  .strict();
export type DayCloseRequest = z.infer<typeof dayCloseRequest>;

export const dayCloseDto = z.object({
  id: z.string().uuid(),
  /** day_close: an interim close from before the night audit. */
  kind: z.enum(['day_close', 'night_audit']),
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
  /** Null for interim closes. */
  summary: nightAuditSummaryDto.nullable(),
});
export type DayCloseDto = z.infer<typeof dayCloseDto>;
