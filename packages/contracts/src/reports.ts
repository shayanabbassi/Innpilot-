import { z } from 'zod';
import { uuid } from './common';
import { businessDate } from './reservations';

/**
 * Phase 5 reports (P5-1). Every figure is read from posted journal lines; drafts never count. Amounts are strings
 * with 2 decimals. A report without `propertyId` covers all properties and needs a tenant-wide role.
 */

/** What every report response states about itself (P5-2). */
const reportContext = {
  propertyId: uuid.nullable(),
  currencyCode: z.string(),
  /** Timezone of the property (or of the tenant's first property for all properties); dates are hotel dates. */
  timezone: z.string().nullable(),
  generatedAt: z.string(),
  /** Plain-language definition of each figure, keyed by field. */
  definitions: z.record(z.string(), z.string()),
};

// ------------------------------------------------------------------------------------------------ profit and loss

export const COMPARISONS = ['none', 'previous_period', 'previous_year'] as const;
export type Comparison = (typeof COMPARISONS)[number];

const rangeCheck = (q: { from: string; to: string }) => q.from <= q.to;
const rangeIssue = { path: ['to'], message: 'The end date must not be before the start date.' };

export const profitLossQueryObject = z.object({
  from: businessDate,
  to: businessDate,
  propertyId: uuid.optional(),
  compare: z.enum(COMPARISONS).default('none'),
});
export const profitLossQuery = profitLossQueryObject.refine(rangeCheck, rangeIssue);
export type ProfitLossQuery = z.infer<typeof profitLossQuery>;

export const PL_SECTIONS = ['revenue', 'cost_of_sales', 'operating_expense', 'other'] as const;
export type PlSection = (typeof PL_SECTIONS)[number];

const statementRow = z.object({
  accountId: uuid,
  code: z.string(),
  name: z.string(),
  /** Shown the natural way for the section: income and balances positive, contra amounts negative. */
  amount: z.string(),
  /** The same account in the comparison range; null without a comparison. */
  comparison: z.string().nullable(),
});

const plFigure = z.object({ amount: z.string(), comparison: z.string().nullable() });

export const profitLossDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  compare: z.enum(COMPARISONS),
  comparisonFrom: z.string().nullable(),
  comparisonTo: z.string().nullable(),
  sections: z.array(
    z.object({
      key: z.enum(PL_SECTIONS),
      rows: z.array(statementRow),
      total: plFigure,
    }),
  ),
  grossProfit: plFigure,
  operatingProfit: plFigure,
  netProfit: plFigure,
});
export type ProfitLossDto = z.infer<typeof profitLossDto>;

// ------------------------------------------------------------------------------------------------ balance sheet

export const balanceSheetQuery = z.object({ asOf: businessDate, propertyId: uuid.optional() });
export type BalanceSheetQuery = z.infer<typeof balanceSheetQuery>;

export const BS_SECTIONS = [
  'current_asset',
  'non_current_asset',
  'current_liability',
  'non_current_liability',
  'equity',
] as const;
export type BsSection = (typeof BS_SECTIONS)[number];

export const balanceSheetDto = z.object({
  ...reportContext,
  asOf: z.string(),
  sections: z.array(
    z.object({
      key: z.enum(BS_SECTIONS),
      rows: z.array(statementRow.omit({ comparison: true })),
      total: z.string(),
    }),
  ),
  /** Profit or loss of the fiscal year of `asOf` up to that date, not yet moved to retained earnings. */
  currentYearResult: z.string(),
  /** Result of earlier years whose year-end close has not been run (zero once they are closed). */
  earlierYearsResult: z.string(),
  totalAssets: z.string(),
  totalLiabilities: z.string(),
  /** Equity accounts plus both results. */
  totalEquity: z.string(),
  totalLiabilitiesAndEquity: z.string(),
  /** Assets − (liabilities + equity); zero whenever the ledger balances. */
  difference: z.string(),
  balanced: z.boolean(),
});
export type BalanceSheetDto = z.infer<typeof balanceSheetDto>;

// ------------------------------------------------------------------------------------------------ cashbook

export const CASHBOOK_KINDS = ['cash', 'bank', 'card_clearing', 'other'] as const;

export const cashbookQueryObject = z.object({
  from: businessDate,
  to: businessDate,
  propertyId: uuid.optional(),
  kind: z.enum(CASHBOOK_KINDS).optional(),
});
export const cashbookQuery = cashbookQueryObject.refine(rangeCheck, rangeIssue);
export type CashbookQuery = z.infer<typeof cashbookQuery>;

const cashMovement = { receipts: z.string(), payments: z.string(), closing: z.string() };

/** P5-8: per cash account, opening + receipts − payments = closing, day by day, read from the tagged ledger lines. */
export const cashbookDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  accounts: z.array(
    z.object({
      cashAccountId: uuid,
      propertyId: uuid,
      name: z.string(),
      kind: z.enum(CASHBOOK_KINDS),
      active: z.boolean(),
      ledgerAccountCode: z.string(),
      opening: z.string(),
      ...cashMovement,
      /** Only the days with movements. */
      days: z.array(z.object({ date: z.string(), ...cashMovement })),
    }),
  ),
  totals: z.object({ opening: z.string(), ...cashMovement }),
  /** The drawers and banks on each ledger account against that account's balance on `to` (01 §8). */
  controls: z.array(
    z.object({
      accountId: uuid,
      code: z.string(),
      name: z.string(),
      cashAccountsTotal: z.string(),
      ledgerBalance: z.string(),
      difference: z.string(),
    }),
  ),
  reconciled: z.boolean(),
});
export type CashbookDto = z.infer<typeof cashbookDto>;

// ------------------------------------------------------------------------------------------------ cash flow

export const cashFlowQueryObject = z.object({
  from: businessDate,
  to: businessDate,
  propertyId: uuid.optional(),
});
export const cashFlowQuery = cashFlowQueryObject.refine(rangeCheck, rangeIssue);
export type CashFlowQuery = z.infer<typeof cashFlowQuery>;

export const CASH_FLOW_SECTIONS = ['operating', 'investing', 'financing'] as const;
export const CASH_FLOW_LINES = [
  'receipts_from_guests',
  'guest_deposits',
  'payments_to_suppliers',
  'operating_expenses',
  'taxes',
  'other_operating',
  'fixed_assets',
  'loans',
  'owner_equity',
  'opening_balances',
] as const;
export type CashFlowLine = (typeof CASH_FLOW_LINES)[number];

/** D13: direct method. Each cash movement is classified by the other side of its journal. */
export const cashFlowDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  openingCash: z.string(),
  sections: z.array(
    z.object({
      key: z.enum(CASH_FLOW_SECTIONS),
      lines: z.array(
        z.object({ key: z.enum(CASH_FLOW_LINES), inflow: z.string(), outflow: z.string(), net: z.string() }),
      ),
      net: z.string(),
    }),
  ),
  netChange: z.string(),
  closingCash: z.string(),
  /** Money moved between the hotel's own drawers, banks and card clearing: neither in nor out. */
  transfers: z.string(),
  /** Opening + net change equals the closing cash read directly from the ledger. */
  reconciles: z.boolean(),
});
export type CashFlowDto = z.infer<typeof cashFlowDto>;

// ------------------------------------------------------------------------------------------------ tax summary

export const taxSummaryQueryObject = z.object({
  from: businessDate,
  to: businessDate,
  propertyId: uuid.optional(),
});
export const taxSummaryQuery = taxSummaryQueryObject.refine(rangeCheck, rangeIssue);
export type TaxSummaryQuery = z.infer<typeof taxSummaryQuery>;

/** 01 §6: by tax code, from the snapshots on posted guest charges; not a legal filing by itself. */
export const taxSummaryDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  rows: z.array(
    z.object({
      code: z.string(),
      name: z.string(),
      ratePercent: z.string(),
      inclusive: z.boolean(),
      accountCode: z.string(),
      taxableBase: z.string(),
      taxAmount: z.string(),
    }),
  ),
  totalTaxableBase: z.string(),
  totalTax: z.string(),
  /** Each tax payable account: tax on bills, every other posting (payments to the authority, adjustments). */
  accounts: z.array(
    z.object({
      accountId: uuid,
      code: z.string(),
      name: z.string(),
      chargedOnBills: z.string(),
      ledgerMovement: z.string(),
      otherPostings: z.string(),
      closingBalance: z.string(),
    }),
  ),
  /** Purchase tax marked recoverable on expenses (account 1300), for the same dates. */
  recoverablePurchaseTax: z.string(),
});
export type TaxSummaryDto = z.infer<typeof taxSummaryDto>;

// ------------------------------------------------------------------------------------------------ revenue

export const revenueQueryObject = z.object({
  from: businessDate,
  to: businessDate,
  propertyId: uuid.optional(),
});
export const revenueQuery = revenueQueryObject.refine(rangeCheck, rangeIssue);
export type RevenueQuery = z.infer<typeof revenueQuery>;

export const PAYMENT_METHODS_REPORTED = ['cash', 'bank_transfer', 'card', 'other'] as const;

/** 01 §6 daily revenue summary: posted revenue by account and day, reconciling to the P&L; receipts kept apart. */
export const revenueDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  categories: z.array(z.object({ accountId: uuid, code: z.string(), name: z.string(), total: z.string() })),
  days: z.array(
    z.object({
      date: z.string(),
      /** Same order as `categories`. */
      amounts: z.array(z.string()),
      total: z.string(),
    }),
  ),
  total: z.string(),
  receipts: z.array(
    z.object({
      method: z.enum(PAYMENT_METHODS_REPORTED),
      deposits: z.string(),
      payments: z.string(),
      refunds: z.string(),
      net: z.string(),
    }),
  ),
  receiptsTotal: z.string(),
});
export type RevenueDto = z.infer<typeof revenueDto>;
