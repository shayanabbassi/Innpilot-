import { z } from 'zod';
import { uuid } from './common';
import { lineAmount } from './finance';
import { businessDate } from './reservations';

// ------------------------------------------------------------------------------------------------ requests

/** Opens a shift on a cash drawer with the cash counted into it (P4-4). Shifts are optional (D11). */
export const openShiftRequest = z
  .object({
    cashAccountId: uuid,
    openingCount: lineAmount,
  })
  .strict();
export type OpenShiftRequest = z.infer<typeof openShiftRequest>;

/** The cash counted at the end of the shift. Any variance needs an explanation (CASH-001). */
export const submitClosingRequest = z
  .object({
    countedAmount: lineAmount,
    explanation: z.string().trim().max(1000).optional(),
  })
  .strict();
export type SubmitClosingRequest = z.infer<typeof submitClosingRequest>;

export const approveClosingRequest = z.object({ note: z.string().trim().max(500).optional() }).strict();
export type ApproveClosingRequest = z.infer<typeof approveClosingRequest>;

export const reopenClosingRequest = z
  .object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500) })
  .strict();
export type ReopenClosingRequest = z.infer<typeof reopenClosingRequest>;

export const SHIFT_FILTERS = ['open', 'awaiting_approval', 'closed', 'all'] as const;
export type ShiftFilter = (typeof SHIFT_FILTERS)[number];

export const shiftListQueryObject = z.object({
  status: z.enum(SHIFT_FILTERS).default('all'),
  from: businessDate.optional(),
  to: businessDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const shiftListQuery = shiftListQueryObject.refine((q) => !q.from || !q.to || q.from <= q.to, {
  path: ['to'],
  message: 'The end date must not be before the start date.',
});
export type ShiftListQuery = z.infer<typeof shiftListQuery>;

// ------------------------------------------------------------------------------------------------ responses

export const CLOSING_STATUSES = ['submitted', 'approved', 'reopened'] as const;
export type ClosingStatus = (typeof CLOSING_STATUSES)[number];

export const cashClosingDto = z.object({
  id: uuid,
  businessDate: z.string(),
  expectedAmount: z.string(),
  countedAmount: z.string(),
  /** counted − expected: negative is short, positive is over. */
  variance: z.string(),
  explanation: z.string().nullable(),
  threshold: z.string(),
  approvalRequired: z.boolean(),
  /** submitted: waiting for approval; approved: final (variance posted); reopened: replaced by a later closing. */
  status: z.enum(CLOSING_STATUSES),
  submittedByName: z.string().nullable(),
  submittedAt: z.string(),
  /** null when the closing needed no approval (no variance, or within the threshold). */
  approvedByName: z.string().nullable(),
  approvedAt: z.string().nullable(),
  approvalNote: z.string().nullable(),
  varianceJournalEntryId: uuid.nullable(),
  varianceJournalNumber: z.number().int().nullable(),
  reopenedByName: z.string().nullable(),
  reopenedAt: z.string().nullable(),
  reopenReason: z.string().nullable(),
});
export type CashClosingDto = z.infer<typeof cashClosingDto>;

export const shiftMovementDto = z.object({
  entryId: uuid,
  journalNumber: z.number().int().nullable(),
  accountingDate: z.string(),
  sourceType: z.string(),
  narration: z.string(),
  reference: z.string().nullable(),
  in: z.string(),
  out: z.string(),
});
export type ShiftMovementDto = z.infer<typeof shiftMovementDto>;

export const cashierShiftDto = z.object({
  id: uuid,
  cashAccountId: uuid,
  cashAccountName: z.string(),
  userId: uuid,
  userName: z.string(),
  businessDate: z.string(),
  openedAt: z.string(),
  openingCount: z.string(),
  /** The drawer's ledger balance when the shift opened. */
  bookBalanceAtOpen: z.string(),
  /** openingCount − bookBalanceAtOpen; not zero means the drawer did not hold what the books said. */
  openingDifference: z.string(),
  status: z.enum(['open', 'closed']),
  closedAt: z.string().nullable(),
  /** Cash in and out on this drawer while the shift was open, from the posted journal lines. */
  cashIn: z.string(),
  cashOut: z.string(),
  /** openingCount + cashIn − cashOut (for a closed shift: as fixed when the closing was submitted). */
  expected: z.string(),
  /** The current closing (submitted or approved), if any. */
  closing: cashClosingDto.nullable(),
  /** Earlier closings that were reopened, oldest first. */
  reopenedClosings: z.array(cashClosingDto),
});
export type CashierShiftDto = z.infer<typeof cashierShiftDto>;

export const cashierShiftDetailDto = cashierShiftDto.extend({ movements: z.array(shiftMovementDto) });
export type CashierShiftDetailDto = z.infer<typeof cashierShiftDetailDto>;
