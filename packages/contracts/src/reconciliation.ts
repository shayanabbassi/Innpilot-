import { z } from 'zod';
import { uuid } from './common';
import { lineAmount } from './finance';
import { businessDate } from './reservations';

/** A statement balance: may be negative (an overdrawn account), at most 2 decimal places. */
export const signedAmount = z
  .string()
  .trim()
  .regex(/^-?\d{1,13}(\.\d{1,2})?$/, 'Enter an amount such as 125000 or -350.50 (at most 2 decimal places).');

const positiveAmount = lineAmount.refine((v) => /[1-9]/.test(v), 'The amount must be more than zero.');

// ------------------------------------------------------------------------------------------------ reconciliation

export const startReconciliationRequest = z
  .object({
    /** A bank or card-clearing account. Cash drawers are counted in cashier shifts instead. */
    cashAccountId: uuid,
    statementDate: businessDate,
    statementBalance: signedAmount,
  })
  .strict();
export type StartReconciliationRequest = z.infer<typeof startReconciliationRequest>;

export const updateReconciliationRequest = z
  .object({ statementDate: businessDate.optional(), statementBalance: signedAmount.optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateReconciliationRequest = z.infer<typeof updateReconciliationRequest>;

/** Replaces the set of ticked lines (the ledger lines that appear on the statement). */
export const reconciliationItemsRequest = z.object({ journalLineIds: z.array(uuid).max(5000) }).strict();
export type ReconciliationItemsRequest = z.infer<typeof reconciliationItemsRequest>;

/** Finishing needs a zero difference, or an explanation of it; nothing is adjusted silently. */
export const completeReconciliationRequest = z
  .object({ explanation: z.string().trim().max(1000).optional() })
  .strict();
export type CompleteReconciliationRequest = z.infer<typeof completeReconciliationRequest>;

export const reconciliationListQueryObject = z.object({ cashAccountId: uuid.optional() });
export type ReconciliationListQuery = z.infer<typeof reconciliationListQueryObject>;

export const reconciliationDto = z.object({
  id: uuid,
  cashAccountId: uuid,
  cashAccountName: z.string(),
  statementDate: z.string(),
  statementBalance: z.string(),
  status: z.enum(['in_progress', 'completed']),
  /** Every line reconciled before plus the lines ticked here (debit minus credit). */
  clearedBalance: z.string(),
  /** statementBalance − clearedBalance. */
  difference: z.string(),
  differenceExplanation: z.string().nullable(),
  /** The statement date of the account's last completed reconciliation, if any. */
  previousStatementDate: z.string().nullable(),
  tickedCount: z.number().int(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  completedByName: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type ReconciliationDto = z.infer<typeof reconciliationDto>;

export const reconciliationLineDto = z.object({
  journalLineId: uuid,
  entryId: uuid,
  journalNumber: z.number().int().nullable(),
  accountingDate: z.string(),
  narration: z.string(),
  description: z.string().nullable(),
  reference: z.string().nullable(),
  sourceType: z.string(),
  /** Money in is positive, money out negative. */
  amount: z.string(),
  ticked: z.boolean(),
});
export type ReconciliationLineDto = z.infer<typeof reconciliationLineDto>;

export const reconciliationDetailDto = reconciliationDto.extend({
  /** Lines ticked here, and (while in progress) every unreconciled line up to the statement date. */
  lines: z.array(reconciliationLineDto),
});
export type ReconciliationDetailDto = z.infer<typeof reconciliationDetailDto>;

// ------------------------------------------------------------------------------------------------ card settlements

/** The card company pays the clearing balance into the bank, less its fee (posted to bank charges). */
export const cardSettlementRequest = z
  .object({
    clearingAccountId: uuid,
    bankAccountId: uuid,
    /** What the card company settled, before its fee. */
    grossAmount: positiveAmount,
    feeAmount: lineAmount.default('0'),
    reference: z.string().trim().max(80).optional(),
  })
  .strict()
  .refine((v) => v.clearingAccountId !== v.bankAccountId, {
    path: ['bankAccountId'],
    message: 'Choose the bank account the money went to.',
  });
export type CardSettlementRequest = z.infer<typeof cardSettlementRequest>;

export const cardSettlementDto = z.object({
  id: uuid,
  clearingAccountName: z.string(),
  bankAccountName: z.string(),
  grossAmount: z.string(),
  feeAmount: z.string(),
  netAmount: z.string(),
  businessDate: z.string(),
  reference: z.string().nullable(),
  journalEntryId: uuid,
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});
export type CardSettlementDto = z.infer<typeof cardSettlementDto>;
