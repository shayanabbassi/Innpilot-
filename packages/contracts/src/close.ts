import { z } from 'zod';
import { uuid } from './common';

/**
 * Month-end checklist (P4-10). Blockers stop the close; warnings can be accepted with a reason, kept with the
 * period. The year-end close (P4-11, calendar year by D10) adds that every earlier month of the year is closed.
 */
export const CLOSE_BLOCKERS = [
  'business_dates_open',
  'draft_journals',
  'open_shifts',
  'closings_pending',
  'months_open',
] as const;
export const CLOSE_WARNINGS = ['bank_not_reconciled', 'earlier_months_open'] as const;
export const CLOSE_CHECKS = [...CLOSE_BLOCKERS, ...CLOSE_WARNINGS] as const;
export type CloseCheck = (typeof CLOSE_CHECKS)[number];

export const closeCheckDto = z.object({
  check: z.enum(CLOSE_CHECKS),
  severity: z.enum(['blocker', 'warning']),
  /** What is open, e.g. a property, a journal number or an account. */
  label: z.string(),
  detail: z.string().nullable(),
});
export type CloseCheckDto = z.infer<typeof closeCheckDto>;

export const periodChecklistDto = z.object({
  month: z.string(),
  status: z.enum(['open', 'closed']),
  items: z.array(closeCheckDto),
  blockers: z.number().int(),
  warnings: z.number().int(),
});
export type PeriodChecklistDto = z.infer<typeof periodChecklistDto>;

/** A reason is needed when warnings remain; it is recorded with the period. */
export const closePeriodRequest = z
  .object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500).optional() })
  .strict();
export type ClosePeriodRequest = z.infer<typeof closePeriodRequest>;

export const fiscalYearParam = z.coerce.number().int().min(2000).max(2200);

export const fiscalYearDto = z.object({
  id: uuid,
  year: z.number().int(),
  status: z.enum(['closed', 'reopened']),
  /** Moved to retained earnings: positive is a profit. */
  result: z.string(),
  closeReason: z.string().nullable(),
  closedByName: z.string().nullable(),
  closedAt: z.string(),
  reopenedByName: z.string().nullable(),
  reopenedAt: z.string().nullable(),
  reopenReason: z.string().nullable(),
});
export type FiscalYearDto = z.infer<typeof fiscalYearDto>;

export const yearEndEntryDto = z.object({
  propertyId: uuid,
  propertyName: z.string(),
  /** Each revenue, cost and expense account's balance for the year (credit positive), closed to retained earnings. */
  lines: z.array(z.object({ accountCode: z.string(), accountName: z.string(), balance: z.string() })),
  /** Profit (positive) or loss (negative) of the property for the year. */
  result: z.string(),
});
export type YearEndEntryDto = z.infer<typeof yearEndEntryDto>;

export const yearEndPreviewDto = z.object({
  year: z.number().int(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.enum(['open', 'closed']),
  /** Blockers and warnings: every month but December closed, and December's own checklist. */
  items: z.array(closeCheckDto),
  /** The closing entries the close would post (when open), or posted (when closed). */
  entries: z.array(yearEndEntryDto),
  result: z.string(),
  history: z.array(fiscalYearDto),
});
export type YearEndPreviewDto = z.infer<typeof yearEndPreviewDto>;

export const closeYearRequest = closePeriodRequest;
export type CloseYearRequest = ClosePeriodRequest;

export const reopenYearRequest = z
  .object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500) })
  .strict();
export type ReopenYearRequest = z.infer<typeof reopenYearRequest>;
