import { Injectable } from '@nestjs/common';
import {
  OVERRIDABLE_PROBLEMS,
  readinessProblem,
  type ArrivalDto,
  type CheckInRequest,
  type FrontDeskTodayDto,
  type MoveRoomRequest,
  type ReadinessProblem,
  type StayDto,
  type WalkInRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { and, asc, desc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { GuestsService } from '../guests/guests.service';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ReservationsService } from '../reservations/reservations.service';

const r = schema.reservations;
const rr = schema.reservationRooms;
const st = schema.stays;
const seg = schema.stayRooms;
const rooms = schema.rooms;

type PropertyRow = typeof schema.properties.$inferSelect;
type RoomRow = typeof rooms.$inferSelect;

const PROBLEM_TEXT: Record<ReadinessProblem, string> = {
  occupied: 'another guest is in the room',
  out_of_order: 'the room is out of order',
  dirty: 'the room has not been cleaned',
  cleaning: 'the room is being cleaned',
  inactive: 'the room is not in use',
};

/**
 * Check-in, walk-ins and room moves (decisions P2-10, P2-11, P2-13). Readiness rules: an occupied or inactive
 * room can never be used; a dirty, in-cleaning or out-of-order room only with stay.readiness_override and a
 * reason, which is audited (OPS-002).
 */
@Injectable()
export class StaysService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly reservations: ReservationsService,
    private readonly guests: GuestsService,
  ) {}

  // -------------------------------------------------------------------------------------------- commands

  checkIn(
    auth: AuthContext,
    propertyId: string,
    reservationId: string,
    reservationRoomId: string,
    body: CheckInRequest,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
  ): Promise<{ status: number; body: StayDto }> {
    return this.guard(() =>
      this.db.tenant(auth.tenantId, (tx) =>
        this.idempotency.run(
          tx,
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            scope: `POST /properties/${propertyId}/reservations/${reservationId}/rooms/${reservationRoomId}/check-in`,
            key: idempotencyKey,
            body,
          },
          async () => {
            const property = await this.property(tx, propertyId);
            const stayId = await this.checkInInTx(
              tx,
              auth,
              property,
              reservationId,
              reservationRoomId,
              body,
              meta,
            );
            return { status: 200, body: await this.load(tx, propertyId, stayId) };
          },
        ),
      ),
    );
  }

  /** Booking and check-in in one step for a guest at the desk. */
  walkIn(
    auth: AuthContext,
    propertyId: string,
    body: WalkInRequest,
    idempotencyKey: string | undefined,
    meta: RequestMeta,
  ): Promise<{ status: number; body: StayDto }> {
    return this.guard(() =>
      this.db.tenant(auth.tenantId, (tx) =>
        this.idempotency.run(
          tx,
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            scope: `POST /properties/${propertyId}/walk-ins`,
            key: idempotencyKey,
            body,
          },
          async () => {
            const property = await this.property(tx, propertyId);
            const [room] = await tx
              .select()
              .from(rooms)
              .where(and(eq(rooms.id, body.roomId), eq(rooms.propertyId, propertyId)));
            if (!room) {
              throw AppError.validation('Review the highlighted fields.', [
                { path: 'roomId', message: 'Choose a room of this property.' },
              ]);
            }
            // Check readiness before writing anything, so the error names the room problem.
            await this.assertReady(tx, auth, property.id, room, body.readinessOverrideReason);
            const guestId = body.guestId ?? (await this.guests.createInTx(tx, auth, body.guest!, meta));
            const reservationId = await this.reservations.createInTx(
              tx,
              auth,
              propertyId,
              {
                guestId,
                source: 'walk_in',
                status: 'confirmed',
                ...(body.notes ? { notes: body.notes } : {}),
                rooms: [
                  {
                    roomTypeId: room.roomTypeId,
                    roomId: room.id,
                    arrival: property.businessDate,
                    departure: body.departure,
                    adults: body.adults,
                    children: body.children,
                    ...(body.nightlyRate
                      ? { nightlyRate: body.nightlyRate, rateOverrideReason: body.rateOverrideReason }
                      : {}),
                  },
                ],
              },
              meta,
            );
            const [booked] = await tx
              .select({ id: rr.id })
              .from(rr)
              .where(eq(rr.reservationId, reservationId));
            const stayId = await this.checkInInTx(
              tx,
              auth,
              property,
              reservationId,
              booked!.id,
              {
                ...(body.readinessOverrideReason
                  ? { readinessOverrideReason: body.readinessOverrideReason }
                  : {}),
              },
              meta,
            );
            return { status: 201, body: await this.load(tx, propertyId, stayId) };
          },
        ),
      ),
    );
  }

  /**
   * Moves an in-house guest to another room from today. Nights already spent stay on the old room: the booked
   * room is split at the business date (or simply re-pointed on the day of arrival). The agreed rate is kept.
   */
  move(auth: AuthContext, propertyId: string, stayId: string, body: MoveRoomRequest, meta: RequestMeta) {
    return this.guard(() =>
      this.db.tenant(auth.tenantId, async (tx) => {
        const property = await this.property(tx, propertyId);
        const [stay] = await tx
          .select()
          .from(st)
          .where(and(eq(st.id, stayId), eq(st.propertyId, propertyId)))
          .for('update');
        if (!stay) throw AppError.notFound('stay');
        if (stay.status !== 'in_house') throw new AppError('CONFLICT', 'This guest has already checked out.');
        const [current] = await tx
          .select()
          .from(seg)
          .where(and(eq(seg.stayId, stayId), isNull(seg.endedAt)))
          .for('update');
        if (!current) throw new AppError('CONFLICT', 'This stay has no current room.');
        if (current.roomId === body.roomId) {
          throw AppError.validation('The guest is already in that room.', [
            { path: 'roomId', message: 'Choose a different room.' },
          ]);
        }
        const [target] = await tx
          .select()
          .from(rooms)
          .where(and(eq(rooms.id, body.roomId), eq(rooms.propertyId, propertyId)));
        if (!target) {
          throw AppError.validation('Review the highlighted fields.', [
            { path: 'roomId', message: 'Choose a room of this property.' },
          ]);
        }
        const override = await this.assertReady(tx, auth, propertyId, target, body.readinessOverrideReason);

        // The booked room covering tonight.
        const [booked] = await tx
          .select()
          .from(rr)
          .where(
            and(
              eq(rr.stayId, stayId),
              eq(rr.status, 'active'),
              lte(rr.arrival, property.businessDate),
              gt(rr.departure, property.businessDate),
            ),
          )
          .for('update');
        if (!booked) {
          throw new AppError(
            'CONFLICT',
            'The stay has no booked nights left from today. Extend the stay first.',
          );
        }
        if (target.roomTypeId !== booked.roomTypeId) {
          const [type] = await tx
            .select()
            .from(schema.roomTypes)
            .where(eq(schema.roomTypes.id, target.roomTypeId))
            .for('update');
          await this.reservations.assertInventory(
            tx,
            type!,
            [
              {
                roomTypeId: type!.id,
                roomId: target.id,
                arrival: property.businessDate,
                departure: booked.departure,
              },
            ],
            [booked.id],
          );
        }
        if (booked.arrival === property.businessDate) {
          await tx
            .update(rr)
            .set({ roomId: target.id, roomTypeId: target.roomTypeId })
            .where(eq(rr.id, booked.id));
        } else {
          // Keep the nights already spent on the old room; book the rest on the new one at the same rate.
          await tx.update(rr).set({ departure: property.businessDate }).where(eq(rr.id, booked.id));
          await tx.insert(rr).values({
            tenantId: auth.tenantId,
            propertyId,
            reservationId: booked.reservationId,
            roomTypeId: target.roomTypeId,
            roomId: target.id,
            arrival: property.businessDate,
            departure: booked.departure,
            adults: booked.adults,
            children: booked.children,
            nightlyRate: booked.nightlyRate,
            currencyCode: booked.currencyCode,
            rateOverridden: booked.rateOverridden,
            stayId,
          });
        }
        await tx
          .update(seg)
          .set({ endedAt: sql`now()` })
          .where(eq(seg.id, current.id));
        await tx.insert(seg).values({
          tenantId: auth.tenantId,
          propertyId,
          stayId,
          roomId: target.id,
          fromDate: property.businessDate,
          reason: body.reason,
        });
        await this.markDirty(tx, auth, propertyId, current.roomId, 'Guest moved to another room');
        await this.record(
          tx,
          auth,
          propertyId,
          stay.reservationId,
          meta,
          'reservation.room_moved',
          {
            stayId,
            fromRoomId: current.roomId,
            toRoomId: target.id,
            ...(override ? { readinessOverride: override } : {}),
          },
          body.reason,
        );
        return this.load(tx, propertyId, stayId);
      }),
    );
  }

  // --------------------------------------------------------------------------------------------- queries

  get(auth: AuthContext, propertyId: string, stayId: string): Promise<StayDto> {
    return this.db.tenant(auth.tenantId, (tx) => this.load(tx, propertyId, stayId));
  }

  today(auth: AuthContext, propertyId: string): Promise<FrontDeskTodayDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const occupied = await this.occupiedRoomIds(tx, propertyId);
      const due = await tx
        .select({ booked: rr, res: r, guest: schema.guests, code: schema.roomTypes.code, room: rooms })
        .from(rr)
        .innerJoin(r, eq(r.id, rr.reservationId))
        .innerJoin(schema.guests, eq(schema.guests.id, r.guestId))
        .innerJoin(schema.roomTypes, eq(schema.roomTypes.id, rr.roomTypeId))
        .leftJoin(rooms, eq(rooms.id, rr.roomId))
        .where(
          and(
            eq(rr.propertyId, propertyId),
            eq(rr.status, 'active'),
            isNull(rr.stayId),
            inArray(r.status, ['pending', 'confirmed', 'checked_in']),
            lte(rr.arrival, property.businessDate),
            gt(rr.departure, property.businessDate),
          ),
        )
        .orderBy(asc(rr.arrival), asc(schema.guests.fullName));
      const arrivals: ArrivalDto[] = due.map(({ booked, res, guest, code, room }) => ({
        reservationId: res.id,
        reservationRoomId: booked.id,
        bookingReference: res.bookingReference,
        reservationStatus: res.status,
        guest: {
          id: guest.id,
          fullName: guest.fullName,
          phone: guest.phone,
          email: guest.email,
          city: guest.city,
          nationality: guest.nationality,
        },
        roomTypeId: booked.roomTypeId,
        roomTypeCode: code,
        roomId: booked.roomId,
        roomNumber: room?.roomNumber ?? null,
        arrival: booked.arrival,
        departure: booked.departure,
        adults: booked.adults,
        children: booked.children,
        readiness: room ? readinessProblem({ ...room, occupied: occupied.has(room.id) }) : null,
      }));
      const inHouseIds = await tx
        .select({ id: st.id })
        .from(st)
        .where(and(eq(st.propertyId, propertyId), eq(st.status, 'in_house')));
      const inHouse = await Promise.all(inHouseIds.map((s) => this.load(tx, propertyId, s.id)));
      inHouse.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
      return {
        businessDate: property.businessDate,
        arrivals,
        inHouse,
        departures: inHouse.filter((s) => s.departure <= property.businessDate),
      };
    });
  }

  // ------------------------------------------------------------------------------------------- internals

  private async checkInInTx(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    reservationId: string,
    reservationRoomId: string,
    body: CheckInRequest,
    meta: RequestMeta,
  ): Promise<string> {
    const [res] = await tx
      .select()
      .from(r)
      .where(and(eq(r.id, reservationId), eq(r.propertyId, property.id)))
      .for('update');
    if (!res) throw AppError.notFound('reservation');
    if (res.status === 'pending') throw new AppError('CONFLICT', 'Confirm the booking before checking in.');
    if (res.status !== 'confirmed' && res.status !== 'checked_in') {
      throw new AppError('CONFLICT', `A ${res.status.replace('_', '-')} booking cannot be checked in.`);
    }
    const [booked] = await tx
      .select()
      .from(rr)
      .where(and(eq(rr.id, reservationRoomId), eq(rr.reservationId, reservationId)))
      .for('update');
    if (!booked || booked.status !== 'active') throw AppError.notFound('booked room');
    if (booked.stayId) throw new AppError('CONFLICT', 'This guest is already checked in.');
    if (booked.arrival > property.businessDate) {
      throw new AppError(
        'CONFLICT',
        `This guest is due on ${booked.arrival}, not today (${property.businessDate}).`,
      );
    }
    if (booked.departure <= property.businessDate) {
      throw new AppError('CONFLICT', 'This stay has already ended. Change the dates first.');
    }

    let roomId = booked.roomId;
    if (body.roomId && roomId && body.roomId !== roomId) {
      throw AppError.validation('This booking already has a room. Change the room first.', [
        { path: 'roomId', message: 'Leave empty to use the assigned room.' },
      ]);
    }
    if (!roomId) {
      if (!body.roomId) {
        throw AppError.validation('Choose a room to check in to.', [
          { path: 'roomId', message: 'Choose a room.' },
        ]);
      }
      await this.reservations.assertRoom(tx, property.id, booked.roomTypeId, body.roomId, 'roomId');
      await tx.update(rr).set({ roomId: body.roomId }).where(eq(rr.id, booked.id));
      roomId = body.roomId;
    }
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId));
    const override = await this.assertReady(tx, auth, property.id, room!, body.readinessOverrideReason);

    const [stay] = await tx
      .insert(st)
      .values({
        tenantId: auth.tenantId,
        propertyId: property.id,
        reservationId,
        guestId: res.guestId,
        checkedInBy: auth.userId,
      })
      .returning({ id: st.id });
    await tx.insert(seg).values({
      tenantId: auth.tenantId,
      propertyId: property.id,
      stayId: stay!.id,
      roomId,
      fromDate: property.businessDate,
    });
    await tx.update(rr).set({ stayId: stay!.id }).where(eq(rr.id, booked.id));
    await tx.update(r).set({ status: 'checked_in' }).where(eq(r.id, reservationId));
    await this.record(
      tx,
      auth,
      property.id,
      reservationId,
      meta,
      'reservation.checked_in',
      {
        stayId: stay!.id,
        reservationRoomId: booked.id,
        roomId,
        ...(override ? { readinessOverride: override } : {}),
      },
      override?.reason ?? null,
    );
    return stay!.id;
  }

  /**
   * Refuses a room that cannot take a guest. Returns the override details when a not-ready room is used with
   * permission and a reason, so the caller can audit it.
   */
  private async assertReady(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    room: RoomRow,
    overrideReason: string | undefined,
  ): Promise<{ problem: ReadinessProblem; reason: string } | null> {
    const occupied = await this.occupiedRoomIds(tx, propertyId, room.id);
    const problem = readinessProblem({ ...room, occupied: occupied.has(room.id) });
    if (!problem) return null;
    const message = `Room ${room.roomNumber} cannot be used: ${PROBLEM_TEXT[problem]}.`;
    if (!OVERRIDABLE_PROBLEMS.includes(problem)) {
      throw new AppError('ROOM_NOT_READY', message, [{ path: 'roomId', message: PROBLEM_TEXT[problem] }]);
    }
    if (!overrideReason) {
      throw new AppError('ROOM_NOT_READY', message, [
        { path: 'readinessOverrideReason', message: 'A manager can override this with a reason.' },
      ]);
    }
    if (!auth.permissionsByProperty.get(propertyId)?.has('stay.readiness_override')) {
      throw AppError.forbidden(`${message} Only a manager can override this.`);
    }
    return { problem, reason: overrideReason };
  }

  private async occupiedRoomIds(tx: Tx, propertyId: string, onlyRoomId?: string): Promise<Set<string>> {
    const rows = await tx
      .select({ roomId: seg.roomId })
      .from(seg)
      .where(
        and(
          eq(seg.propertyId, propertyId),
          isNull(seg.endedAt),
          onlyRoomId ? eq(seg.roomId, onlyRoomId) : undefined,
        ),
      );
    return new Set(rows.map((x) => x.roomId));
  }

  private async markDirty(tx: Tx, auth: AuthContext, propertyId: string, roomId: string, reason: string) {
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId)).for('update');
    if (!room || room.housekeepingState === 'dirty') return;
    await tx.update(rooms).set({ housekeepingState: 'dirty' }).where(eq(rooms.id, roomId));
    await tx.insert(schema.roomStatusEvents).values({
      tenantId: auth.tenantId,
      propertyId,
      roomId,
      dimension: 'housekeeping',
      fromState: room.housekeepingState,
      toState: 'dirty',
      reason,
      actorUserId: auth.userId,
    });
  }

  /** Concurrency backstops: a racing check-in into the same room surfaces as a clear 409. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await this.reservations.mapConflicts(fn);
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new AppError(
          'ROOM_NOT_READY',
          'Another guest has just been put in that room. Choose another room.',
          [{ path: 'roomId', message: 'Another guest is in this room.' }],
        );
      }
      throw err;
    }
  }

  private async property(tx: Tx, propertyId: string): Promise<PropertyRow> {
    const [p] = await tx.select().from(schema.properties).where(eq(schema.properties.id, propertyId));
    if (!p) throw AppError.notFound('property');
    return p;
  }

  private record(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    reservationId: string,
    meta: RequestMeta,
    action: string,
    changes: Record<string, unknown>,
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
        entityId: reservationId,
        changes,
        reason,
      },
      meta,
    );
  }

  private async load(tx: Tx, propertyId: string, stayId: string): Promise<StayDto> {
    const [row] = await tx
      .select({ stay: st, res: r, guest: schema.guests })
      .from(st)
      .innerJoin(r, eq(r.id, st.reservationId))
      .innerJoin(schema.guests, eq(schema.guests.id, st.guestId))
      .where(and(eq(st.id, stayId), eq(st.propertyId, propertyId)));
    if (!row) throw AppError.notFound('stay');
    const segments = await tx
      .select({ s: seg, roomNumber: rooms.roomNumber })
      .from(seg)
      .innerJoin(rooms, eq(rooms.id, seg.roomId))
      .where(eq(seg.stayId, stayId))
      .orderBy(asc(seg.startedAt));
    const booked = await tx
      .select({ b: rr, code: schema.roomTypes.code })
      .from(rr)
      .innerJoin(schema.roomTypes, eq(schema.roomTypes.id, rr.roomTypeId))
      .where(and(eq(rr.stayId, stayId), eq(rr.status, 'active')))
      .orderBy(desc(rr.departure));
    const current = segments.find((x) => x.s.endedAt === null) ?? segments[segments.length - 1]!;
    const latest = booked[0]!;
    return {
      id: row.stay.id,
      reservationId: row.res.id,
      bookingReference: row.res.bookingReference,
      status: row.stay.status,
      guest: {
        id: row.guest.id,
        fullName: row.guest.fullName,
        phone: row.guest.phone,
        email: row.guest.email,
        city: row.guest.city,
        nationality: row.guest.nationality,
      },
      roomId: current.s.roomId,
      roomNumber: current.roomNumber,
      roomTypeCode: latest.code,
      arrival: booked.reduce((m, x) => (x.b.arrival < m ? x.b.arrival : m), latest.b.arrival),
      departure: latest.b.departure,
      adults: latest.b.adults,
      children: latest.b.children,
      checkedInAt: row.stay.checkedInAt.toISOString(),
      segments: segments.map(({ s, roomNumber }) => ({
        roomId: s.roomId,
        roomNumber,
        fromDate: s.fromDate,
        startedAt: s.startedAt.toISOString(),
        endedAt: s.endedAt?.toISOString() ?? null,
        reason: s.reason,
      })),
    };
  }
}
