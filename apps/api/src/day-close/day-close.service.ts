import { Injectable } from '@nestjs/common';
import {
  addDays,
  type DayCloseDto,
  type DayCloseIssueDto,
  type DayClosePreviewDto,
  type DayCloseRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { IdempotencyService } from '../idempotency/idempotency.service';

const r = schema.reservations;
const rr = schema.reservationRooms;
const rooms = schema.rooms;
const tickets = schema.maintenanceTickets;
const closes = schema.businessDateCloses;
type PropertyRow = typeof schema.properties.$inferSelect;

interface Assessment {
  preview: DayClosePreviewDto;
}

/**
 * Interim business-date close (decision D3). Checks the day, optionally marks remaining arrivals as no-shows,
 * advances the business date by exactly one day, and applies out-of-order periods for the new date. A date can be
 * closed only once (unique key + expected-date check + row lock). No money is posted; Phase 4's night audit adds that.
 */
@Injectable()
export class DayCloseService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  preview(auth: AuthContext, propertyId: string): Promise<DayClosePreviewDto> {
    return this.db.tenant(
      auth.tenantId,
      async (tx) => (await this.assess(tx, await this.property(tx, propertyId))).preview,
    );
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
  ): Promise<{ status: number; body: DayCloseDto }> {
    return this.mapDuplicate(() =>
      this.db.tenant(auth.tenantId, (tx) =>
        this.idempotency.run(
          tx,
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            scope: `POST /properties/${propertyId}/day-close`,
            key: idempotencyKey,
            body,
          },
          async () => {
            // The property row lock serialises closes; the expected date stops a second close from another screen.
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
            if (body.markNoShows) noShows = await this.markNoShows(tx, auth, propertyId, today, meta);
            const { preview } = await this.assess(tx, property);
            const unresolved = preview.issues;
            if (unresolved.length > 0 && !body.reason) {
              throw new AppError(
                'CONFLICT',
                'Some items are still open. Resolve them, or give a reason to close the day anyway.',
                unresolved.map((i) => ({ path: i.check, message: i.label })),
              );
            }

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
    );
  }

  // ------------------------------------------------------------------------------------------- internals

  private async assess(tx: Tx, property: PropertyRow): Promise<Assessment> {
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

    // In-house guests whose stay ends by tomorrow without a check-out (check-out arrives in Phase 3).
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

    const [checkedIn] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.stayRooms)
      .innerJoin(schema.stays, eq(schema.stays.id, schema.stayRooms.stayId))
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

    return {
      preview: {
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
      },
    };
  }

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
        reason: `Day close: out-of-order period ${change.to === 'out_of_order' ? 'starts' : 'ended'}`,
        actorUserId: auth.userId,
      });
    }
  }

  private async markNoShows(tx: Tx, auth: AuthContext, propertyId: string, today: string, meta: RequestMeta) {
    const due = await tx
      .select({ id: r.id })
      .from(r)
      .where(
        and(
          eq(r.propertyId, propertyId),
          inArray(r.status, ['pending', 'confirmed']),
          sql`exists (select 1 from reservation_rooms x where x.reservation_id = ${r.id} and x.status = 'active'
                        and x.stay_id is null and x.arrival <= ${today}::date)`,
          // A booking with a guest already in house is not a no-show.
          sql`not exists (select 1 from reservation_rooms x where x.reservation_id = ${r.id} and x.stay_id is not null)`,
        ),
      )
      .for('update');
    for (const res of due) {
      await tx.update(r).set({ status: 'no_show' }).where(eq(r.id, res.id));
      await tx.update(rr).set({ status: 'released' }).where(eq(rr.reservationId, res.id));
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId,
          actor: { type: 'user', userId: auth.userId },
          action: 'reservation.no_show',
          entityType: 'reservation',
          entityId: res.id,
          reason: `Marked at day close for ${today}`,
        },
        meta,
      );
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
    };
  }
}
