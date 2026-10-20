import { Injectable } from '@nestjs/common';
import {
  addDays,
  type DayCloseDto,
  type DayCloseIssueDto,
  type DayClosePreviewDto,
  type DayCloseRequest,
  type NightAuditSummaryDto,
  type NoShowDepositDto,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { FolioService } from '../finance/folio.service';
import { PaymentService } from '../finance/payment.service';
import { ledgerErrors, PostingService } from '../finance/posting.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

const r = schema.reservations;
const rr = schema.reservationRooms;
const rooms = schema.rooms;
const tickets = schema.maintenanceTickets;
const closes = schema.businessDateCloses;
const accruals = schema.roomRevenueAccruals;
type PropertyRow = typeof schema.properties.$inferSelect;

interface NightToAccrue {
  date: string;
  reservationRoomId: string;
  net: Money;
}

/**
 * The night audit (P4-9), replacing the interim day close (D3) on the same once-per-date record (OPS-004): a unique
 * key per property and date, the expected-date check and a property row lock. In one transaction it
 *   - marks remaining arrivals as no-shows when asked, with a refund-or-keep decision for any deposit they hold;
 *   - lists what is still open (arrivals, overstays, rooms not clean, open tasks, open cashier shifts); anything open
 *     needs a reason, recorded as an override;
 *   - accrues each room night slept tonight (D9): Dr Unbilled guest revenue, Cr room revenue, net of tax, keyed by
 *     booked room and night so no night is ever accrued twice;
 *   - stores a summary read from the ledger and the source records, and advances the business date by one day.
 */
@Injectable()
export class DayCloseService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly posting: PostingService,
    private readonly folios: FolioService,
    private readonly payments: PaymentService,
  ) {}

  preview(auth: AuthContext, propertyId: string): Promise<DayClosePreviewDto> {
    return this.db.tenant(auth.tenantId, async (tx) => this.assess(tx, await this.property(tx, propertyId)));
  }

  history(auth: AuthContext, propertyId: string): Promise<DayCloseDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const rows = await tx
        .select({ c: closes, name: schema.users.fullName })
        .from(closes)
        .leftJoin(schema.users, eq(schema.users.id, closes.closedBy))
        .where(eq(closes.propertyId, propertyId))
        .orderBy(desc(closes.businessDate))
        .limit(30);
      return rows.map(({ c, name }) => this.dto(c, name));
    });
  }

  close(
    auth: AuthContext,
    propertyId: string,
    body: DayCloseRequest,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
    scope = `POST /properties/${propertyId}/night-audit`,
  ): Promise<{ status: number; body: DayCloseDto }> {
    return this.mapDuplicate(() =>
      ledgerErrors(() =>
        this.db.tenant(auth.tenantId, (tx) =>
          this.idempotency.run(
            tx,
            { tenantId: auth.tenantId, actorUserId: auth.userId, scope, key: idempotencyKey, body },
            async () => {
              // The property row lock serialises audits; the expected date stops a second run from another screen.
              const [property] = await tx
                .select()
                .from(schema.properties)
                .where(eq(schema.properties.id, propertyId))
                .for('update');
              if (!property) throw AppError.notFound('property');
              if (property.businessDate !== body.businessDate) {
                throw new AppError(
                  'CONFLICT',
                  `${body.businessDate} is already closed. The business date is now ${property.businessDate}.`,
                );
              }
              const today = property.businessDate;
              const next = addDays(today, 1);

              let noShows = 0;
              if (body.markNoShows) {
                noShows = await this.markNoShows(tx, auth, property, body.deposits, meta);
              }
              const preview = await this.assess(tx, property);
              const unresolved = preview.issues;
              if (unresolved.length > 0 && !body.reason) {
                throw new AppError(
                  'CONFLICT',
                  'Some items are still open. Resolve them, or give a reason to close the day anyway.',
                  unresolved.map((i) => ({ path: i.check, message: i.label })),
                );
              }

              const accrued = await this.accrue(tx, auth, property);
              const summary = await this.summary(tx, property, accrued);
              const [row] = await tx
                .insert(closes)
                .values({
                  tenantId: auth.tenantId,
                  propertyId,
                  businessDate: today,
                  nextDate: next,
                  noShowsMarked: noShows,
                  unresolved,
                  reason: unresolved.length > 0 ? body.reason! : (body.reason ?? null),
                  snapshot: {
                    inHouse: preview.counts.inHouse,
                    arrivalsCheckedIn: preview.counts.arrivalsCheckedIn,
                    sellableRooms: preview.counts.sellableRooms,
                  },
                  kind: 'night_audit',
                  summary,
                  closedBy: auth.userId,
                })
                .returning();
              await tx
                .update(schema.properties)
                .set({ businessDate: next })
                .where(eq(schema.properties.id, propertyId));
              await this.applyServiceChanges(tx, auth, propertyId, next);
              await this.audit.record(
                tx,
                {
                  tenantId: auth.tenantId,
                  propertyId,
                  actor: { type: 'user', userId: auth.userId },
                  action: 'property.day_closed',
                  entityType: 'property',
                  entityId: propertyId,
                  changes: {
                    businessDate: today,
                    nextDate: next,
                    noShowsMarked: noShows,
                    unresolved: unresolved.length,
                    accruedNights: accrued.nights,
                    accruedNet: accrued.net,
                  },
                  reason: body.reason ?? null,
                },
                meta,
              );
              const [name] = await tx
                .select({ n: schema.users.fullName })
                .from(schema.users)
                .where(eq(schema.users.id, auth.userId));
              return { status: 200, body: this.dto(row!, name?.n ?? null) };
            },
          ),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------------------------------- checks

  private async assess(tx: Tx, property: PropertyRow): Promise<DayClosePreviewDto> {
    const today = property.businessDate;
    const next = addDays(today, 1);
    const issues: DayCloseIssueDto[] = [];

    // Arrivals due today (or earlier) not checked in.
    const due = await tx
      .select({ booked: rr, ref: r.bookingReference, guest: schema.guests.fullName })
      .from(rr)
      .innerJoin(r, eq(r.id, rr.reservationId))
      .innerJoin(schema.guests, eq(schema.guests.id, r.guestId))
      .where(
        and(
          eq(rr.propertyId, property.id),
          eq(rr.status, 'active'),
          isNull(rr.stayId),
          inArray(r.status, ['pending', 'confirmed']),
          lte(rr.arrival, today),
        ),
      );
    for (const d of due) {
      issues.push({
        check: 'arrivals_pending',
        label: d.ref,
        detail: d.guest,
        reservationId: d.booked.reservationId,
        roomId: d.booked.roomId,
      });
    }
    const noShowDeposits: NoShowDepositDto[] = [];
    for (const res of new Map(due.map((d) => [d.booked.reservationId, d])).values()) {
      const held = await this.payments.depositHeld(tx, property, res.booked.reservationId);
      if (held.isPositive()) {
        noShowDeposits.push({
          reservationId: res.booked.reservationId,
          bookingReference: res.ref,
          guestName: res.guest,
          held: held.toString(),
        });
      }
    }

    // In-house guests whose stay ends today or earlier without a check-out.
    const stays = await tx
      .select({
        reservationId: schema.stays.reservationId,
        ref: r.bookingReference,
        departure: sql<string>`max(${rr.departure})::text`,
        roomId: sql<
          string | null
        >`(select sr.room_id from stay_rooms sr where sr.stay_id = ${schema.stays.id} and sr.ended_at is null)`,
      })
      .from(schema.stays)
      .innerJoin(r, eq(r.id, schema.stays.reservationId))
      .innerJoin(rr, and(eq(rr.stayId, schema.stays.id), eq(rr.status, 'active')))
      .where(and(eq(schema.stays.propertyId, property.id), eq(schema.stays.status, 'in_house')))
      .groupBy(schema.stays.id, schema.stays.reservationId, r.bookingReference);
    for (const s of stays.filter((x) => x.departure <= today)) {
      issues.push({
        check: 'overstays',
        label: s.ref,
        detail: `Due out ${s.departure}`,
        reservationId: s.reservationId,
        roomId: s.roomId,
      });
    }

    const notClean = await tx
      .select({ id: rooms.id, number: rooms.roomNumber, state: rooms.housekeepingState })
      .from(rooms)
      .where(
        and(
          eq(rooms.propertyId, property.id),
          eq(rooms.active, true),
          inArray(rooms.housekeepingState, ['dirty', 'cleaning']),
        ),
      );
    for (const n of notClean) {
      issues.push({
        check: 'rooms_not_clean',
        label: n.number,
        detail: n.state,
        reservationId: null,
        roomId: n.id,
      });
    }

    const [openTasks] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.housekeepingTasks)
      .where(
        and(
          eq(schema.housekeepingTasks.propertyId, property.id),
          inArray(schema.housekeepingTasks.status, ['open', 'in_progress']),
        ),
      );
    // Rooms already listed as not clean explain their own cleaning tasks; only report other open work.
    const extraTasks = Math.max(0, (openTasks?.n ?? 0) - notClean.length);
    if (extraTasks > 0) {
      issues.push({
        check: 'open_tasks',
        label: String(extraTasks),
        detail: null,
        reservationId: null,
        roomId: null,
      });
    }

    // Cashier shifts still open (P4-9): the day's cash is not counted yet.
    const shifts = await tx
      .select({ drawer: schema.cashAccounts.name, cashier: schema.users.fullName })
      .from(schema.cashierShifts)
      .innerJoin(schema.cashAccounts, eq(schema.cashAccounts.id, schema.cashierShifts.cashAccountId))
      .innerJoin(schema.users, eq(schema.users.id, schema.cashierShifts.userId))
      .where(and(eq(schema.cashierShifts.propertyId, property.id), eq(schema.cashierShifts.status, 'open')));
    for (const s of shifts) {
      issues.push({
        check: 'open_shifts',
        label: s.drawer,
        detail: s.cashier,
        reservationId: null,
        roomId: null,
      });
    }

    const [checkedIn] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.stayRooms)
      .where(
        and(
          eq(schema.stayRooms.propertyId, property.id),
          eq(schema.stayRooms.fromDate, today),
          isNull(schema.stayRooms.reason),
        ),
      );
    const [sellable] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(rooms)
      .where(
        and(eq(rooms.propertyId, property.id), eq(rooms.active, true), eq(rooms.serviceState, 'in_service')),
      );

    const toAccrue = await this.nightsToAccrue(tx, property);
    const accrualPreview = {
      nights: toAccrue.length,
      net: Money.sum(
        toAccrue.map((n) => n.net),
        property.currencyCode,
      ).toString(),
    };
    return {
      businessDate: today,
      nextDate: next,
      issues,
      serviceChanges: await this.serviceChanges(tx, property.id, next),
      counts: {
        inHouse: stays.length,
        arrivalsCheckedIn: checkedIn?.n ?? 0,
        arrivalsPending: due.length,
        sellableRooms: sellable?.n ?? 0,
      },
      noShowDeposits,
      accruals: accrualPreview,
      summary: await this.summary(tx, property, {
        nights: 0,
        net: Money.zero(property.currencyCode).toString(),
      }),
    };
  }

  // ------------------------------------------------------------------------------------------- accrual (D9)

  /** Room nights slept up to and including the business date, in house, not yet accrued and not yet billed. */
  private async nightsToAccrue(tx: Tx, property: PropertyRow): Promise<NightToAccrue[]> {
    const inHouse = await tx
      .selectDistinct({ id: schema.stays.reservationId })
      .from(schema.stays)
      .where(and(eq(schema.stays.propertyId, property.id), eq(schema.stays.status, 'in_house')));
    const out: NightToAccrue[] = [];
    for (const res of inHouse) {
      const { pending } = await this.folios.nights(tx, property, res.id, property.businessDate);
      for (const n of pending) {
        if (n.net.isPositive())
          out.push({ date: n.date, reservationRoomId: n.reservationRoomId, net: n.net });
      }
    }
    if (out.length === 0) return out;
    const done = await tx
      .select({ rr: accruals.reservationRoomId, night: accruals.night })
      .from(accruals)
      .where(inArray(accruals.reservationRoomId, [...new Set(out.map((n) => n.reservationRoomId))]));
    const seen = new Set(done.map((d) => `${d.rr}|${d.night}`));
    return out.filter((n) => !seen.has(`${n.reservationRoomId}|${n.date}`));
  }

  /**
   * Posts the accrual: one journal per night date (normally just tonight; earlier nights only if an audit was ever
   * skipped), Dr Unbilled guest revenue / Cr room revenue, and records each night so it is never accrued again.
   */
  private async accrue(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
  ): Promise<{ nights: number; net: string }> {
    const nights = await this.nightsToAccrue(tx, property);
    const cur = property.currencyCode;
    if (nights.length === 0) return { nights: 0, net: Money.zero(cur).toString() };
    const [category] = await tx
      .select({ revenue: schema.chargeCategories.revenueAccountId })
      .from(schema.chargeCategories)
      .where(
        and(
          eq(schema.chargeCategories.propertyId, property.id),
          eq(schema.chargeCategories.systemKind, 'room'),
        ),
      );
    const [unbilled] = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.systemRole, 'unbilled_revenue'));
    if (!category || !unbilled) throw AppError.notFound('room revenue or unbilled revenue account');
    const byDate = new Map<string, NightToAccrue[]>();
    for (const n of nights) byDate.set(n.date, [...(byDate.get(n.date) ?? []), n]);
    let total = Money.zero(cur);
    for (const [date, group] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
      const net = Money.sum(
        group.map((n) => n.net),
        cur,
      );
      const journalId = await this.posting.post(tx, auth, {
        propertyId: property.id,
        accountingDate: date,
        sourceType: 'night_audit',
        reference: `Night audit ${property.businessDate}`,
        narration: `Room revenue earned, night of ${date} (${group.length} ${group.length === 1 ? 'room' : 'rooms'}), billed at check-out`,
        lines: [
          { accountId: unbilled.id, debit: net.toString(), credit: '0' },
          { accountId: category.revenue, debit: '0', credit: net.toString() },
        ],
      });
      await tx.insert(accruals).values(
        group.map((n) => ({
          tenantId: auth.tenantId,
          propertyId: property.id,
          reservationRoomId: n.reservationRoomId,
          night: n.date,
          businessDate: property.businessDate,
          netAmount: n.net.toStorage(),
          revenueAccountId: category.revenue,
          journalEntryId: journalId,
        })),
      );
      total = total.add(net);
    }
    return { nights: nights.length, net: total.toString() };
  }

  // ------------------------------------------------------------------------------------------- summary

  private async summary(
    tx: Tx,
    property: PropertyRow,
    accrued: { nights: number; net: string },
  ): Promise<NightAuditSummaryDto> {
    const cur = property.currencyCode;
    const m = (v: string | null | undefined) => Money.fromStorage(v ?? '0', cur).round();
    const date = property.businessDate;
    const q = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
      (await tx.execute<T>(query)).rows;

    const revenue = await q<{ code: string; name: string; amount: string }>(sql`
      select a.code, a.name, sum(l.credit - l.debit)::text as amount
      from journal_lines l join journal_entries e on e.id = l.journal_entry_id join accounts a on a.id = l.account_id
      where e.property_id = ${property.id} and e.status <> 'draft' and e.accounting_date = ${date}::date
        and a.account_class = 'revenue'
      group by a.code, a.name having sum(l.credit - l.debit) <> 0 order by a.code`);
    const revenueTotal = Money.sum(
      revenue.map((x) => m(x.amount)),
      cur,
    );

    const [occupied] = await q<{ n: number }>(sql`
      select count(distinct sr.room_id)::int as n from stay_rooms sr join stays s on s.id = sr.stay_id
      where s.property_id = ${property.id} and s.status = 'in_house' and sr.ended_at is null`);
    const [sellable] = await q<{ n: number }>(sql`
      select count(*)::int as n from rooms
      where property_id = ${property.id} and active and service_state = 'in_service'`);
    const [arrivals] = await q<{ n: number }>(sql`
      select count(*)::int as n from stay_rooms
      where property_id = ${property.id} and from_date = ${date}::date and reason is null`);
    const [inHouse] = await q<{ n: number }>(sql`
      select count(*)::int as n from stays where property_id = ${property.id} and status = 'in_house'`);
    // Departures since the previous close (check-out time is a timestamp; the business date is the property's).
    const [departures] = await q<{ n: number }>(sql`
      select count(*)::int as n from stays s
      where s.property_id = ${property.id} and s.status = 'checked_out'
        and s.checked_out_at > coalesce((select max(c.closed_at) from business_date_closes c
                                         where c.property_id = ${property.id}), '-infinity'::timestamptz)`);

    const receipts = await q<{ method: string; amount: string }>(sql`
      select method, sum(amount)::text as amount from payments
      where property_id = ${property.id} and business_date = ${date}::date group by method order by method`);
    const [refunds] = await q<{ amount: string | null }>(sql`
      select sum(amount)::text as amount from refunds where property_id = ${property.id} and business_date = ${date}::date`);

    const variances = await q<{ drawer: string; cashier: string; variance: string; status: string }>(sql`
      select ca.name as drawer, u.full_name as cashier, c.variance::text as variance, c.status
      from cash_closings c join cashier_shifts s on s.id = c.shift_id
      join cash_accounts ca on ca.id = c.cash_account_id join users u on u.id = s.user_id
      where c.property_id = ${property.id} and c.business_date = ${date}::date and c.status <> 'reopened'
        and c.variance <> 0
      order by c.submitted_at`);
    const [outside] = await q<{ n: number; i: string | null; o: string | null }>(sql`
      select count(*)::int as n, sum(l.debit)::text as i, sum(l.credit)::text as o
      from journal_lines l join journal_entries e on e.id = l.journal_entry_id
      join cash_accounts ca on ca.id = l.cash_account_id
      where e.property_id = ${property.id} and e.status <> 'draft' and e.accounting_date = ${date}::date
        and ca.kind = 'cash' and l.cashier_shift_id is null
        and e.source_type not in ('opening_balance', 'cash_closing', 'reversal')`);

    const onAccount = await q<{ id: string }>(sql`
      select id from folios where property_id = ${property.id} and status = 'on_account'`);
    let onAccountBalance = Money.zero(cur);
    for (const f of onAccount) {
      const [b] = await q<{ b: string }>(sql`
        select coalesce(sum(l.debit - l.credit), 0)::text as b from journal_lines l
        join journal_entries e on e.id = l.journal_entry_id join accounts a on a.id = l.account_id
        where l.folio_id = ${f.id} and a.system_role in ('guest_receivable', 'guest_deposits') and e.status <> 'draft'`);
      onAccountBalance = onAccountBalance.add(m(b?.b));
    }

    const closed = await q<{ id: string }>(sql`
      select id from reservations where property_id = ${property.id} and status in ('cancelled', 'no_show')`);
    let toRefund = Money.zero(cur);
    let toRefundCount = 0;
    for (const res of closed) {
      const held = await this.payments.depositHeld(tx, property, res.id);
      if (held.isPositive()) {
        toRefund = toRefund.add(held);
        toRefundCount += 1;
      }
    }

    const occ = occupied?.n ?? 0;
    const sell = sellable?.n ?? 0;
    return {
      revenue: revenue.map((x) => ({
        accountCode: x.code,
        accountName: x.name,
        amount: m(x.amount).toString(),
      })),
      revenueTotal: revenueTotal.toString(),
      accrued,
      occupancy: {
        occupied: occ,
        sellable: sell,
        percent: sell > 0 ? ((occ * 1000) / sell / 10).toFixed(1) : '0.0',
      },
      arrivals: arrivals?.n ?? 0,
      departures: departures?.n ?? 0,
      inHouse: inHouse?.n ?? 0,
      receipts: receipts.map((x) => ({ method: x.method, amount: m(x.amount).toString() })),
      refunds: m(refunds?.amount).toString(),
      cashierVariances: variances.map((v) => ({ ...v, variance: m(v.variance).toString() })),
      cashOutsideShift: {
        lines: outside?.n ?? 0,
        in: m(outside?.i).toString(),
        out: m(outside?.o).toString(),
      },
      foliosOnAccount: { count: onAccount.length, balance: onAccountBalance.toString() },
      depositsToRefund: { count: toRefundCount, amount: toRefund.toString() },
    };
  }

  // ------------------------------------------------------------------------------------------- rooms and no-shows

  /** Rooms whose service state must change on `date` because an out-of-order period starts or ends. */
  private async serviceChanges(tx: Tx, propertyId: string, date: string) {
    const covering = await tx
      .select({ roomId: tickets.roomId })
      .from(tickets)
      .where(
        and(
          eq(tickets.propertyId, propertyId),
          inArray(tickets.status, ['open', 'in_progress']),
          isNotNull(tickets.outOfOrderFrom),
          lte(tickets.outOfOrderFrom, date),
          or(isNull(tickets.outOfOrderTo), gt(tickets.outOfOrderTo, date)),
        ),
      );
    const out = new Set(covering.map((c) => c.roomId));
    const all = await tx
      .select({ id: rooms.id, number: rooms.roomNumber, state: rooms.serviceState })
      .from(rooms)
      .where(eq(rooms.propertyId, propertyId));
    return all
      .filter((x) => (out.has(x.id) ? x.state !== 'out_of_order' : x.state === 'out_of_order'))
      .map((x) => ({
        roomId: x.id,
        roomNumber: x.number,
        to: out.has(x.id) ? ('out_of_order' as const) : ('in_service' as const),
      }));
  }

  private async applyServiceChanges(tx: Tx, auth: AuthContext, propertyId: string, date: string) {
    for (const change of await this.serviceChanges(tx, propertyId, date)) {
      const from = change.to === 'out_of_order' ? 'in_service' : 'out_of_order';
      await tx.update(rooms).set({ serviceState: change.to }).where(eq(rooms.id, change.roomId));
      await tx.insert(schema.roomStatusEvents).values({
        tenantId: auth.tenantId,
        propertyId,
        roomId: change.roomId,
        dimension: 'service',
        fromState: from,
        toState: change.to,
        reason: `Night audit: out-of-order period ${change.to === 'out_of_order' ? 'starts' : 'ended'}`,
        actorUserId: auth.userId,
      });
    }
  }

  /**
   * Marks arrivals still due as no-shows. A booking holding a deposit needs a decision first (closing the Phase 3
   * known limit): refund it later, or keep it as a fee, which needs folio.adjust.
   */
  private async markNoShows(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    decisions: Record<string, 'refund' | 'forfeit'>,
    meta: RequestMeta,
  ) {
    const today = property.businessDate;
    const due = await tx
      .select({ id: r.id, ref: r.bookingReference })
      .from(r)
      .where(
        and(
          eq(r.propertyId, property.id),
          inArray(r.status, ['pending', 'confirmed']),
          sql`exists (select 1 from reservation_rooms x where x.reservation_id = ${r.id} and x.status = 'active'
                        and x.stay_id is null and x.arrival <= ${today}::date)`,
          // A booking with a guest already in house is not a no-show.
          sql`not exists (select 1 from reservation_rooms x where x.reservation_id = ${r.id} and x.stay_id is not null)`,
        ),
      )
      .for('update');
    const held = new Map<string, Money>();
    for (const res of due) {
      const amount = await this.payments.depositHeld(tx, property, res.id);
      if (amount.isPositive()) held.set(res.id, amount);
    }
    const undecided = due.filter((res) => held.has(res.id) && !decisions[res.id]);
    if (undecided.length > 0) {
      throw new AppError(
        'DEPOSIT_HANDLING_REQUIRED',
        'Some no-shows hold a deposit. Choose for each: refund it later, or keep it as a fee.',
        undecided.map((res) => ({
          path: `deposits.${res.id}`,
          message: `${res.ref}: ${held.get(res.id)!.toString()}`,
        })),
      );
    }
    const forfeits = due.filter((res) => held.has(res.id) && decisions[res.id] === 'forfeit');
    if (forfeits.length > 0 && !auth.permissionsByProperty.get(property.id)?.has('folio.adjust')) {
      throw AppError.forbidden('Keeping a deposit as a fee needs permission to adjust folios.');
    }
    for (const res of due) {
      await tx.update(r).set({ status: 'no_show' }).where(eq(r.id, res.id));
      await tx.update(rr).set({ status: 'released' }).where(eq(rr.reservationId, res.id));
      const deposit = held.get(res.id);
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId: property.id,
          actor: { type: 'user', userId: auth.userId },
          action: 'reservation.no_show',
          entityType: 'reservation',
          entityId: res.id,
          changes: deposit ? { deposit: decisions[res.id], depositHeld: deposit.toString() } : {},
          reason: `Marked at the night audit for ${today}`,
        },
        meta,
      );
      if (deposit && decisions[res.id] === 'forfeit') {
        await this.payments.forfeitDeposits(
          tx,
          auth,
          property,
          res.id,
          `No-show at the night audit for ${today}`,
          meta,
        );
      }
    }
    return due.length;
  }

  /** The unique key is the last line of defence against a double close. */
  private async mapDuplicate<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new AppError('CONFLICT', 'This business date has already been closed.');
      }
      throw err;
    }
  }

  private async property(tx: Tx, propertyId: string): Promise<PropertyRow> {
    const [p] = await tx.select().from(schema.properties).where(eq(schema.properties.id, propertyId));
    if (!p) throw AppError.notFound('property');
    return p;
  }

  private dto(c: typeof closes.$inferSelect, closedByName: string | null): DayCloseDto {
    return {
      id: c.id,
      kind: c.kind as DayCloseDto['kind'],
      businessDate: c.businessDate,
      nextDate: c.nextDate,
      closedAt: c.closedAt.toISOString(),
      closedByName,
      noShowsMarked: c.noShowsMarked,
      unresolved: c.unresolved as DayCloseIssueDto[],
      reason: c.reason,
      snapshot: {
        inHouse: c.snapshot.inHouse ?? 0,
        arrivalsCheckedIn: c.snapshot.arrivalsCheckedIn ?? 0,
        sellableRooms: c.snapshot.sellableRooms ?? 0,
      },
      summary: c.kind === 'night_audit' ? (c.summary as NightAuditSummaryDto) : null,
    };
  }
}
