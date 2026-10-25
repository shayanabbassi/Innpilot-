import { Injectable } from '@nestjs/common';
import type { DashboardDto, DashboardQuery, KpiDto, PlSection } from '@innpilot/contracts';
import { schema } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error';
import type { AuthContext } from '../common/request';
import { Db } from '../db/db.module';
import { AgingService } from './aging.service';
import { CashReportsService } from './cash-reports.service';
import { OperationalReportsService } from './operational.service';
import { reportScope } from './report-scope';
import { comparisonRange, StatementsService } from './statements.service';

/**
 * The owner dashboard (slice 5.5, P5-13). Every figure is taken from the report service that shows it in detail,
 * with the same filters, so the dashboard and the reports cannot disagree (PRD §7, QA "dashboard totals reconcile
 * with reports"). Financial figures are computed only for users with `report.financial` on the property.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly db: Db,
    private readonly statements: StatementsService,
    private readonly cash: CashReportsService,
    private readonly aging: AgingService,
    private readonly ops: OperationalReportsService,
  ) {}

  async dashboard(auth: AuthContext, q: DashboardQuery): Promise<DashboardDto> {
    const { propertyId } = reportScope(auth, 'report.operational', q.propertyId);
    const pid = propertyId!;
    const financial = auth.permissionsByProperty.get(pid)?.has('report.financial') ?? false;

    const context = await this.db.tenant(auth.tenantId, async (tx) => {
      const [p] = await tx.select().from(schema.properties).where(eq(schema.properties.id, pid));
      if (!p) throw AppError.notFound('property');
      const counts = await tx.execute<{
        in_house: number;
        open_shifts: number;
        awaiting: number;
        pending_expenses: number;
        drafts: number;
      }>(sql`
        select (select count(*) from stays where property_id = ${pid} and status = 'in_house')::int as in_house,
               (select count(*) from cashier_shifts where property_id = ${pid} and status = 'open')::int as open_shifts,
               (select count(*) from cash_closings where property_id = ${pid} and status = 'submitted'
                  and approval_required)::int as awaiting,
               -- The expense module's rule: a submitted voucher, or a paid cash expense not yet reviewed.
               (select count(*) from expense_vouchers where property_id = ${pid}
                  and (status = 'submitted' or (kind = 'cash' and status = 'paid' and approved_by is null)))::int
                  as pending_expenses,
               (select count(*) from journal_entries where property_id = ${pid} and status = 'draft')::int as drafts`);
      const dirty = await tx.execute<{ id: string; room_number: string; state: string }>(sql`
        select id, room_number::text, housekeeping_state as state from rooms
        where property_id = ${pid} and active and housekeeping_state in ('dirty', 'cleaning')
        order by length(room_number), room_number`);
      return { property: p, counts: counts.rows[0]!, dirty: dirty.rows };
    });

    const p = context.property;
    const today = p.businessDate;
    const from = q.from ?? `${today.slice(0, 8)}01`;
    const to = q.to ?? today;
    const cmp = comparisonRange({ from, to, compare: 'previous_period' })!;
    const one = { from: today, to: today, propertyId: pid };

    // Every read starts at once: the financial ones do not wait for the operational ones.
    const range = { from, to, propertyId: pid };
    const financialReads = financial ? this.financialReads(auth, range, cmp, one, to === today) : null;
    // Awaited below; this only keeps an early failure here from being reported as unhandled.
    void financialReads?.catch(() => undefined);
    const [occupancy, movements, closings] = await Promise.all([
      this.ops.occupancy(auth, one),
      this.ops.movements(auth, one),
      this.ops.cashierClosings(auth, one),
    ]);
    const tonight = occupancy.nights[0]!;
    const arrivals = movements.arrivals.filter((m) => m.arrival === today);
    const departures = movements.departures.filter((m) => m.departure === today);
    const count = (v: number) => String(v);

    const kpis: KpiDto[] = [
      {
        key: 'occupancy',
        value: tonight.occupancy ?? '0.0',
        kind: 'percent',
        scope: 'today',
        comparison: null,
        definition: 'Rooms occupied or booked tonight ÷ rooms available tonight.',
        href: '/reports/occupancy',
      },
      {
        key: 'rooms_occupied',
        value: count(tonight.sold),
        kind: 'count',
        scope: 'today',
        comparison: null,
        definition: 'Rooms with a guest in house or booked for tonight.',
        href: '/rooms',
      },
      {
        key: 'rooms_available',
        value: count(tonight.available),
        kind: 'count',
        scope: 'today',
        comparison: null,
        definition: occupancy.definitions.available ?? '',
        href: '/reports/occupancy',
      },
      {
        key: 'out_of_service',
        value: count(tonight.outOfService),
        kind: 'count',
        scope: 'today',
        comparison: null,
        definition: 'Rooms out of order tonight.',
        href: '/maintenance',
      },
      {
        key: 'arrivals',
        value: count(arrivals.length),
        kind: 'count',
        scope: 'today',
        comparison: null,
        definition: 'Bookings arriving today, arrived or not (cancelled ones left out).',
        href: '/reports/arrivals-departures',
      },
      {
        key: 'departures',
        value: count(departures.length),
        kind: 'count',
        scope: 'today',
        comparison: null,
        definition: 'Bookings due to leave today.',
        href: '/reports/arrivals-departures',
      },
      {
        key: 'in_house',
        value: count(context.counts.in_house),
        kind: 'count',
        scope: 'today',
        comparison: null,
        definition: 'Stays checked in and not yet checked out.',
        href: '/front-desk',
      },
    ];

    let finance: DashboardDto['finance'] = null;
    if (financialReads) {
      const [pl, revenue, revenueBefore, balances, todayCash, receivables] = await financialReads;
      const cur = pl.currencyCode;
      const total = (k: PlSection) => pl.sections.find((s) => s.key === k)!.total;
      const m = (v: string | null) => Money.fromStorage(v ?? '0', cur);
      const roomRevenue = (r: typeof revenue) =>
        r.categories.find((c) => c.systemRole === 'room_revenue')?.total ?? '0.00';
      const cost = (f: 'amount' | 'comparison') =>
        m(total('cost_of_sales')[f])
          .add(m(total('operating_expense')[f]))
          .round()
          .toString();
      kpis.push(
        {
          key: 'room_revenue',
          value: roomRevenue(revenue),
          kind: 'money',
          scope: 'period',
          comparison: roomRevenue(revenueBefore),
          definition:
            'Posted room revenue (account 4000) for the period, including nights accrued by the night audit.',
          href: '/reports/revenue',
        },
        {
          key: 'total_revenue',
          value: total('revenue').amount,
          kind: 'money',
          scope: 'period',
          comparison: total('revenue').comparison,
          definition: pl.definitions.revenue ?? '',
          href: '/reports/profit-loss',
        },
        {
          key: 'cash_received',
          value: revenue.receiptsTotal,
          kind: 'money',
          scope: 'period',
          comparison: revenueBefore.receiptsTotal,
          definition: 'Deposits and payments received from guests in the period, less refunds. Not revenue.',
          href: '/reports/revenue',
        },
        {
          key: 'cash_balance',
          value: balances.totals.closing,
          kind: 'money',
          scope: 'balance',
          comparison: null,
          definition: 'Money in the drawers, banks and card account at the end of the period. Not profit.',
          href: '/reports/cashbook',
        },
        {
          key: 'expenses',
          value: cost('amount'),
          kind: 'money',
          scope: 'period',
          comparison: cost('comparison'),
          definition: 'Cost of sales and operating expenses posted for the period.',
          href: '/reports/profit-loss',
        },
        {
          key: 'net_profit',
          value: pl.netProfit.amount,
          kind: 'money',
          scope: 'period',
          comparison: pl.netProfit.comparison,
          definition: pl.definitions.netProfit ?? '',
          href: '/reports/profit-loss',
        },
        {
          key: 'receivables',
          value: receivables.totals.total,
          kind: 'money',
          scope: 'balance',
          comparison: null,
          definition: 'Guest balances still to be paid, less deposits held, at the end of the period.',
          href: '/reports/receivables',
        },
      );
      finance = {
        cashAccounts: balances.accounts.map((a) => ({
          cashAccountId: a.cashAccountId,
          name: a.name,
          kind: a.kind,
          balance: a.closing,
        })),
        todayReceipts: todayCash.totals.receipts,
        todayPayments: todayCash.totals.payments,
        pendingExpenseApprovals: context.counts.pending_expenses,
        draftJournals: context.counts.drafts,
        unresolvedBalances: receivables.guests
          .flatMap((g) => g.folios.map((f) => ({ ...f, guestName: g.guestName })))
          .filter((f) => m(f.balance).isPositive())
          .sort((a, b) => m(b.balance).compare(m(a.balance)))
          .slice(0, 5)
          .map((f) => ({
            reservationId: f.reservationId,
            guestName: f.guestName,
            bookingReference: f.bookingReference,
            balance: f.balance,
            bucket: f.bucket,
          })),
      };
    }

    const guest = (x: (typeof arrivals)[number]) => ({
      reservationId: x.reservationId,
      bookingReference: x.bookingReference,
      guestName: x.guestName,
      roomNumber: x.roomNumber,
      status: x.status,
    });
    return {
      propertyId: pid,
      propertyName: p.name,
      businessDate: today,
      timezone: p.timezone,
      currencyCode: occupancy.currencyCode,
      generatedAt: new Date().toISOString(),
      from,
      to,
      comparisonFrom: cmp.from,
      comparisonTo: cmp.to,
      financial,
      kpis,
      operations: {
        arrivals: arrivals.map(guest),
        departures: departures.map(guest),
        // Guests still to arrive today who have no room yet (04 Frontend §3: reservations arriving without a room).
        unassignedArrivals: arrivals.filter(
          (a) => !a.roomNumber && ['pending', 'confirmed'].includes(a.status),
        ).length,
        roomsToClean: context.dirty.map((r) => ({ roomId: r.id, roomNumber: r.room_number, state: r.state })),
        cashier: {
          openShifts: context.counts.open_shifts,
          awaitingApproval: context.counts.awaiting,
          closings: closings.closings
            .filter((c) => c.status !== 'reopened')
            .map((c) => ({
              shiftId: c.shiftId,
              cashierName: c.cashierName,
              cashAccountName: c.cashAccountName,
              expected: c.expected,
              counted: c.counted,
              variance: c.variance,
              status: c.status,
            })),
        },
      },
      finance,
    };
  }

  /** The financial reports the dashboard reads, started together. */
  private financialReads(
    auth: AuthContext,
    range: { from: string; to: string; propertyId: string },
    cmp: { from: string; to: string },
    today: { from: string; to: string; propertyId: string },
    periodEndsToday: boolean,
  ) {
    const balances = this.cash.cashbook(auth, { from: range.to, to: range.to, propertyId: range.propertyId });
    return Promise.all([
      this.statements.profitLoss(auth, { ...range, compare: 'previous_period' }),
      this.cash.revenue(auth, range),
      this.cash.revenue(auth, { ...cmp, propertyId: range.propertyId }),
      balances,
      // The same query when the period ends today.
      periodEndsToday ? balances : this.cash.cashbook(auth, today),
      this.aging.receivables(auth, { asOf: range.to, propertyId: range.propertyId }),
    ]);
  }
}
