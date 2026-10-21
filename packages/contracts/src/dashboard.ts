import { z } from 'zod';
import { uuid } from './common';
import { AGING_BUCKETS } from './reports';
import { businessDate } from './reservations';

/**
 * Owner dashboard (PRD §7, 04 API §3, 04 Frontend §3, P5-13). Every figure comes from the same queries as the reports
 * it links to, so the two always agree. Financial figures are left out of the response for users without
 * `report.financial`, not just hidden.
 */
export const dashboardQueryObject = z.object({
  propertyId: uuid,
  /** Period for revenue, profit, expenses and receipts; defaults to the month of the business date up to it. */
  from: businessDate.optional(),
  to: businessDate.optional(),
});
export const dashboardQuery = dashboardQueryObject
  .refine((q) => !!q.from === !!q.to, {
    path: ['to'],
    message: 'Give both dates or neither.',
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    path: ['to'],
    message: 'The end date must not be before the start date.',
  });
export type DashboardQuery = z.infer<typeof dashboardQuery>;

export const KPI_KEYS = [
  'occupancy',
  'rooms_occupied',
  'rooms_available',
  'out_of_service',
  'arrivals',
  'departures',
  'in_house',
  'room_revenue',
  'total_revenue',
  'cash_received',
  'cash_balance',
  'expenses',
  'net_profit',
  'receivables',
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

export const kpiDto = z.object({
  key: z.enum(KPI_KEYS),
  /** A count, a percent with one decimal, or an amount with two decimals, as a string. */
  value: z.string(),
  kind: z.enum(['count', 'percent', 'money']),
  /** Today (the business date), the period, or a balance on the period's end date. */
  scope: z.enum(['today', 'period', 'balance']),
  /** The same figure for the previous period of equal length; null when not comparable. */
  comparison: z.string().nullable(),
  definition: z.string(),
  /** Where the figure comes from: the report or screen that shows it in detail. */
  href: z.string(),
});
export type KpiDto = z.infer<typeof kpiDto>;

const guestMovement = z.object({
  reservationId: uuid,
  bookingReference: z.string(),
  guestName: z.string(),
  roomNumber: z.string().nullable(),
  status: z.string(),
});

export const dashboardDto = z.object({
  propertyId: uuid,
  propertyName: z.string(),
  businessDate: z.string(),
  timezone: z.string(),
  currencyCode: z.string(),
  generatedAt: z.string(),
  from: z.string(),
  to: z.string(),
  comparisonFrom: z.string(),
  comparisonTo: z.string(),
  /** False when the user has no `report.financial` here: the financial cards and panel are absent. */
  financial: z.boolean(),
  kpis: z.array(kpiDto),
  operations: z.object({
    arrivals: z.array(guestMovement),
    departures: z.array(guestMovement),
    /** Arrivals today with no room assigned yet. */
    unassignedArrivals: z.number().int(),
    roomsToClean: z.array(z.object({ roomId: uuid, roomNumber: z.string(), state: z.string() })),
    cashier: z.object({
      openShifts: z.number().int(),
      awaitingApproval: z.number().int(),
      /** Today's closings the user may see: expected against counted cash. */
      closings: z.array(
        z.object({
          shiftId: uuid,
          cashierName: z.string(),
          cashAccountName: z.string(),
          expected: z.string(),
          counted: z.string(),
          variance: z.string(),
          status: z.string(),
        }),
      ),
    }),
  }),
  finance: z
    .object({
      cashAccounts: z.array(
        z.object({ cashAccountId: uuid, name: z.string(), kind: z.string(), balance: z.string() }),
      ),
      todayReceipts: z.string(),
      todayPayments: z.string(),
      pendingExpenseApprovals: z.number().int(),
      draftJournals: z.number().int(),
      /** Largest guest balances on the period's end date. */
      unresolvedBalances: z.array(
        z.object({
          reservationId: uuid,
          guestName: z.string(),
          bookingReference: z.string(),
          balance: z.string(),
          bucket: z.enum(AGING_BUCKETS),
        }),
      ),
    })
    .nullable(),
});
export type DashboardDto = z.infer<typeof dashboardDto>;
