import { Injectable } from '@nestjs/common';
import { addDays, type CreateTicketRequest, type TicketDto, type TicketListQuery } from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { ReservationsService } from '../reservations/reservations.service';

const tickets = schema.maintenanceTickets;
const rooms = schema.rooms;
const rr = schema.reservationRooms;
type TicketRow = typeof tickets.$inferSelect;
const ACTIVE = ['open', 'in_progress'] as const;

/** Exclusive end used when a period has no end date: far enough to cover every possible future booking. */
const OPEN_ENDED_DAYS = 800;

/**
 * Maintenance tickets, optionally taking a room out of order for a dated period. Rules (P2-14):
 * - never while a guest is in the room during the period;
 * - assigned future bookings in the period block it, unless a manager overrides with a reason, which unassigns
 *   them for the front desk to re-room;
 * - never if it would leave the room type oversold on any night.
 * rooms.service_state follows the period covering the business date.
 */
@Injectable()
export class MaintenanceService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly reservations: ReservationsService,
  ) {}

  list(auth: AuthContext, propertyId: string, q: TicketListQuery): Promise<TicketDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const status =
        q.status === 'active' ? inArray(tickets.status, [...ACTIVE]) : eq(tickets.status, q.status);
      const rows = await tx
        .select({ t: tickets, roomNumber: rooms.roomNumber, reporter: schema.users.fullName })
        .from(tickets)
        .leftJoin(rooms, eq(rooms.id, tickets.roomId))
        .leftJoin(schema.users, eq(schema.users.id, tickets.reportedBy))
        .where(and(eq(tickets.propertyId, propertyId), status))
        .orderBy(
          sql`case ${tickets.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
          desc(tickets.createdAt),
        )
        .limit(500);
      return rows.map(({ t, roomNumber, reporter }) => this.dto(t, roomNumber, reporter));
    });
  }

  create(
    auth: AuthContext,
    propertyId: string,
    body: CreateTicketRequest,
    meta: RequestMeta,
  ): Promise<TicketDto> {
    return this.reservations.mapConflicts(() =>
      this.db.tenant(auth.tenantId, async (tx) => {
        const [property] = await tx
          .select()
          .from(schema.properties)
          .where(eq(schema.properties.id, propertyId));
        if (!property) throw AppError.notFound('property');
        let room: typeof rooms.$inferSelect | undefined;
        if (body.roomId) {
          [room] = await tx
            .select()
            .from(rooms)
            .where(and(eq(rooms.id, body.roomId), eq(rooms.propertyId, propertyId)))
            .for('update');
          if (!room) {
            throw AppError.validation('Review the highlighted fields.', [
              { path: 'roomId', message: 'Choose a room of this property.' },
            ]);
          }
        }

        let unassigned: { reservationId: string; bookingReference: string }[] = [];
        const ooo = body.outOfOrder;
        if (ooo && room) {
          if (!auth.permissionsByProperty.get(propertyId)?.has('room.out_of_order')) {
            throw AppError.forbidden(
              'Only a manager can take a room out of order. Report the problem without it.',
            );
          }
          if (ooo.from < property.businessDate) {
            throw AppError.validation('An out-of-order period cannot start in the past.', [
              { path: 'outOfOrder.from', message: `Choose ${property.businessDate} or later.` },
            ]);
          }
          const end = ooo.to ?? addDays(ooo.from, OPEN_ENDED_DAYS);
          // Serialise with bookings of this room type while inventory is checked.
          const [type] = await tx
            .select()
            .from(schema.roomTypes)
            .where(eq(schema.roomTypes.id, room.roomTypeId))
            .for('update');

          const overlapping = await tx
            .select({ booked: rr, ref: schema.reservations.bookingReference })
            .from(rr)
            .innerJoin(schema.reservations, eq(schema.reservations.id, rr.reservationId))
            .where(
              and(
                eq(rr.roomId, room.id),
                eq(rr.status, 'active'),
                lt(rr.arrival, end),
                gt(rr.departure, ooo.from),
              ),
            )
            .for('update', { of: rr });
          const inHouse = overlapping.filter((o) => o.booked.stayId);
          const occupiedNow = await tx
            .select({ id: schema.stayRooms.id })
            .from(schema.stayRooms)
            .where(and(eq(schema.stayRooms.roomId, room.id), isNull(schema.stayRooms.endedAt)));
          if (inHouse.length > 0 || (ooo.from === property.businessDate && occupiedNow.length > 0)) {
            throw new AppError(
              'CONFLICT',
              `A guest is staying in room ${room.roomNumber} during that period. Move the guest first.`,
            );
          }
          if (overlapping.length > 0 && !ooo.overrideReason) {
            const refs = [...new Set(overlapping.map((o) => o.ref))];
            throw new AppError(
              'CONFLICT',
              `Room ${room.roomNumber} is assigned to booking(s) ${refs.join(', ')} in that period.`,
              [
                {
                  path: 'outOfOrder.overrideReason',
                  message: 'Give a reason to unassign these bookings from the room.',
                },
              ],
            );
          }
          if (overlapping.length > 0) {
            await tx
              .update(rr)
              .set({ roomId: null })
              .where(
                inArray(
                  rr.id,
                  overlapping.map((o) => o.booked.id),
                ),
              );
            unassigned = [...new Map(overlapping.map((o) => [o.booked.reservationId, o.ref]))].map(
              ([reservationId, bookingReference]) => ({ reservationId, bookingReference }),
            );
          }
          const [ticket] = await tx
            .insert(tickets)
            .values(this.values(auth, propertyId, body, ooo.from, ooo.to ?? null, unassigned))
            .returning();
          // Nights with bookings of this type, now counted against one room fewer.
          const [last] = await tx
            .select({ d: sql<string | null>`max(${rr.departure})::text` })
            .from(rr)
            .where(and(eq(rr.roomTypeId, type!.id), eq(rr.status, 'active'), gt(rr.departure, ooo.from)));
          const checkTo = last?.d && last.d < end ? last.d : end;
          if (checkTo > ooo.from) {
            const over = (await this.reservations.nightlyLoad(tx, type!.id, ooo.from, checkTo, []))
              .filter((n) => n.booked > n.supply)
              .map((n) => n.night);
            if (over.length > 0) {
              throw new AppError(
                'ROOM_UNAVAILABLE',
                `Taking room ${room.roomNumber} out would overbook ${type!.code} on ${over.join(', ')}. Move or cancel bookings first.`,
              );
            }
          }
          if (ooo.from <= property.businessDate)
            await this.setService(tx, auth, propertyId, room, 'out_of_order', body.description);
          await this.audit.record(
            tx,
            {
              tenantId: auth.tenantId,
              propertyId,
              actor: { type: 'user', userId: auth.userId },
              action: 'room.out_of_order',
              entityType: 'room',
              entityId: room.id,
              changes: { ticketId: ticket!.id, from: ooo.from, to: ooo.to ?? null, unassigned },
              reason: ooo.overrideReason ?? null,
            },
            meta,
          );
          return this.load(tx, ticket!.id);
        }

        const [ticket] = await tx
          .insert(tickets)
          .values(this.values(auth, propertyId, body, null, null, []))
          .returning();
        await this.audit.record(
          tx,
          {
            tenantId: auth.tenantId,
            propertyId,
            actor: { type: 'user', userId: auth.userId },
            action: 'maintenance.ticket_created',
            entityType: room ? 'room' : 'property',
            entityId: room?.id ?? propertyId,
            changes: { ticketId: ticket!.id, category: body.category, priority: body.priority },
          },
          meta,
        );
        return this.load(tx, ticket!.id);
      }),
    );
  }

  start(auth: AuthContext, propertyId: string, id: string) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const t = await this.lock(tx, propertyId, id);
      if (t.status !== 'open') throw new AppError('CONFLICT', 'Only an open ticket can be started.');
      await tx.update(tickets).set({ status: 'in_progress' }).where(eq(tickets.id, id));
      return this.load(tx, id);
    });
  }

  /** Closes the ticket. An out-of-order period ends today; the room returns to service if nothing else holds it. */
  resolve(auth: AuthContext, propertyId: string, id: string, note: string, meta: RequestMeta) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const t = await this.lock(tx, propertyId, id);
      if (t.status === 'resolved' || t.status === 'cancelled')
        throw new AppError('CONFLICT', 'This ticket is closed.');
      const [property] = await tx
        .select()
        .from(schema.properties)
        .where(eq(schema.properties.id, propertyId));
      const today = property!.businessDate;
      const patch: Partial<typeof tickets.$inferInsert> = {
        status: 'resolved',
        resolvedAt: new Date(),
        resolvedBy: auth.userId,
        resolutionNote: note,
      };
      if (t.outOfOrderFrom) {
        if (t.roomId && !auth.permissionsByProperty.get(propertyId)?.has('room.out_of_order')) {
          throw AppError.forbidden('Only a manager can return an out-of-order room to service.');
        }
        if (t.outOfOrderFrom >= today) {
          // Never took effect: the period is withdrawn (kept in the audit log).
          patch.outOfOrderFrom = null;
          patch.outOfOrderTo = null;
        } else if (!t.outOfOrderTo || t.outOfOrderTo > today) {
          patch.outOfOrderTo = today;
        }
      }
      await tx.update(tickets).set(patch).where(eq(tickets.id, id));
      if (t.roomId && t.outOfOrderFrom) {
        const [room] = await tx.select().from(rooms).where(eq(rooms.id, t.roomId)).for('update');
        const still = await this.coveringToday(tx, t.roomId, today);
        if (!still && room!.serviceState === 'out_of_order') {
          await this.setService(tx, auth, propertyId, room!, 'in_service', note);
        }
        await this.audit.record(
          tx,
          {
            tenantId: auth.tenantId,
            propertyId,
            actor: { type: 'user', userId: auth.userId },
            action: 'room.returned_to_service',
            entityType: 'room',
            entityId: t.roomId,
            changes: { ticketId: id },
            reason: note,
          },
          meta,
        );
      }
      return this.load(tx, id);
    });
  }

  // ------------------------------------------------------------------------------------------- internals

  private async coveringToday(tx: Tx, roomId: string, today: string): Promise<boolean> {
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(
          eq(tickets.roomId, roomId),
          inArray(tickets.status, [...ACTIVE]),
          isNotNull(tickets.outOfOrderFrom),
          sql`${tickets.outOfOrderFrom} <= ${today}::date`,
          or(isNull(tickets.outOfOrderTo), sql`${tickets.outOfOrderTo} > ${today}::date`),
        ),
      );
    return rows.length > 0;
  }

  private async setService(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    room: typeof rooms.$inferSelect,
    to: 'in_service' | 'out_of_order',
    reason: string,
  ) {
    if (room.serviceState === to) return;
    await tx.update(rooms).set({ serviceState: to }).where(eq(rooms.id, room.id));
    await tx.insert(schema.roomStatusEvents).values({
      tenantId: auth.tenantId,
      propertyId,
      roomId: room.id,
      dimension: 'service',
      fromState: room.serviceState,
      toState: to,
      reason: reason.slice(0, 300),
      actorUserId: auth.userId,
    });
  }

  private values(
    auth: AuthContext,
    propertyId: string,
    body: CreateTicketRequest,
    from: string | null,
    to: string | null,
    unassigned: { reservationId: string; bookingReference: string }[],
  ): typeof tickets.$inferInsert {
    return {
      tenantId: auth.tenantId,
      propertyId,
      roomId: body.roomId ?? null,
      category: body.category,
      priority: body.priority,
      description: body.description,
      outOfOrderFrom: from,
      outOfOrderTo: to,
      reportedBy: auth.userId,
      unassignedReservations: unassigned,
    };
  }

  private async lock(tx: Tx, propertyId: string, id: string): Promise<TicketRow> {
    const [t] = await tx
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.propertyId, propertyId)))
      .for('update');
    if (!t) throw AppError.notFound('ticket');
    return t;
  }

  private async load(tx: Tx, id: string): Promise<TicketDto> {
    const [row] = await tx
      .select({ t: tickets, roomNumber: rooms.roomNumber, reporter: schema.users.fullName })
      .from(tickets)
      .leftJoin(rooms, eq(rooms.id, tickets.roomId))
      .leftJoin(schema.users, eq(schema.users.id, tickets.reportedBy))
      .where(eq(tickets.id, id));
    if (!row) throw AppError.notFound('ticket');
    return this.dto(row.t, row.roomNumber, row.reporter);
  }

  private dto(t: TicketRow, roomNumber: string | null, reporter: string | null): TicketDto {
    return {
      id: t.id,
      roomId: t.roomId,
      roomNumber,
      category: t.category,
      priority: t.priority,
      status: t.status,
      description: t.description,
      outOfOrderFrom: t.outOfOrderFrom,
      outOfOrderTo: t.outOfOrderTo,
      reportedByName: reporter,
      createdAt: t.createdAt.toISOString(),
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      resolutionNote: t.resolutionNote,
      unassignedBookings: t.unassignedReservations,
    };
  }
}
