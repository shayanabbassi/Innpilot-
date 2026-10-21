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
