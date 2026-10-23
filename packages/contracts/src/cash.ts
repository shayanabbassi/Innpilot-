import { z } from 'zod';
import { uuid } from './common';
import { journalLineInput, lineAmount } from './finance';
import { cashAccountDto, cashAccountKind } from './payments';
import { businessDate } from './reservations';

const positiveAmount = lineAmount.refine((v) => /[1-9]/.test(v), 'The amount must be more than zero.');

/** Bank name, branch and account title. Card numbers are refused, as on payments. */
const cashAccountDetails = z
  .string()
  .trim()
  .max(120)
  .refine((v) => !/\d{13,19}/.test(v.replace(/[\s-]/g, '')), 'Do not enter card numbers here.');

// ------------------------------------------------------------------------------------------------ cash accounts

export const createCashAccountRequest = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(80),
    kind: cashAccountKind,
    details: cashAccountDetails.optional(),
    /**
     * The asset account it posts to. Defaults to the system account for the kind (cash on hand, bank accounts, card
     * clearing); several cash accounts can share one ledger account and are told apart by the cash dimension.
     */
    ledgerAccountId: uuid.optional(),
  })
  .strict()
  .refine((v) => v.kind !== 'other' || !!v.ledgerAccountId, {
    path: ['ledgerAccountId'],
    message: 'Choose the ledger account for this kind of account.',
  });
export type CreateCashAccountRequest = z.infer<typeof createCashAccountRequest>;

/** The ledger account and kind are fixed once created: changing them would move posted money between accounts. */
export const updateCashAccountRequest = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(80).optional(),
    details: cashAccountDetails.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateCashAccountRequest = z.infer<typeof updateCashAccountRequest>;

// ------------------------------------------------------------------------------------------------ movements

export const cashMovementsQueryObject = z.object({ from: businessDate, to: businessDate });
export const cashMovementsQuery = cashMovementsQueryObject.refine((q) => q.from <= q.to, {
  path: ['to'],
  message: 'The end date must not be before the start date.',
});
export type CashMovementsQuery = z.infer<typeof cashMovementsQuery>;

/** Read from the posted journal lines tagged with the account: the cashbook is never a second copy of the money. */
export const cashMovementsDto = z.object({
  account: cashAccountDto,
  from: z.string(),
  to: z.string(),
  openingBalance: z.string(),
  totalIn: z.string(),
  totalOut: z.string(),
  closingBalance: z.string(),
  lines: z.array(
    z.object({
      entryId: uuid,
      journalNumber: z.number().int(),
      accountingDate: z.string(),
      narration: z.string(),
      description: z.string().nullable(),
      reference: z.string().nullable(),
      sourceType: z.string(),
      in: z.string(),
      out: z.string(),
      balance: z.string(),
    }),
  ),
});
export type CashMovementsDto = z.infer<typeof cashMovementsDto>;

// ------------------------------------------------------------------------------------------------ transfers

export const transferRequest = z
  .object({
    fromCashAccountId: uuid,
    toCashAccountId: uuid,
    amount: positiveAmount,
    /** Deposit slip or bank reference. */
    reference: z.string().trim().max(80).optional(),
    notes: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((v) => v.fromCashAccountId !== v.toCashAccountId, {
    path: ['toCashAccountId'],
    message: 'Choose a different account to move the money to.',
  });
export type TransferRequest = z.infer<typeof transferRequest>;

export const transferDto = z.object({
  id: uuid,
  fromCashAccountId: uuid,
  fromCashAccountName: z.string(),
  toCashAccountId: uuid,
  toCashAccountName: z.string(),
  amount: z.string(),
  businessDate: z.string(),
  reference: z.string().nullable(),
  notes: z.string().nullable(),
  journalEntryId: uuid,
  journalNumber: z.number().int().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});
export type TransferDto = z.infer<typeof transferDto>;

export const transferListQueryObject = z.object({
  from: businessDate.optional(),
  to: businessDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const transferListQuery = transferListQueryObject.refine((q) => !q.from || !q.to || q.from <= q.to, {
  path: ['to'],
  message: 'The end date must not be before the start date.',
});
export type TransferListQuery = z.infer<typeof transferListQuery>;

// ------------------------------------------------------------------------------------------------ opening balances

/**
 * The balances brought forward when the hotel starts using InnPilot, as at the day before go-live. Only balance
 * sheet accounts (assets, liabilities, equity) can be opened; any difference goes to Opening balance equity.
 */
export const openingBalancesRequest = z
  .object({
    asOf: businessDate,
    lines: z.array(journalLineInput).min(1, 'Enter at least one balance.').max(200),
  })
  .strict();
export type OpeningBalancesRequest = z.infer<typeof openingBalancesRequest>;

export const openingBalancesDto = z.object({
  id: uuid,
  asOf: z.string(),
  journalEntryId: uuid,
  journalNumber: z.number().int().nullable(),
  totalDebit: z.string(),
  totalCredit: z.string(),
  /** Posted to Opening balance equity to balance the entry: positive is a credit to equity. */
  equityAmount: z.string(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
});
export type OpeningBalancesDto = z.infer<typeof openingBalancesDto>;
