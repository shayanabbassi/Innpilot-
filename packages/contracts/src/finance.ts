import { z } from 'zod';
import { uuid } from './common';
import { businessDate } from './reservations';

// ------------------------------------------------------------------------------------------------ accounts

export const ACCOUNT_CLASSES = [
  'asset',
  'liability',
  'equity',
  'revenue',
  'cost_of_sales',
  'expense',
  'other',
] as const;
export type AccountClass = (typeof ACCOUNT_CLASSES)[number];
export const accountClass = z.enum(ACCOUNT_CLASSES);

export const NORMAL_BALANCES = ['debit', 'credit'] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

/** First digit of the account code for each class (accounting spec §2: 1000 assets … 7000 other). */
export const CLASS_CODE_DIGIT: Record<AccountClass, string> = {
  asset: '1',
  liability: '2',
  equity: '3',
  revenue: '4',
  cost_of_sales: '5',
  expense: '6',
  other: '7',
};

export function defaultNormalBalance(cls: AccountClass): NormalBalance {
  return cls === 'asset' || cls === 'cost_of_sales' || cls === 'expense' ? 'debit' : 'credit';
}

export const accountCode = z
  .string()
  .trim()
  .regex(/^[1-7]\d{3,5}$/, 'Use a 4 to 6 digit code starting with 1–7, e.g. 6150.');

export const createAccountRequest = z
  .object({
    code: accountCode,
    name: z.string().trim().min(1, 'Enter a name.').max(120),
    accountClass,
    normalBalance: z.enum(NORMAL_BALANCES).optional(),
    parentId: uuid.nullable().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.code[0] !== CLASS_CODE_DIGIT[v.accountClass]) {
      ctx.addIssue({
        code: 'custom',
        path: ['code'],
        message: `Codes for this class start with ${CLASS_CODE_DIGIT[v.accountClass]}.`,
      });
    }
  });
export type CreateAccountRequest = z.infer<typeof createAccountRequest>;

/** Code, class and normal balance are fixed once created: changing them would re-classify posted amounts. */
export const updateAccountRequest = z
  .object({
    name: z.string().trim().min(1, 'Enter a name.').max(120).optional(),
    parentId: uuid.nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field.' });
export type UpdateAccountRequest = z.infer<typeof updateAccountRequest>;

export const accountDto = z.object({
  id: uuid,
  code: z.string(),
  name: z.string(),
  accountClass,
  normalBalance: z.enum(NORMAL_BALANCES),
  parentId: uuid.nullable(),
  /** Set on accounts the posting rules use; these cannot be deactivated. */
  systemRole: z.string().nullable(),
  active: z.boolean(),
});
export type AccountDto = z.infer<typeof accountDto>;

// ------------------------------------------------------------------------------------------------ journals

/** A line amount as entered: at most 2 decimal places (paisa, decision D5), as a string. Never a JS number. */
export const lineAmount = z
  .string()
  .trim()
  .regex(/^\d{1,13}(\.\d{1,2})?$/, 'Enter an amount such as 1500 or 1500.50 (at most 2 decimal places).');

export const journalLineInput = z
  .object({
    accountId: uuid,
    debit: lineAmount.default('0'),
    credit: lineAmount.default('0'),
    description: z.string().trim().max(300).optional(),
  })
  .strict()
  .superRefine((l, ctx) => {
    const dr = /[1-9]/.test(l.debit);
    const cr = /[1-9]/.test(l.credit);
    if (dr === cr) {
      ctx.addIssue({
        code: 'custom',
        path: ['debit'],
        message: 'Enter an amount in either debit or credit, not both.',
      });
    }
  });
export type JournalLineInput = z.infer<typeof journalLineInput>;

/** A manual journal draft. It may be unbalanced while being prepared; posting checks the balance. */
export const journalDraftRequest = z
  .object({
    propertyId: uuid,
    /** Defaults to the property's business date. Must not be later than it. */
    accountingDate: businessDate.optional(),
    narration: z.string().trim().min(3, 'Describe the entry (at least 3 characters).').max(500),
    reference: z.string().trim().max(80).optional(),
    lines: z.array(journalLineInput).min(2, 'A journal needs at least two lines.').max(100),
  })
  .strict();
export type JournalDraftRequest = z.infer<typeof journalDraftRequest>;

export const reverseJournalRequest = z
  .object({
    reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500),
    /** Defaults to the property's business date. */
    accountingDate: businessDate.optional(),
  })
  .strict();
export type ReverseJournalRequest = z.infer<typeof reverseJournalRequest>;

export const JOURNAL_STATUSES = ['draft', 'posted', 'reversed'] as const;
export type JournalStatus = (typeof JOURNAL_STATUSES)[number];

export const journalLineDto = z.object({
  id: uuid,
  lineNo: z.number().int(),
  accountId: uuid,
  accountCode: z.string(),
  accountName: z.string(),
  debit: z.string(),
  credit: z.string(),
  description: z.string().nullable(),
});
export type JournalLineDto = z.infer<typeof journalLineDto>;

export const journalEntryDto = z.object({
  id: uuid,
  propertyId: uuid,
  journalNumber: z.number().int().nullable(),
  status: z.enum(JOURNAL_STATUSES),
  accountingDate: z.string(),
  currencyCode: z.string(),
  sourceType: z.string(),
  sourceId: uuid.nullable(),
  reference: z.string().nullable(),
  narration: z.string(),
  totalDebit: z.string(),
  totalCredit: z.string(),
  reversesEntryId: uuid.nullable(),
  reversesNumber: z.number().int().nullable(),
  reversedById: uuid.nullable(),
  reversedByNumber: z.number().int().nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  postedByName: z.string().nullable(),
  postedAt: z.string().nullable(),
  lines: z.array(journalLineDto),
});
export type JournalEntryDto = z.infer<typeof journalEntryDto>;

export const journalListQueryObject = z.object({
  status: z.enum(JOURNAL_STATUSES).optional(),
  propertyId: uuid.optional(),
  from: businessDate.optional(),
  to: businessDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export const journalListQuery = journalListQueryObject.refine((q) => !q.from || !q.to || q.from <= q.to, {
  path: ['to'],
  message: 'The end date must not be before the start date.',
});
export type JournalListQuery = z.infer<typeof journalListQuery>;

export const journalListDto = z.object({
  items: z.array(journalEntryDto.omit({ lines: true })),
  total: z.number().int(),
});
export type JournalListDto = z.infer<typeof journalListDto>;

// ------------------------------------------------------------------------------------------------ reports

const dateRange = { from: businessDate, to: businessDate, propertyId: uuid.optional() };
const rangeCheck = (q: { from: string; to: string }) => q.from <= q.to;
const rangeIssue = { path: ['to'], message: 'The end date must not be before the start date.' };

export const ledgerQueryObject = z.object({ accountId: uuid, ...dateRange });
export const ledgerQuery = ledgerQueryObject.refine(rangeCheck, rangeIssue);
export type LedgerQuery = z.infer<typeof ledgerQuery>;

/** Balances are debit minus credit: positive is a debit balance, negative a credit balance. */
export const ledgerDto = z.object({
  account: accountDto,
  from: z.string(),
  to: z.string(),
  openingBalance: z.string(),
  totalDebit: z.string(),
  totalCredit: z.string(),
  closingBalance: z.string(),
  lines: z.array(
    z.object({
      entryId: uuid,
      journalNumber: z.number().int(),
      accountingDate: z.string(),
      narration: z.string(),
      reference: z.string().nullable(),
      sourceType: z.string(),
      debit: z.string(),
      credit: z.string(),
      balance: z.string(),
    }),
  ),
});
export type LedgerDto = z.infer<typeof ledgerDto>;

export const trialBalanceQueryObject = z.object(dateRange);
export const trialBalanceQuery = trialBalanceQueryObject.refine(rangeCheck, rangeIssue);
export type TrialBalanceQuery = z.infer<typeof trialBalanceQuery>;

const tbAmounts = {
  openingDebit: z.string(),
  openingCredit: z.string(),
  debit: z.string(),
  credit: z.string(),
  closingDebit: z.string(),
  closingCredit: z.string(),
};

/** Opening and closing balances are cumulative from the first posting (year-end closing arrives with Phase 4). */
export const trialBalanceDto = z.object({
  from: z.string(),
  to: z.string(),
  currencyCode: z.string(),
  rows: z.array(
    z.object({
      accountId: uuid,
      code: z.string(),
      name: z.string(),
      accountClass,
      active: z.boolean(),
      ...tbAmounts,
    }),
  ),
  totals: z.object(tbAmounts),
  balanced: z.boolean(),
});
export type TrialBalanceDto = z.infer<typeof trialBalanceDto>;

// ------------------------------------------------------------------------------------------------ periods

export const periodMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use a month like 2026-10.');

export const reopenPeriodRequest = z
  .object({ reason: z.string().trim().min(3, 'Give a reason (at least 3 characters).').max(500) })
  .strict();
export type ReopenPeriodRequest = z.infer<typeof reopenPeriodRequest>;

export const fiscalPeriodDto = z.object({
  month: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  status: z.enum(['open', 'closed']),
  closedAt: z.string().nullable(),
  closedByName: z.string().nullable(),
  reopenedAt: z.string().nullable(),
  reopenedByName: z.string().nullable(),
  reopenReason: z.string().nullable(),
  postedEntries: z.number().int(),
  draftEntries: z.number().int(),
});
export type FiscalPeriodDto = z.infer<typeof fiscalPeriodDto>;
