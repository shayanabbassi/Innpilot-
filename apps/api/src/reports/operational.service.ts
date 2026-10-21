import { Injectable } from '@nestjs/common';
import type {
  CashierClosingsDto,
  DiscrepanciesDto,
  ExpensesReportDto,
  MovementsDto,
  OccupancyDto,
  OperationalQuery,
  UserActivityDto,
  UserActivityQuery,
} from '@innpilot/contracts';
import { Decimal, Money } from '@innpilot/money';
import { sql } from 'drizzle-orm';
import type { AuthContext } from '../common/request';
import { Db } from '../db/db.module';
import { ledgerCurrency, notYearEndClose, reportScope, reportTimezone } from './report-scope';

const OCCUPANCY_DEFINITIONS = {
  available: 'Active rooms less rooms out of order that night.',
  sold: 'Before the business date: rooms occupied that night (accrued by the night audit or billed at check-out). From the business date on: rooms booked (on the books).',
  occupancy: 'Rooms sold ÷ rooms available.',
  roomRevenue: 'Posted room revenue (account 4000) for the night, as in the P&L. Not cash received.',
  adr: 'Average daily rate: room revenue ÷ rooms sold (actual nights only).',
  revpar: 'Revenue per available room: room revenue ÷ rooms available (actual nights only).',
};

const MOVEMENT_DEFINITIONS = {
  arrivals: 'Bookings arriving in the dates, with their status (not cancelled).',
  departures: 'Bookings due to leave in the dates, with their status (not cancelled or no-show).',
};

const CASHIER_DEFINITIONS = {
  variance: 'Counted − expected: negative is a shortage, positive an overage.',
  status: 'Submitted closings above the threshold wait for approval; a reopened closing stays as history.',
};

const EXPENSE_DEFINITIONS = {
  amount: 'Posted expenses and supplier bills by expense date; voided ones are left out.',
  tax: 'Purchase tax that is part of the cost (not marked recoverable).',
  recoverableTax: 'Purchase tax marked recoverable, kept on account 1300 and not part of the cost.',
};

const DISCREPANCY_DEFINITIONS = {
  variances: 'Cash closings whose count differed from the expected cash.',
  openingDifferences: 'Shifts opened with a count different from the drawer’s balance in the ledger.',
  cashOutsideShifts: 'Cash taken or paid out of a drawer while no shift was open on it (D11).',
  auditOverrides: 'Night audits closed with open items, and the reason given.',
};

const ACTIVITY_DEFINITIONS = {
  events: 'Entries in the audit log by the user in the dates (property timezone).',
};

/** Operational and exception reports (slice 5.4). */
@Injectable()
export class OperationalReportsService {
  constructor(private readonly db: Db) {}

  occupancy(auth: AuthContext, q: OperationalQuery): Promise<OccupancyDto> {
    const { propertyId } = reportScope(auth, 'report.operational', q.propertyId);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const currency = await ledgerCurrency(tx);
      const { rows } = await tx.execute<{
        night: string;
        actual: boolean;
        rooms: number;
        ooo: number;
        sold: number;
        revenue: string;
      }>(sql`
        -- Revenue and nights sold are aggregated once over the range, then joined to the nights (P5-16: a
        -- lookup per night against a year of lines was the slow part).
        with p as (
          select id, business_date, timezone from properties
          where true ${propertyId ? sql`and id = ${propertyId}` : sql``}
        ),
        nights as (
          select p.id as pid, p.business_date, p.timezone, g::date as night
          from p cross join generate_series(${q.from}::date, ${q.to}::date, interval '1 day') g
        ),
        revenue as (
          select e.property_id as pid, e.accounting_date as night, sum(l.credit - l.debit) as amount
          from journal_lines l
          join journal_entries e on e.id = l.journal_entry_id
          join accounts a on a.id = l.account_id
          where a.system_role = 'room_revenue' and e.status <> 'draft' and ${notYearEndClose}
            and e.accounting_date between ${q.from}::date and ${q.to}::date
            and e.property_id in (select id from p)
          group by 1, 2
        ),
        occupied as (
          select pid, night, count(distinct rr)::int as sold from (
            select a.property_id as pid, a.night, a.reservation_room_id as rr from room_revenue_accruals a
            where a.night between ${q.from}::date and ${q.to}::date and a.property_id in (select id from p)
            union
            select c.property_id, c.night, c.reservation_room_id from room_night_charges c
            join folio_charges fc on fc.id = c.charge_id
            where fc.status <> 'voided' and c.night between ${q.from}::date and ${q.to}::date
              and c.property_id in (select id from p)
          ) x group by 1, 2
        ),
        room_count as (
          select property_id as pid, count(*)::int as rooms from rooms
          where active and property_id in (select id from p) group by 1
        )
        select n.night::text, n.night < n.business_date as actual,
               coalesce(rc.rooms, 0) as rooms,
               (select count(*) from rooms rm where rm.property_id = n.pid and rm.active and exists (
                  select 1 from maintenance_tickets mt
                  where mt.room_id = rm.id and mt.out_of_order_from <= n.night
                    and (mt.out_of_order_to is null or mt.out_of_order_to > n.night)
                    and (mt.status in ('open', 'in_progress')
                         or (mt.status = 'resolved' and n.night < (mt.resolved_at at time zone n.timezone)::date))
               ))::int as ooo,
               (case when n.night < n.business_date then coalesce(o.sold, 0)
                else
                  (select count(*) from reservation_rooms x join reservations r on r.id = x.reservation_id
                   where x.property_id = n.pid and x.status = 'active'
                     and r.status in ('pending', 'confirmed', 'checked_in')
                     and x.arrival <= n.night and x.departure > n.night)::int
                end) as sold,
               coalesce(rv.amount, 0)::text as revenue
        from nights n
        left join room_count rc on rc.pid = n.pid
        left join occupied o on o.pid = n.pid and o.night = n.night
        left join revenue rv on rv.pid = n.pid and rv.night = n.night
        order by n.night`);

      // One row per night, summed over the properties in scope.
      const byNight = new Map<
        string,
        { actual: boolean; rooms: number; ooo: number; sold: number; revenue: Money }
      >();
      for (const r of rows) {
        const cur = byNight.get(r.night) ?? {
          actual: true,
          rooms: 0,
          ooo: 0,
          sold: 0,
          revenue: Money.zero(currency),
        };
        byNight.set(r.night, {
          actual: cur.actual && r.actual,
          rooms: cur.rooms + r.rooms,
          ooo: cur.ooo + r.ooo,
          sold: cur.sold + r.sold,
          revenue: cur.revenue.add(Money.fromStorage(r.revenue, currency)),
        });
      }
      const ratios = (available: number, sold: number, revenue: Money, actual: boolean) => ({
        occupancy: available > 0 ? new Decimal(sold).times(100).div(available).toFixed(1) : null,
        adr: actual && sold > 0 ? revenue.toDecimal().div(sold).toFixed(2) : null,
        revpar: actual && available > 0 ? revenue.toDecimal().div(available).toFixed(2) : null,
      });
      let tAvail = 0;
      let tSold = 0;
      let tRevenue = Money.zero(currency);
      const nights = [...byNight].map(([night, v]) => {
        const available = Math.max(v.rooms - v.ooo, 0);
        if (v.actual) {
          tAvail += available;
          tSold += v.sold;
          tRevenue = tRevenue.add(v.revenue);
        }
        return {
          night,
          basis: v.actual ? ('actual' as const) : ('on_the_books' as const),
          rooms: v.rooms,
          outOfService: v.ooo,
          available,
          sold: v.sold,
          roomRevenue: v.revenue.round().toString(),
          ...ratios(available, v.sold, v.revenue, v.actual),
        };
      });

      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: OCCUPANCY_DEFINITIONS,
        from: q.from,
        to: q.to,
        nights,
        totals: {
          available: tAvail,
          sold: tSold,
          roomRevenue: tRevenue.round().toString(),
          ...ratios(tAvail, tSold, tRevenue, true),
        },
      };
    });
  }

  movements(auth: AuthContext, q: OperationalQuery): Promise<MovementsDto> {
    const { propertyId } = reportScope(auth, 'report.operational', q.propertyId);
    return this.db.tenant(auth.tenantId, async (tx) => {
      type Row = {
        reservation_id: string;
        property_id: string;
        booking_reference: string;
        guest_name: string;
        room_number: string | null;
        room_type: string;
        arrival: string;
        departure: string;
        nights: number;
        adults: number;
        status: string;
      };
      const list = (column: 'arrival' | 'departure', statuses: string[]) =>
        tx.execute<Row>(sql`
          select r.id as reservation_id, r.property_id, r.booking_reference, g.full_name as guest_name,
                 rm.room_number::text as room_number, rt.name as room_type, x.arrival::text, x.departure::text,
                 (x.departure - x.arrival)::int as nights, x.adults, r.status
          from reservation_rooms x
          join reservations r on r.id = x.reservation_id
          join guests g on g.id = r.guest_id
          join room_types rt on rt.id = x.room_type_id
          left join rooms rm on rm.id = x.room_id
          where x.status = 'active' and x.${sql.raw(column)} between ${q.from}::date and ${q.to}::date
            and r.status in (${sql.join(
              statuses.map((s) => sql`${s}`),
              sql`, `,
            )})
            ${propertyId ? sql`and r.property_id = ${propertyId}` : sql``}
          order by x.${sql.raw(column)}, r.booking_reference`);
      const map = (r: Row) => ({
        reservationId: r.reservation_id,
        propertyId: r.property_id,
        bookingReference: r.booking_reference,
        guestName: r.guest_name,
        roomNumber: r.room_number,
        roomType: r.room_type,
        arrival: r.arrival,
        departure: r.departure,
        nights: r.nights,
        adults: r.adults,
        status: r.status,
      });
      const arrivals = await list('arrival', [
        'pending',
        'confirmed',
        'checked_in',
        'checked_out',
        'no_show',
      ]);
      const departures = await list('departure', ['pending', 'confirmed', 'checked_in', 'checked_out']);
      return {
        propertyId,
        currencyCode: await ledgerCurrency(tx),
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: MOVEMENT_DEFINITIONS,
        from: q.from,
        to: q.to,
        arrivals: arrivals.rows.map(map),
        departures: departures.rows.map(map),
      };
    });
  }

  cashierClosings(auth: AuthContext, q: OperationalQuery): Promise<CashierClosingsDto> {
    const { propertyId } = reportScope(auth, 'report.operational', q.propertyId);
    // Supervisors see every cashier; anyone else sees only their own closings.
    const sees = (perms: Set<string> | undefined) =>
      !!perms && (perms.has('cashier.approve') || perms.has('journal.read'));
    const allCashiers = propertyId
      ? sees(auth.permissionsByProperty.get(propertyId))
      : sees(auth.tenantWidePermissions);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const currency = await ledgerCurrency(tx);
      const m = (v: string) => Money.fromStorage(v, currency);
      const { rows } = await tx.execute<{
        id: string;
        shift_id: string;
        property_id: string;
        business_date: string;
        cashier: string;
        drawer: string;
        expected: string;
        counted: string;
        variance: string;
        explanation: string | null;
        status: 'submitted' | 'approved' | 'reopened';
        approval_required: boolean;
        approver: string | null;
        approval_note: string | null;
        reopen_reason: string | null;
      }>(sql`
        select c.id, c.shift_id, c.property_id, c.business_date::text, u.full_name as cashier, ca.name as drawer,
               c.expected_amount::text as expected, c.counted_amount::text as counted, c.variance::text,
               c.explanation, c.status, c.approval_required, ap.full_name as approver, c.approval_note, c.reopen_reason
        from cash_closings c
        join cashier_shifts s on s.id = c.shift_id
        join users u on u.id = s.user_id
        join cash_accounts ca on ca.id = c.cash_account_id
        left join users ap on ap.id = c.approved_by
        where c.business_date between ${q.from}::date and ${q.to}::date
          ${propertyId ? sql`and c.property_id = ${propertyId}` : sql``}
          ${allCashiers ? sql`` : sql`and s.user_id = ${auth.userId}`}
        order by c.business_date, c.submitted_at`);
      const zero = Money.zero(currency);
      let shortages = zero;
      let overages = zero;
      for (const r of rows) {
        if (r.status === 'reopened') continue;
        const v = m(r.variance);
        if (v.isNegative()) shortages = shortages.add(v.negate());
        else overages = overages.add(v);
      }
      const s = (v: Money) => v.round().toString();
      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: CASHIER_DEFINITIONS,
        from: q.from,
        to: q.to,
        allCashiers,
        closings: rows.map((r) => ({
          closingId: r.id,
          shiftId: r.shift_id,
          propertyId: r.property_id,
          businessDate: r.business_date,
          cashierName: r.cashier,
          cashAccountName: r.drawer,
          expected: s(m(r.expected)),
          counted: s(m(r.counted)),
          variance: s(m(r.variance)),
          explanation: r.explanation,
          status: r.status,
          approvalRequired: r.approval_required,
          approvedByName: r.approver,
          approvalNote: r.approval_note,
          reopenReason: r.reopen_reason,
        })),
        totals: {
          closings: rows.filter((r) => r.status !== 'reopened').length,
          shortages: s(shortages),
          overages: s(overages),
          net: s(overages.subtract(shortages)),
          awaitingApproval: rows.filter((r) => r.status === 'submitted' && r.approval_required).length,
        },
      };
    });
  }

  expenses(auth: AuthContext, q: OperationalQuery): Promise<ExpensesReportDto> {
    const { propertyId } = reportScope(auth, 'report.financial', q.propertyId);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const currency = await ledgerCurrency(tx);
      const m = (v: string | null | undefined) => Money.fromStorage(v ?? '0', currency);
      const s = (v: Money) => v.round().toString();
      // Posted vouchers: a cash expense is posted when paid, a bill on approval; voids are left out.
      const posted = sql`
        select v.* from expense_vouchers v
        where v.journal_entry_id is not null and v.status <> 'void'
          and v.expense_date between ${q.from}::date and ${q.to}::date
          ${propertyId ? sql`and v.property_id = ${propertyId}` : sql``}`;
      const byAccount = await tx.execute<{
        id: string;
        code: string;
        name: string;
        amount: string;
        tax: string;
      }>(sql`
        select a.id, a.code, a.name, sum(l.amount)::text as amount,
               coalesce(sum(l.tax_amount) filter (where not l.tax_recoverable), 0)::text as tax
        from (${posted}) v join expense_lines l on l.voucher_id = v.id join accounts a on a.id = l.account_id
        group by a.id order by a.code`);
      const byPayee = await tx.execute<{
        supplier_id: string | null;
        name: string;
        cash: string;
        bills: string;
        vouchers: number;
      }>(sql`
        select v.supplier_id, coalesce(sp.name, v.payee, '—') as name,
               coalesce(sum(v.total_amount) filter (where v.kind = 'cash'), 0)::text as cash,
               coalesce(sum(v.total_amount) filter (where v.kind = 'bill'), 0)::text as bills,
               count(*)::int as vouchers
        from (${posted}) v left join suppliers sp on sp.id = v.supplier_id
        group by v.supplier_id, coalesce(sp.name, v.payee, '—')
        order by 2`);
      const recoverable = await tx.execute<{ r: string }>(sql`
        select coalesce(sum(l.tax_amount) filter (where l.tax_recoverable), 0)::text as r
        from (${posted}) v join expense_lines l on l.voucher_id = v.id`);
      const accounts = byAccount.rows.map((r) => ({
        accountId: r.id,
        code: r.code,
        name: r.name,
        amount: s(m(r.amount)),
        tax: s(m(r.tax)),
        total: s(m(r.amount).add(m(r.tax))),
      }));
      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: EXPENSE_DEFINITIONS,
        from: q.from,
        to: q.to,
        byAccount: accounts,
        byPayee: byPayee.rows.map((r) => ({
          supplierId: r.supplier_id,
          name: r.name,
          cash: s(m(r.cash)),
          bills: s(m(r.bills)),
          total: s(m(r.cash).add(m(r.bills))),
          vouchers: r.vouchers,
        })),
        total: s(
          Money.sum(
            accounts.map((a) => m(a.total)),
            currency,
          ),
        ),
        recoverableTax: s(m(recoverable.rows[0]!.r)),
      };
    });
  }

  discrepancies(auth: AuthContext, q: OperationalQuery): Promise<DiscrepanciesDto> {
    const { propertyId } = reportScope(auth, 'report.financial', q.propertyId);
    const onProperty = (alias: string) =>
      propertyId ? sql`and ${sql.raw(alias)}.property_id = ${propertyId}` : sql``;
    return this.db.tenant(auth.tenantId, async (tx) => {
      const currency = await ledgerCurrency(tx);
      const m = (v: string) => Money.fromStorage(v, currency);
      const s = (v: Money) => v.round().toString();
      const variances = await tx.execute<{
        shift_id: string;
        business_date: string;
        cashier: string;
        drawer: string;
        variance: string;
        explanation: string | null;
        status: string;
      }>(sql`
        select c.shift_id, c.business_date::text, u.full_name as cashier, ca.name as drawer, c.variance::text,
               c.explanation, c.status
        from cash_closings c join cashier_shifts sh on sh.id = c.shift_id
        join users u on u.id = sh.user_id join cash_accounts ca on ca.id = c.cash_account_id
        where c.variance <> 0 and c.status <> 'reopened'
          and c.business_date between ${q.from}::date and ${q.to}::date ${onProperty('c')}
        order by c.business_date, c.submitted_at`);
      const openings = await tx.execute<{
        id: string;
        business_date: string;
        cashier: string;
        drawer: string;
        counted: string;
        book: string;
      }>(sql`
        select sh.id, sh.business_date::text, u.full_name as cashier, ca.name as drawer,
               sh.opening_count::text as counted, sh.book_balance_at_open::text as book
        from cashier_shifts sh join users u on u.id = sh.user_id join cash_accounts ca on ca.id = sh.cash_account_id
        where sh.opening_count <> sh.book_balance_at_open
          and sh.business_date between ${q.from}::date and ${q.to}::date ${onProperty('sh')}
        order by sh.business_date, sh.opened_at`);
      const outside = await tx.execute<{
        id: string;
        journal_number: string;
        d: string;
        narration: string;
        drawer: string;
        dr: string;
        cr: string;
      }>(sql`
        select e.id, e.journal_number, e.accounting_date::text as d, e.narration, ca.name as drawer,
               sum(l.debit)::text as dr, sum(l.credit)::text as cr
        from journal_lines l
        join journal_entries e on e.id = l.journal_entry_id
        join cash_accounts ca on ca.id = l.cash_account_id
        where ca.kind = 'cash' and l.cashier_shift_id is null and e.status <> 'draft'
          and e.source_type not in ('opening_balance', 'cash_closing')
          and not exists (select 1 from journal_entries o
                            where o.id = e.reverses_entry_id and o.source_type = 'cash_closing')
          and e.accounting_date between ${q.from}::date and ${q.to}::date ${onProperty('e')}
        group by e.id, ca.name
        order by e.accounting_date, e.journal_number`);
      const overrides = await tx.execute<{
        business_date: string;
        reason: string;
        issues: number;
        closed_by: string;
      }>(sql`
        select c.business_date::text, c.reason, jsonb_array_length(c.unresolved)::int as issues, u.full_name as closed_by
        from business_date_closes c join users u on u.id = c.closed_by
        where c.reason is not null and jsonb_array_length(c.unresolved) > 0
          and c.business_date between ${q.from}::date and ${q.to}::date ${onProperty('c')}
        order by c.business_date`);

      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: DISCREPANCY_DEFINITIONS,
        from: q.from,
        to: q.to,
        variances: variances.rows.map((r) => ({
          shiftId: r.shift_id,
          businessDate: r.business_date,
          cashierName: r.cashier,
          cashAccountName: r.drawer,
          variance: s(m(r.variance)),
          explanation: r.explanation,
          status: r.status,
        })),
        openingDifferences: openings.rows.map((r) => ({
          shiftId: r.id,
          businessDate: r.business_date,
          cashierName: r.cashier,
          cashAccountName: r.drawer,
          openingCount: s(m(r.counted)),
          bookBalance: s(m(r.book)),
          difference: s(m(r.counted).subtract(m(r.book))),
        })),
        cashOutsideShifts: outside.rows.map((r) => ({
          entryId: r.id,
          journalNumber: Number(r.journal_number),
          accountingDate: r.d,
          narration: r.narration,
          cashAccountName: r.drawer,
          amountIn: s(m(r.dr)),
          amountOut: s(m(r.cr)),
        })),
        auditOverrides: overrides.rows.map((r) => ({
          businessDate: r.business_date,
          reason: r.reason,
          issues: r.issues,
          closedByName: r.closed_by,
        })),
      };
    });
  }

  userActivity(auth: AuthContext, q: UserActivityQuery): Promise<UserActivityDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const timezone = await reportTimezone(tx, null);
      const tz = timezone ?? 'UTC';
      // Hotel dates in the property timezone, turned into the matching instants.
      const range = sql`ev.occurred_at >= (${q.from}::date)::timestamp at time zone ${tz}
                    and ev.occurred_at < (${q.to}::date + 1)::timestamp at time zone ${tz}`;
      const users = await tx.execute<{
        user_id: string | null;
        name: string;
        events: number;
        sign_ins: number;
        failed: number;
        first_at: string;
        last_at: string;
      }>(sql`
        select ev.actor_user_id as user_id, coalesce(u.full_name, 'System') as name, count(*)::int as events,
               (count(*) filter (where ev.action = 'auth.login'))::int as sign_ins,
               (count(*) filter (where ev.action in ('auth.login_failed', 'auth.account_locked')))::int as failed,
               min(ev.occurred_at) as first_at, max(ev.occurred_at) as last_at
        from audit_events ev left join users u on u.id = ev.actor_user_id
        where ${range}
        group by ev.actor_user_id, u.full_name
        order by count(*) desc, 2`);
      const actions = await tx.execute<{ user_id: string | null; action: string; n: number }>(sql`
        select ev.actor_user_id as user_id, ev.action, count(*)::int as n
        from audit_events ev where ${range}
        group by 1, 2 order by 3 desc, 2`);
      const iso = (v: string | Date) => new Date(v).toISOString();
      return {
        propertyId: null,
        currencyCode: await ledgerCurrency(tx),
        timezone,
        generatedAt: new Date().toISOString(),
        definitions: ACTIVITY_DEFINITIONS,
        from: q.from,
        to: q.to,
        users: users.rows.map((r) => ({
          userId: r.user_id,
          name: r.name,
          events: r.events,
          signIns: r.sign_ins,
          failedSignIns: r.failed,
          firstAt: iso(r.first_at),
          lastAt: iso(r.last_at),
          topActions: actions.rows
            .filter((a) => a.user_id === r.user_id)
            .slice(0, 5)
            .map((a) => ({ action: a.action, count: a.n })),
        })),
        totalEvents: users.rows.reduce((n, r) => n + r.events, 0),
      };
    });
  }
}
