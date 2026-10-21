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
  categories: z.array(
    z.object({
      accountId: uuid,
      code: z.string(),
      name: z.string(),
      /** room_revenue for the room revenue account, so screens need no account code. */
      systemRole: z.string().nullable(),
      total: z.string(),
    }),
  ),
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

// ------------------------------------------------------------------------------------------------ aging

/** D14: current, 1–30, 31–60, 61–90 and over 90 days. */
export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'over_90'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** The bucket for a number of days past the reference date (zero or less is current). */
export function agingBucket(days: number): AgingBucket {
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'over_90';
}

const bucketTotals = z.object({
  current: z.string(),
  d1_30: z.string(),
  d31_60: z.string(),
  d61_90: z.string(),
  over_90: z.string(),
  total: z.string(),
});

export const agingQuery = z.object({ asOf: businessDate, propertyId: uuid.optional() });
export type AgingQuery = z.infer<typeof agingQuery>;

/** A ledger account against the items aged from it; what is not linked to an item is shown, not hidden. */
const ledgerTie = z.object({
  accountId: uuid,
  code: z.string(),
  name: z.string(),
  ledgerBalance: z.string(),
  aged: z.string(),
  notLinked: z.string(),
});

/** 01 §6 guest ledger: folios with a balance on the date, aged from their invoice (check-out) date. */
export const receivablesAgingDto = z.object({
  ...reportContext,
  asOf: z.string(),
  guests: z.array(
    z.object({
      guestId: uuid,
      guestName: z.string(),
      folios: z.array(
        z.object({
          folioId: uuid,
          propertyId: uuid,
          reservationId: uuid,
          bookingReference: z.string(),
          label: z.string(),
          /** The folio's status on the date: open (in house or not yet arrived), or checked out. */
          state: z.enum(['open', 'checked_out']),
          invoiceNumber: z.string().nullable(),
          invoiceDate: z.string().nullable(),
          days: z.number().int(),
          bucket: z.enum(AGING_BUCKETS),
          receivable: z.string(),
          deposits: z.string(),
          balance: z.string(),
        }),
      ),
      totals: bucketTotals,
    }),
  ),
  totals: bucketTotals,
  /** Guest receivable (1200) and guest deposits (2100) against the folios. */
  ledger: z.array(ledgerTie),
});
export type ReceivablesAgingDto = z.infer<typeof receivablesAgingDto>;

/** 01 §6 payables aging: supplier bills outstanding on the date, aged by due date (bill date when none). */
export const payablesAgingDto = z.object({
  ...reportContext,
  asOf: z.string(),
  suppliers: z.array(
    z.object({
      supplierId: uuid,
      supplierName: z.string(),
      bills: z.array(
        z.object({
          voucherId: uuid,
          propertyId: uuid,
          voucherNumber: z.string(),
          billReference: z.string().nullable(),
          billDate: z.string(),
          dueDate: z.string(),
          days: z.number().int(),
          bucket: z.enum(AGING_BUCKETS),
          total: z.string(),
          paid: z.string(),
          outstanding: z.string(),
        }),
      ),
      /** Payables of this supplier not linked to a bill (opening balances, manual journals); not aged. */
      notLinked: z.string(),
      totals: bucketTotals,
      balance: z.string(),
    }),
  ),
  totals: bucketTotals,
  notLinked: z.string(),
  ledger: z.array(ledgerTie),
});
export type PayablesAgingDto = z.infer<typeof payablesAgingDto>;

// ------------------------------------------------------------------------------------------------ operational

export const operationalQueryObject = z.object({
  from: businessDate,
  to: businessDate,
  propertyId: uuid.optional(),
});
/** A range of hotel dates, at most a year (operational reports list days and items). */
export const operationalQuery = operationalQueryObject
  .refine(rangeCheck, rangeIssue)
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000, {
    path: ['to'],
    message: 'Choose at most a year.',
  });
export type OperationalQuery = z.infer<typeof operationalQuery>;

/** P5-12: occupancy, ADR and RevPAR by night. */
export const occupancyDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  nights: z.array(
    z.object({
      night: z.string(),
      /** actual: before the business date (nights audited or billed); on_the_books: today and later, from bookings. */
      basis: z.enum(['actual', 'on_the_books']),
      rooms: z.number().int(),
      outOfService: z.number().int(),
      available: z.number().int(),
      sold: z.number().int(),
      /** Percent with 1 decimal, as a string; null when no room was available. */
      occupancy: z.string().nullable(),
      roomRevenue: z.string(),
      adr: z.string().nullable(),
      revpar: z.string().nullable(),
    }),
  ),
  /** Actual nights only: on-the-books nights have no posted revenue yet. */
  totals: z.object({
    available: z.number().int(),
    sold: z.number().int(),
    occupancy: z.string().nullable(),
    roomRevenue: z.string(),
    adr: z.string().nullable(),
    revpar: z.string().nullable(),
  }),
});
export type OccupancyDto = z.infer<typeof occupancyDto>;

const movement = z.object({
  reservationId: uuid,
  propertyId: uuid,
  bookingReference: z.string(),
  guestName: z.string(),
  roomNumber: z.string().nullable(),
  roomType: z.string(),
  arrival: z.string(),
  departure: z.string(),
  nights: z.number().int(),
  adults: z.number().int(),
  status: z.string(),
});

/** Arrivals and departures by date, with the booking's status. */
export const movementsDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  arrivals: z.array(movement),
  departures: z.array(movement),
});
export type MovementsDto = z.infer<typeof movementsDto>;

/** 01 §6 cashier variance: every closing in the range with its approval trail. */
export const cashierClosingsDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  /** False when the user sees only their own closings. */
  allCashiers: z.boolean(),
  closings: z.array(
    z.object({
      closingId: uuid,
      shiftId: uuid,
      propertyId: uuid,
      businessDate: z.string(),
      cashierName: z.string(),
      cashAccountName: z.string(),
      expected: z.string(),
      counted: z.string(),
      variance: z.string(),
      explanation: z.string().nullable(),
      status: z.enum(['submitted', 'approved', 'reopened']),
      approvalRequired: z.boolean(),
      approvedByName: z.string().nullable(),
      approvalNote: z.string().nullable(),
      reopenReason: z.string().nullable(),
    }),
  ),
  totals: z.object({
    closings: z.number().int(),
    shortages: z.string(),
    overages: z.string(),
    net: z.string(),
    awaitingApproval: z.number().int(),
  }),
});
export type CashierClosingsDto = z.infer<typeof cashierClosingsDto>;

/** Posted expenses by account and by supplier or payee, for the expense dates in the range. */
export const expensesReportDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  byAccount: z.array(
    z.object({
      accountId: uuid,
      code: z.string(),
      name: z.string(),
      amount: z.string(),
      tax: z.string(),
      total: z.string(),
    }),
  ),
  byPayee: z.array(
    z.object({
      supplierId: uuid.nullable(),
      name: z.string(),
      cash: z.string(),
      bills: z.string(),
      total: z.string(),
      vouchers: z.number().int(),
    }),
  ),
  total: z.string(),
  /** Tax kept as recoverable (1300), not part of the cost. */
  recoverableTax: z.string(),
});
export type ExpensesReportDto = z.infer<typeof expensesReportDto>;

/** Exceptions to look into: variances, opening count differences, cash outside shifts, night audit overrides. */
export const discrepanciesDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  variances: z.array(
    z.object({
      shiftId: uuid,
      businessDate: z.string(),
      cashierName: z.string(),
      cashAccountName: z.string(),
      variance: z.string(),
      explanation: z.string().nullable(),
      status: z.string(),
    }),
  ),
  openingDifferences: z.array(
    z.object({
      shiftId: uuid,
      businessDate: z.string(),
      cashierName: z.string(),
      cashAccountName: z.string(),
      openingCount: z.string(),
      bookBalance: z.string(),
      difference: z.string(),
    }),
  ),
  cashOutsideShifts: z.array(
    z.object({
      entryId: uuid,
      journalNumber: z.number().int(),
      accountingDate: z.string(),
      narration: z.string(),
      cashAccountName: z.string(),
      amountIn: z.string(),
      amountOut: z.string(),
    }),
  ),
  auditOverrides: z.array(
    z.object({
      businessDate: z.string(),
      reason: z.string(),
      issues: z.number().int(),
      closedByName: z.string(),
    }),
  ),
});
export type DiscrepanciesDto = z.infer<typeof discrepanciesDto>;

export const userActivityQueryObject = z.object({ from: businessDate, to: businessDate });
export const userActivityQuery = userActivityQueryObject.refine(rangeCheck, rangeIssue);
export type UserActivityQuery = z.infer<typeof userActivityQuery>;

/** PRD §6.9 user activity, from the audit log, for the hotel dates in the range (property timezone). */
export const userActivityDto = z.object({
  ...reportContext,
  from: z.string(),
  to: z.string(),
  users: z.array(
    z.object({
      userId: uuid.nullable(),
      name: z.string(),
      events: z.number().int(),
      signIns: z.number().int(),
      failedSignIns: z.number().int(),
      firstAt: z.string(),
      lastAt: z.string(),
      topActions: z.array(z.object({ action: z.string(), count: z.number().int() })),
    }),
  ),
  totalEvents: z.number().int(),
});
export type UserActivityDto = z.infer<typeof userActivityDto>;

// ------------------------------------------------------------------------------------------------ exports

/** Reports that can be exported (P5-14, D15), by their path under /reports. */
export const EXPORT_REPORTS = [
  'trial-balance',
  'profit-loss',
  'balance-sheet',
  'cashbook',
  'cash-flow',
  'tax-summary',
  'revenue',
  'receivables-aging',
  'payables-aging',
  'occupancy',
  'arrivals-departures',
  'cashier-closings',
  'expenses',
  'discrepancies',
  'user-activity',
] as const;
export type ExportReport = (typeof EXPORT_REPORTS)[number];

/** D15: CSV and Excel from the server; PDF by printing the report page. */
export const EXPORT_FORMATS = ['csv', 'xlsx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** Rows above this are refused with EXPORT_TOO_LARGE until background exports arrive (Phase 6). */
export const EXPORT_ROW_LIMIT = 50_000;
