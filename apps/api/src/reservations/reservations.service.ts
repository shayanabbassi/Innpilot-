import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  addDays,
  BOOKING_HORIZON_DAYS,
  BOOKING_REFERENCE_ALPHABET,
  BOOKING_REFERENCE_LENGTH,
  nightsBetween,
  type AuditEventDto,
  type AvailabilityDto,
  type AvailabilityQuery,
  type CreateReservationRequest,
  type FieldIssue,
  type ReservationDto,
  type ReservationListQuery,
  type ReservationRoomDto,
  type ReservationRoomInput,
  type ReservationStatus,
  type UpdateReservationRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, asc, desc, eq, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { IdempotencyService } from '../idempotency/idempotency.service';

const r = schema.reservations;
const rr = schema.reservationRooms;
const EXCLUSION_VIOLATION = '23P01';
const EDITABLE: readonly ReservationStatus[] = ['pending', 'confirmed'];

type PropertyRow = typeof schema.properties.$inferSelect;
type RoomTypeRow = typeof schema.roomTypes.$inferSelect;
type ReservationRoomRow = typeof rr.$inferSelect;

/** A room-night clash, reported to the client so the booking screen can say exactly what is full. */
function unavailable(message: string, details: FieldIssue[] = []): AppError {
  return new AppError('ROOM_UNAVAILABLE', message, details);
}

function newBookingReference(): string {
  let out = '';
  for (let i = 0; i < BOOKING_REFERENCE_LENGTH; i++) {
    out += BOOKING_REFERENCE_ALPHABET[randomInt(BOOKING_REFERENCE_ALPHABET.length)];
  }
  return out;
}

/** Postgres array literal for a uuid[] parameter (Drizzle would otherwise expand a JS array into a row). */
function uuidArray(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

interface Segment {
  roomTypeId: string;
  roomId: string | null;
  arrival: string;
  departure: string;
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ---------------------------------------------------------------------------------------------- queries

  availability(auth: AuthContext, propertyId: string, q: AvailabilityQuery): Promise<AvailabilityDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const types = await tx
        .select()
        .from(schema.roomTypes)
        .where(and(eq(schema.roomTypes.propertyId, propertyId), eq(schema.roomTypes.active, true)))
        .orderBy(asc(schema.roomTypes.sortOrder), asc(schema.roomTypes.code));
      const out: AvailabilityDto['roomTypes'] = [];
      for (const t of types) {
        const supply = await this.supply(tx, t.id);
        const peak = await this.peakBooked(tx, t.id, q.arrival, q.departure, []);
        const rate = await this.rateOn(tx, t.id, q.arrival);
        out.push({
          roomTypeId: t.id,
          code: t.code,
          name: t.name,
          capacityAdults: t.capacityAdults,
          capacityChildren: t.capacityChildren,
          available: Math.max(0, supply - peak),
          freeRooms: await this.freeRooms(tx, t.id, q.arrival, q.departure),
          nightlyRate: rate ? Money.fromStorage(rate, property.currencyCode).toString() : null,
          currencyCode: property.currencyCode,
        });
      }
      return {
        arrival: q.arrival,
        departure: q.departure,
        nights: nightsBetween(q.arrival, q.departure),
        roomTypes: out,
      };
    });
  }

  list(auth: AuthContext, propertyId: string, q: ReservationListQuery): Promise<ReservationDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const conditions: (SQL | undefined)[] = [eq(r.propertyId, propertyId)];
      conditions.push(
        q.status ? eq(r.status, q.status) : inArray(r.status, ['pending', 'confirmed', 'checked_in']),
      );
      if (q.from || q.to) {
        // Reservations with any room overlapping [from, to).
        conditions.push(
          sql`exists (select 1 from reservation_rooms x where x.reservation_id = ${r.id}
                ${q.to ? sql`and x.arrival < ${q.to}::date` : sql``}
                ${q.from ? sql`and x.departure > ${q.from}::date` : sql``})`,
        );
      }
      if (q.search) {
        const like = `%${q.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        conditions.push(or(ilike(r.bookingReference, like), ilike(schema.guests.fullName, like)));
      }
      const rows = await tx
        .select({ id: r.id })
        .from(r)
        .innerJoin(schema.guests, eq(schema.guests.id, r.guestId))
        .where(and(...conditions))
        .orderBy(desc(r.createdAt))
        .limit(q.limit);
      return this.loadMany(
        tx,
        rows.map((x) => x.id),
      );
    });
  }

  get(auth: AuthContext, propertyId: string, id: string): Promise<ReservationDto> {
    return this.db.tenant(auth.tenantId, (tx) => this.load(tx, propertyId, id));
  }

  /** The reservation's change history, from the audit log. */
  history(auth: AuthContext, propertyId: string, id: string): Promise<AuditEventDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.load(tx, propertyId, id);
      const e = schema.auditEvents;
      const rows = await tx
        .select({ event: e, actorName: schema.users.fullName })
        .from(e)
        .leftJoin(schema.users, eq(schema.users.id, e.actorUserId))
        .where(and(eq(e.entityType, 'reservation'), eq(e.entityId, id)))
        .orderBy(desc(e.occurredAt));
      return rows.map(({ event, actorName }) => ({
        id: event.id,
        occurredAt: event.occurredAt.toISOString(),
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        propertyId: event.propertyId,
        actor: { type: event.actorType, userId: event.actorUserId, name: actorName },
        changes: event.changes,
        reason: event.reason,
        requestId: event.requestId,
      }));
    });
  }

  // -------------------------------------------------------------------------------------------- commands

  async create(
    auth: AuthContext,
    propertyId: string,
    body: CreateReservationRequest,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
  ): Promise<{ status: number; body: ReservationDto }> {
    return this.mapConflicts(() =>
      this.db.tenant(auth.tenantId, (tx) =>
        this.idempotency.run(
          tx,
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            scope: `POST /properties/${propertyId}/reservations`,
            key: idempotencyKey,
            body,
          },
          async () => {
            const property = await this.property(tx, propertyId);
            const [guest] = await tx
              .select({ id: schema.guests.id })
              .from(schema.guests)
              .where(eq(schema.guests.id, body.guestId));
            if (!guest) {
              throw AppError.validation('Review the highlighted fields.', [
                { path: 'guestId', message: 'Choose an existing guest.' },
              ]);
            }
            const prepared = await this.prepareRooms(tx, auth, property, body.rooms, []);
            const reference = await this.uniqueReference(tx);
            const [res] = await tx
              .insert(r)
              .values({
                tenantId: auth.tenantId,
                propertyId,
                bookingReference: reference,
                guestId: body.guestId,
                source: body.source,
                status: body.status,
                notes: body.notes || null,
                confirmedAt: body.status === 'confirmed' ? new Date() : null,
                createdBy: auth.userId,
              })
              .returning();
            await tx.insert(rr).values(
              prepared.map((p) => ({
                tenantId: auth.tenantId,
                propertyId,
                reservationId: res!.id,
                ...p.values,
              })),
            );
            await this.record(tx, auth, propertyId, res!.id, meta, 'reservation.created', {
              bookingReference: reference,
              status: body.status,
              rooms: prepared.map((p) => p.summary),
            });
            return { status: 201, body: await this.load(tx, propertyId, res!.id) };
          },
        ),
      ),
    );
  }

  update(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: UpdateReservationRequest,
    meta: RequestMeta,
  ): Promise<ReservationDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const before = await this.lock(tx, propertyId, id);
      await tx.update(r).set(body).where(eq(r.id, id));
      const changed = (['source', 'notes'] as const).filter((f) => f in body && body[f] !== before[f]);
      if (changed.length) {
        await this.record(tx, auth, propertyId, id, meta, 'reservation.updated', { fields: changed });
      }
      return this.load(tx, propertyId, id);
    });
  }

  confirm(auth: AuthContext, propertyId: string, id: string, meta: RequestMeta): Promise<ReservationDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const res = await this.lock(tx, propertyId, id);
      if (res.status === 'confirmed') return this.load(tx, propertyId, id);
      if (res.status !== 'pending') throw this.badState(res.status, 'confirmed');
      await tx.update(r).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(r.id, id));
      await this.record(tx, auth, propertyId, id, meta, 'reservation.confirmed');
      return this.load(tx, propertyId, id);
    });
  }

  cancel(
    auth: AuthContext,
    propertyId: string,
    id: string,
    reason: string,
    meta: RequestMeta,
  ): Promise<ReservationDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const res = await this.lock(tx, propertyId, id);
      if (!EDITABLE.includes(res.status)) throw this.badState(res.status, 'cancelled');
      await tx
        .update(r)
        .set({ status: 'cancelled', cancelReason: reason, cancelledAt: new Date() })
        .where(eq(r.id, id));
      await tx.update(rr).set({ status: 'released' }).where(eq(rr.reservationId, id));
      await this.record(tx, auth, propertyId, id, meta, 'reservation.cancelled', {}, reason);
      return this.load(tx, propertyId, id);
    });
  }

  /** Only once the arrival date has come: a guest cannot be a no-show for a future stay. */
  noShow(auth: AuthContext, propertyId: string, id: string, reason: string | undefined, meta: RequestMeta) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const res = await this.lock(tx, propertyId, id);
      if (!EDITABLE.includes(res.status)) throw this.badState(res.status, 'no_show');
      const [first] = await tx
        .select({ arrival: sql<string>`min(${rr.arrival})::text` })
        .from(rr)
        .where(eq(rr.reservationId, id));
      if (first?.arrival && first.arrival > property.businessDate) {
        throw new AppError(
          'CONFLICT',
          `The guest is not due until ${first.arrival}, so this cannot be a no-show yet.`,
        );
      }
      await tx.update(r).set({ status: 'no_show' }).where(eq(r.id, id));
      await tx.update(rr).set({ status: 'released' }).where(eq(rr.reservationId, id));
      await this.record(tx, auth, propertyId, id, meta, 'reservation.no_show', {}, reason ?? null);
      return this.load(tx, propertyId, id);
    });
  }

  /** Assigns (or unassigns with null) a specific room to one booked room of the reservation. */
  assignRoom(
    auth: AuthContext,
    propertyId: string,
    id: string,
    reservationRoomId: string,
    roomId: string | null,
    meta: RequestMeta,
  ): Promise<ReservationDto> {
    return this.mapConflicts(() =>
      this.db.tenant(auth.tenantId, async (tx) => {
        const res = await this.lock(tx, propertyId, id);
        if (!EDITABLE.includes(res.status)) throw this.badState(res.status, 'changed');
        const seg = await this.segment(tx, id, reservationRoomId);
        if (roomId) await this.assertRoom(tx, propertyId, seg.roomTypeId, roomId, 'roomId');
        await tx.update(rr).set({ roomId }).where(eq(rr.id, reservationRoomId));
        await this.record(
          tx,
          auth,
          propertyId,
          id,
          meta,
          roomId ? 'reservation.room_assigned' : 'reservation.room_unassigned',
          {
            reservationRoomId,
            from: seg.roomId,
            to: roomId,
          },
        );
        return this.load(tx, propertyId, id);
      }),
    );
  }

  /** Changes dates, type, room or guests of one booked room. Keeps the agreed rate unless the type changes. */
  changeRoom(
    auth: AuthContext,
    propertyId: string,
    id: string,
    reservationRoomId: string,
    input: ReservationRoomInput,
    meta: RequestMeta,
  ): Promise<ReservationDto> {
    return this.mapConflicts(() =>
      this.db.tenant(auth.tenantId, async (tx) => {
        const property = await this.property(tx, propertyId);
        const res = await this.lock(tx, propertyId, id);
        if (!EDITABLE.includes(res.status)) throw this.badState(res.status, 'changed');
        const seg = await this.segment(tx, id, reservationRoomId);
        if (seg.status !== 'active')
          throw new AppError('CONFLICT', 'This room was removed from the booking.');
        const keepRate = input.roomTypeId === seg.roomTypeId && !input.nightlyRate;
        const [prepared] = await this.prepareRooms(tx, auth, property, [input], [reservationRoomId], {
          lockAlso: [seg.roomTypeId],
          keepRate: keepRate ? { nightlyRate: seg.nightlyRate, overridden: seg.rateOverridden } : undefined,
        });
        await tx.update(rr).set(prepared!.values).where(eq(rr.id, reservationRoomId));
        await this.record(tx, auth, propertyId, id, meta, 'reservation.room_changed', {
          reservationRoomId,
          from: {
            roomTypeId: seg.roomTypeId,
            roomId: seg.roomId,
            arrival: seg.arrival,
            departure: seg.departure,
            adults: seg.adults,
            children: seg.children,
          },
          to: prepared!.summary,
        });
        return this.load(tx, propertyId, id);
      }),
    );
  }

  addRoom(
    auth: AuthContext,
    propertyId: string,
    id: string,
    input: ReservationRoomInput,
    meta: RequestMeta,
  ): Promise<ReservationDto> {
    return this.mapConflicts(() =>
      this.db.tenant(auth.tenantId, async (tx) => {
        const property = await this.property(tx, propertyId);
        const res = await this.lock(tx, propertyId, id);
        if (!EDITABLE.includes(res.status)) throw this.badState(res.status, 'changed');
        const [prepared] = await this.prepareRooms(tx, auth, property, [input], []);
        await tx
          .insert(rr)
          .values({ tenantId: auth.tenantId, propertyId, reservationId: id, ...prepared!.values });
        await this.record(tx, auth, propertyId, id, meta, 'reservation.room_added', prepared!.summary);
        return this.load(tx, propertyId, id);
      }),
    );
  }

  removeRoom(
    auth: AuthContext,
    propertyId: string,
    id: string,
    reservationRoomId: string,
    meta: RequestMeta,
  ) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const res = await this.lock(tx, propertyId, id);
      if (!EDITABLE.includes(res.status)) throw this.badState(res.status, 'changed');
      const seg = await this.segment(tx, id, reservationRoomId);
      const [{ n } = { n: 0 }] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(rr)
        .where(and(eq(rr.reservationId, id), eq(rr.status, 'active')));
      if (seg.status === 'active' && n <= 1) {
        throw new AppError('CONFLICT', 'A booking needs at least one room. Cancel the booking instead.');
      }
      await tx.update(rr).set({ status: 'released' }).where(eq(rr.id, reservationRoomId));
      await this.record(tx, auth, propertyId, id, meta, 'reservation.room_removed', { reservationRoomId });
      return this.load(tx, propertyId, id);
    });
  }

  // ------------------------------------------------------------------------------------- validation core

  /**
   * Validates booked rooms and returns the rows to write. Locks every room type involved (in a fixed order, so
   * concurrent bookings cannot deadlock) before counting inventory, which serialises competing bookings of the
   * same type. `excluding` lists reservation rooms being replaced, so they do not count against themselves.
   */
  private async prepareRooms(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    inputs: ReservationRoomInput[],
    excluding: string[],
    options: { lockAlso?: string[]; keepRate?: { nightlyRate: string; overridden: boolean } } = {},
  ) {
    const horizon = addDays(property.businessDate, BOOKING_HORIZON_DAYS);
    const typeIds = [...new Set([...inputs.map((i) => i.roomTypeId), ...(options.lockAlso ?? [])])].sort();
    const types = new Map<string, RoomTypeRow>();
    for (const typeId of typeIds) {
      const [t] = await tx
        .select()
        .from(schema.roomTypes)
        .where(and(eq(schema.roomTypes.id, typeId), eq(schema.roomTypes.propertyId, property.id)))
        .for('update');
      if (t) types.set(typeId, t);
    }

    const out: {
      values: Omit<typeof rr.$inferInsert, 'tenantId' | 'propertyId' | 'reservationId'>;
      summary: Record<string, unknown>;
    }[] = [];
    for (const [i, input] of inputs.entries()) {
      const path = (f: string) => `rooms.${i}.${f}`;
      const type = types.get(input.roomTypeId);
      if (!type || !type.active) {
        throw AppError.validation('Review the highlighted fields.', [
          { path: path('roomTypeId'), message: 'Choose an active room type of this property.' },
        ]);
      }
      if (input.arrival < property.businessDate) {
        throw AppError.validation('Bookings cannot start in the past.', [
          { path: path('arrival'), message: `Choose ${property.businessDate} or later.` },
        ]);
      }
      if (input.arrival > horizon) {
        throw AppError.validation('That date is too far ahead.', [
          { path: path('arrival'), message: `Bookings can be made up to ${horizon}.` },
        ]);
      }
      if (input.adults > type.capacityAdults || input.children > type.capacityChildren) {
        throw AppError.validation('Too many guests for this room type.', [
          {
            path: path('adults'),
            message: `${type.code} sleeps ${type.capacityAdults} adults and ${type.capacityChildren} children.`,
          },
        ]);
      }
      if (input.roomId) await this.assertRoom(tx, property.id, type.id, input.roomId, path('roomId'));

      let rate: string;
      let overridden = false;
      if (input.nightlyRate) {
        if (!auth.permissionsByProperty.get(property.id)?.has('reservation.rate_override')) {
          throw AppError.forbidden(
            'You cannot change the rate. Book at the room type rate or ask a manager.',
          );
        }
        rate = Money.of(input.nightlyRate, property.currencyCode).toStorage();
        overridden = true;
      } else if (options.keepRate) {
        rate = options.keepRate.nightlyRate;
        overridden = options.keepRate.overridden;
      } else {
        const found = await this.rateOn(tx, type.id, input.arrival);
        if (!found) {
          throw AppError.validation(`No rate is set for ${type.code} on ${input.arrival}.`, [
            { path: path('roomTypeId'), message: 'Set a rate for this room type first.' },
          ]);
        }
        rate = found;
      }
      out.push({
        values: {
          roomTypeId: type.id,
          roomId: input.roomId ?? null,
          arrival: input.arrival,
          departure: input.departure,
          adults: input.adults,
          children: input.children,
          nightlyRate: rate,
          currencyCode: property.currencyCode,
          rateOverridden: overridden,
          status: 'active',
        },
        summary: {
          roomType: type.code,
          roomId: input.roomId ?? null,
          arrival: input.arrival,
          departure: input.departure,
          adults: input.adults,
          children: input.children,
          nightlyRate: Money.fromStorage(rate, property.currencyCode).toString(),
          rateOverridden: overridden,
          ...(overridden && input.rateOverrideReason ? { rateOverrideReason: input.rateOverrideReason } : {}),
        },
      });
    }

    // Room-type inventory: for every night, existing active bookings plus these must fit in the rooms of the type.
    for (const typeId of new Set(inputs.map((i) => i.roomTypeId))) {
      const segs: Segment[] = out
        .map((o) => o.values)
        .filter((v) => v.roomTypeId === typeId)
        .map((v) => ({
          roomTypeId: typeId,
          roomId: v.roomId ?? null,
          arrival: v.arrival,
          departure: v.departure,
        }));
      await this.assertInventory(tx, types.get(typeId)!, segs, excluding);
    }
    return out;
  }

  private async assertInventory(
    tx: Tx,
    type: RoomTypeRow,
    segs: Segment[],
    excluding: string[],
  ): Promise<void> {
    const from = segs.reduce((m, s) => (s.arrival < m ? s.arrival : m), segs[0]!.arrival);
    const to = segs.reduce((m, s) => (s.departure > m ? s.departure : m), segs[0]!.departure);
    const supply = await this.supply(tx, type.id);
    const { rows } = await tx.execute<{ night: string; booked: number }>(sql`
      select n::date::text as night, count(x.id)::int as booked
        from generate_series(${from}::date, ${to}::date - 1, interval '1 day') n
        left join reservation_rooms x
          on x.room_type_id = ${type.id} and x.status = 'active'
         and x.arrival <= n::date and x.departure > n::date
         and not (x.id = any(${uuidArray(excluding)}::uuid[]))
       group by n order by n`);
    const full = rows
      .map((row) => ({
        night: row.night,
        needed: row.booked + segs.filter((s) => s.arrival <= row.night && s.departure > row.night).length,
      }))
      .filter((x) => x.needed > supply)
      .map((x) => x.night);
    if (full.length > 0) {
      throw unavailable(`${type.code} is fully booked on ${full.join(', ')}.`, [
        { path: 'rooms', message: `${type.code} has no room left on ${full.join(', ')}.` },
      ]);
    }
  }

  /** Rooms that count as sellable inventory for a type. Dated out-of-order windows come with housekeeping. */
  private async supply(tx: Tx, roomTypeId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.rooms)
      .where(and(eq(schema.rooms.roomTypeId, roomTypeId), eq(schema.rooms.active, true)));
    return row?.n ?? 0;
  }

  /** Highest number of active bookings of a type on any night of the range. */
  private async peakBooked(tx: Tx, roomTypeId: string, from: string, to: string, excluding: string[]) {
    const { rows } = await tx.execute<{ peak: number }>(sql`
      select coalesce(max(c), 0)::int as peak from (
        select count(x.id) as c
          from generate_series(${from}::date, ${to}::date - 1, interval '1 day') n
          left join reservation_rooms x
            on x.room_type_id = ${roomTypeId} and x.status = 'active'
           and x.arrival <= n::date and x.departure > n::date
           and not (x.id = any(${uuidArray(excluding)}::uuid[]))
         group by n) s`);
    return rows[0]?.peak ?? 0;
  }

  private async freeRooms(tx: Tx, roomTypeId: string, arrival: string, departure: string) {
    const rows = await tx
      .select({ id: schema.rooms.id, roomNumber: schema.rooms.roomNumber })
      .from(schema.rooms)
      .where(
        and(
          eq(schema.rooms.roomTypeId, roomTypeId),
          eq(schema.rooms.active, true),
          sql`not exists (select 1 from reservation_rooms x where x.room_id = ${schema.rooms.id}
                and x.status = 'active' and x.arrival < ${departure}::date and x.departure > ${arrival}::date)`,
        ),
      )
      .orderBy(sql`length(${schema.rooms.roomNumber})`, asc(schema.rooms.roomNumber));
    return rows;
  }

  private async rateOn(tx: Tx, roomTypeId: string, date: string): Promise<string | null> {
    const [row] = await tx
      .select({ rate: schema.roomTypeRates.nightlyRate })
      .from(schema.roomTypeRates)
      .where(
        and(eq(schema.roomTypeRates.roomTypeId, roomTypeId), lte(schema.roomTypeRates.effectiveFrom, date)),
      )
      .orderBy(desc(schema.roomTypeRates.effectiveFrom))
      .limit(1);
    return row?.rate ?? null;
  }

  private async assertRoom(tx: Tx, propertyId: string, roomTypeId: string, roomId: string, path: string) {
    const [room] = await tx
      .select()
      .from(schema.rooms)
      .where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.propertyId, propertyId)));
    if (!room || !room.active) {
      throw AppError.validation('Review the highlighted fields.', [
        { path, message: 'Choose an active room of this property.' },
      ]);
    }
    if (room.roomTypeId !== roomTypeId) {
      throw AppError.validation('Review the highlighted fields.', [
        { path, message: `Room ${room.roomNumber} is not of the booked room type.` },
      ]);
    }
  }

  // ------------------------------------------------------------------------------------------------ helpers

  private async uniqueReference(tx: Tx): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const ref = newBookingReference();
      const [taken] = await tx.select({ id: r.id }).from(r).where(eq(r.bookingReference, ref));
      if (!taken) return ref;
    }
    throw new Error('Could not allocate a booking reference');
  }

  /** Exclusion-constraint violations (a racing booking took the room) become a clear 409. */
  private async mapConflicts<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (pgErrorCode(err) === EXCLUSION_VIOLATION) {
        throw unavailable(
          'That room is already booked for some of these nights. Choose another room or dates.',
          [{ path: 'roomId', message: 'Already booked for these nights.' }],
        );
      }
      throw err;
    }
  }

  private badState(status: ReservationStatus, target: string): AppError {
    return new AppError(
      'CONFLICT',
      `A ${status.replace('_', '-')} booking cannot be ${target.replace('_', '-')}.`,
    );
  }

  private async property(tx: Tx, propertyId: string): Promise<PropertyRow> {
    const [p] = await tx.select().from(schema.properties).where(eq(schema.properties.id, propertyId));
    if (!p) throw AppError.notFound('property');
    return p;
  }

  private async lock(tx: Tx, propertyId: string, id: string) {
    const [row] = await tx
      .select()
      .from(r)
      .where(and(eq(r.id, id), eq(r.propertyId, propertyId)))
      .for('update');
    if (!row) throw AppError.notFound('reservation');
    return row;
  }

  private async segment(tx: Tx, reservationId: string, id: string): Promise<ReservationRoomRow> {
    const [seg] = await tx
      .select()
      .from(rr)
      .where(and(eq(rr.id, id), eq(rr.reservationId, reservationId)))
      .for('update');
    if (!seg) throw AppError.notFound('booked room');
    return seg;
  }

  private record(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    id: string,
    meta: RequestMeta,
    action: string,
    changes: Record<string, unknown> = {},
    reason: string | null = null,
  ) {
    return this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType: 'reservation',
        entityId: id,
        changes,
        reason,
      },
      meta,
    );
  }

  private async load(tx: Tx, propertyId: string, id: string): Promise<ReservationDto> {
    const [one] = await this.loadMany(tx, [id], propertyId);
    if (!one) throw AppError.notFound('reservation');
    return one;
  }

  private async loadMany(tx: Tx, ids: string[], propertyId?: string): Promise<ReservationDto[]> {
    if (ids.length === 0) return [];
    const heads = await tx
      .select({ res: r, guest: schema.guests })
      .from(r)
      .innerJoin(schema.guests, eq(schema.guests.id, r.guestId))
      .where(and(inArray(r.id, ids), propertyId ? eq(r.propertyId, propertyId) : undefined));
    const rooms = await tx
      .select({ seg: rr, code: schema.roomTypes.code, roomNumber: schema.rooms.roomNumber })
      .from(rr)
      .innerJoin(schema.roomTypes, eq(schema.roomTypes.id, rr.roomTypeId))
      .leftJoin(schema.rooms, eq(schema.rooms.id, rr.roomId))
      .where(inArray(rr.reservationId, ids))
      .orderBy(asc(rr.arrival), asc(rr.createdAt));
    const byId = new Map(heads.map((h) => [h.res.id, h]));
    return ids
      .map((id) => byId.get(id))
      .filter((h): h is NonNullable<typeof h> => !!h)
      .map(({ res, guest }) => {
        const segs: ReservationRoomDto[] = rooms
          .filter((x) => x.seg.reservationId === res.id)
          .map(({ seg, code, roomNumber }) => {
            const nights = nightsBetween(seg.arrival, seg.departure);
            const rate = Money.fromStorage(seg.nightlyRate, seg.currencyCode);
            return {
              id: seg.id,
              roomTypeId: seg.roomTypeId,
              roomTypeCode: code,
              roomId: seg.roomId,
              roomNumber: roomNumber ?? null,
              arrival: seg.arrival,
              departure: seg.departure,
              nights,
              adults: seg.adults,
              children: seg.children,
              nightlyRate: rate.toString(),
              currencyCode: seg.currencyCode,
              rateOverridden: seg.rateOverridden,
              roomTotal: rate.multiply(String(nights)).toString(),
              status: seg.status,
            };
          });
        const active = segs.filter((s) => s.status === 'active');
        const span = active.length ? active : segs;
        return {
          id: res.id,
          bookingReference: res.bookingReference,
          status: res.status,
          source: res.source,
          notes: res.notes,
          guest: {
            id: guest.id,
            fullName: guest.fullName,
            phone: guest.phone,
            email: guest.email,
            city: guest.city,
            nationality: guest.nationality,
          },
          rooms: segs,
          arrival: span.reduce((m, s) => (s.arrival < m ? s.arrival : m), span[0]?.arrival ?? ''),
          departure: span.reduce((m, s) => (s.departure > m ? s.departure : m), span[0]?.departure ?? ''),
          createdAt: res.createdAt.toISOString(),
          cancelReason: res.cancelReason,
        };
      });
  }
}
