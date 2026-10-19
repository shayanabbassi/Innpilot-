import { Injectable } from '@nestjs/common';
import {
  BOARD_STATES,
  boardState,
  expandRoomRange,
  type BoardState,
  type BulkCreateRoomsRequest,
  type CreateRateRequest,
  type CreateRoomRequest,
  type CreateRoomTypeRequest,
  type RoomBoardDto,
  type RoomDto,
  type RoomTypeDto,
  type RoomTypeRateDto,
  type UpdateRoomRequest,
  type UpdateRoomTypeRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, asc, count, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { AuditService, changeSet } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';

type RoomTypeRow = typeof schema.roomTypes.$inferSelect;
type RoomRow = typeof schema.rooms.$inferSelect;
type RateRow = typeof schema.roomTypeRates.$inferSelect;

function rateDto(r: RateRow): RoomTypeRateDto {
  return {
    id: r.id,
    effectiveFrom: r.effectiveFrom,
    // Stored as NUMERIC(19,4); shown at currency precision without ever becoming a float.
    nightlyRate: Money.fromStorage(r.nightlyRate, r.currencyCode).toString(),
    currencyCode: r.currencyCode,
    createdAt: r.createdAt.toISOString(),
  };
}

function roomDto(r: RoomRow, typeCode: string): RoomDto {
  return {
    id: r.id,
    roomNumber: r.roomNumber,
    floor: r.floor,
    roomTypeId: r.roomTypeId,
    roomTypeCode: typeCode,
    housekeepingState: r.housekeepingState,
    serviceState: r.serviceState,
    active: r.active,
  };
}

const TYPE_FIELDS = [
  'name',
  'description',
  'capacityAdults',
  'capacityChildren',
  'active',
  'sortOrder',
] as const;
const ROOM_FIELDS = ['roomNumber', 'floor', 'roomTypeId', 'active'] as const;

/** Room types, rooms, base rates and the room board, always scoped to one property of the caller's tenant. */
@Injectable()
export class RoomsService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------------------------------------- helpers

  private async property(tx: Tx, propertyId: string) {
    const [p] = await tx.select().from(schema.properties).where(eq(schema.properties.id, propertyId));
    if (!p) throw AppError.notFound('property');
    return p;
  }

  private async roomType(tx: Tx, propertyId: string, id: string, lock = false): Promise<RoomTypeRow> {
    const q = tx
      .select()
      .from(schema.roomTypes)
      .where(and(eq(schema.roomTypes.propertyId, propertyId), eq(schema.roomTypes.id, id)));
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw AppError.notFound('room type');
    return row;
  }

  /** Rates in effect on `date` for each room type (latest effective_from on or before it). */
  private async currentRates(tx: Tx, typeIds: string[], date: string): Promise<Map<string, RateRow>> {
    if (typeIds.length === 0) return new Map();
    const rows = await tx
      .selectDistinctOn([schema.roomTypeRates.roomTypeId])
      .from(schema.roomTypeRates)
      .where(
        and(inArray(schema.roomTypeRates.roomTypeId, typeIds), lte(schema.roomTypeRates.effectiveFrom, date)),
      )
      .orderBy(schema.roomTypeRates.roomTypeId, desc(schema.roomTypeRates.effectiveFrom));
    return new Map(rows.map((r) => [r.roomTypeId, r]));
  }

  private record(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    meta: RequestMeta,
    e: {
      action: string;
      entityType: string;
      entityId: string;
      changes?: Record<string, unknown>;
    },
  ) {
    return this.audit.record(
      tx,
      { tenantId: auth.tenantId, propertyId, actor: { type: 'user', userId: auth.userId }, ...e },
      meta,
    );
  }

  // -------------------------------------------------------------------------------------------- room types

  listRoomTypes(auth: AuthContext, propertyId: string): Promise<RoomTypeDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const types = await tx
        .select()
        .from(schema.roomTypes)
        .where(eq(schema.roomTypes.propertyId, propertyId))
        .orderBy(asc(schema.roomTypes.sortOrder), asc(schema.roomTypes.code));
      const counts = await tx
        .select({ roomTypeId: schema.rooms.roomTypeId, n: count() })
        .from(schema.rooms)
        .where(and(eq(schema.rooms.propertyId, propertyId), eq(schema.rooms.active, true)))
        .groupBy(schema.rooms.roomTypeId);
      const countBy = new Map(counts.map((c) => [c.roomTypeId, c.n]));
      const rates = await this.currentRates(
        tx,
        types.map((t) => t.id),
        property.businessDate,
      );
      return types.map((t) => {
        const rate = rates.get(t.id);
        return {
          id: t.id,
          code: t.code,
          name: t.name,
          description: t.description,
          capacityAdults: t.capacityAdults,
          capacityChildren: t.capacityChildren,
          active: t.active,
          sortOrder: t.sortOrder,
          roomCount: countBy.get(t.id) ?? 0,
          currentRate: rate ? rateDto(rate) : null,
        };
      });
    });
  }

  async createRoomType(
    auth: AuthContext,
    propertyId: string,
    body: CreateRoomTypeRequest,
    meta: RequestMeta,
  ): Promise<RoomTypeDto> {
    try {
      const id = await this.db.tenant(auth.tenantId, async (tx) => {
        const property = await this.property(tx, propertyId);
        const [type] = await tx
          .insert(schema.roomTypes)
          .values({
            tenantId: auth.tenantId,
            propertyId,
            code: body.code,
            name: body.name,
            description: body.description ?? null,
            capacityAdults: body.capacityAdults,
            capacityChildren: body.capacityChildren,
            createdBy: auth.userId,
          })
          .returning();
        if (body.nightlyRate) {
          await tx.insert(schema.roomTypeRates).values({
            tenantId: auth.tenantId,
            propertyId,
            roomTypeId: type!.id,
            effectiveFrom: property.businessDate,
            nightlyRate: Money.of(body.nightlyRate, property.currencyCode).toStorage(),
            currencyCode: property.currencyCode,
            createdBy: auth.userId,
          });
        }
        await this.record(tx, auth, propertyId, meta, {
          action: 'room_type.created',
          entityType: 'room_type',
          entityId: type!.id,
          changes: { code: body.code, name: body.name, nightlyRate: body.nightlyRate ?? null },
        });
        return type!.id;
      });
      return this.roomTypeDto(auth, propertyId, id);
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new AppError('CONFLICT', `Room type code ${body.code} is already used at this property.`, [
          { path: 'code', message: 'This code is already in use.' },
        ]);
      }
      throw err;
    }
  }

  private async roomTypeDto(auth: AuthContext, propertyId: string, id: string): Promise<RoomTypeDto> {
    const all = await this.listRoomTypes(auth, propertyId);
    const found = all.find((t) => t.id === id);
    if (!found) throw AppError.notFound('room type');
    return found;
  }

  async updateRoomType(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: UpdateRoomTypeRequest,
    meta: RequestMeta,
  ): Promise<RoomTypeDto> {
    await this.db.tenant(auth.tenantId, async (tx) => {
      const before = await this.roomType(tx, propertyId, id, true);
      if (body.active === false && before.active) {
        const [{ n } = { n: 0 }] = await tx
          .select({ n: count() })
          .from(schema.rooms)
          .where(and(eq(schema.rooms.roomTypeId, id), eq(schema.rooms.active, true)));
        if (n > 0) {
          throw new AppError(
            'CONFLICT',
            `Move or deactivate the ${n} active room(s) of this type before deactivating it.`,
          );
        }
      }
      const [after] = await tx
        .update(schema.roomTypes)
        .set(body)
        .where(eq(schema.roomTypes.id, id))
        .returning();
      const changes = changeSet(before, after!, TYPE_FIELDS);
      if (Object.keys(changes).length > 0) {
        await this.record(tx, auth, propertyId, meta, {
          action: 'room_type.updated',
          entityType: 'room_type',
          entityId: id,
          changes,
        });
      }
    });
    return this.roomTypeDto(auth, propertyId, id);
  }

  // ------------------------------------------------------------------------------------------------- rates

  listRates(auth: AuthContext, propertyId: string, roomTypeId: string): Promise<RoomTypeRateDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.roomType(tx, propertyId, roomTypeId);
      const rows = await tx
        .select()
        .from(schema.roomTypeRates)
        .where(eq(schema.roomTypeRates.roomTypeId, roomTypeId))
        .orderBy(desc(schema.roomTypeRates.effectiveFrom));
      return rows.map(rateDto);
    });
  }

  async addRate(
    auth: AuthContext,
    propertyId: string,
    roomTypeId: string,
    body: CreateRateRequest,
    meta: RequestMeta,
  ): Promise<RoomTypeRateDto> {
    try {
      return await this.db.tenant(auth.tenantId, async (tx) => {
        const property = await this.property(tx, propertyId);
        await this.roomType(tx, propertyId, roomTypeId, true);
        const effectiveFrom = body.effectiveFrom ?? property.businessDate;
        if (effectiveFrom < property.businessDate) {
          throw AppError.validation('Rates cannot start before the business date.', [
            { path: 'effectiveFrom', message: `Choose ${property.businessDate} or later.` },
          ]);
        }
        const [rate] = await tx
          .insert(schema.roomTypeRates)
          .values({
            tenantId: auth.tenantId,
            propertyId,
            roomTypeId,
            effectiveFrom,
            nightlyRate: Money.of(body.nightlyRate, property.currencyCode).toStorage(),
            currencyCode: property.currencyCode,
            createdBy: auth.userId,
          })
          .returning();
        await this.record(tx, auth, propertyId, meta, {
          action: 'room_type.rate_added',
          entityType: 'room_type',
          entityId: roomTypeId,
          changes: {
            effectiveFrom,
            nightlyRate: rateDto(rate!).nightlyRate,
            currency: property.currencyCode,
          },
        });
        return rateDto(rate!);
      });
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new AppError(
          'CONFLICT',
          'A rate already starts on that date. Remove it first or pick another date.',
          [{ path: 'effectiveFrom', message: 'A rate already starts on this date.' }],
        );
      }
      throw err;
    }
  }

  /** Only rates that have not taken effect can be removed; anything already in effect is kept as history. */
  removeRate(auth: AuthContext, propertyId: string, roomTypeId: string, rateId: string, meta: RequestMeta) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      await this.roomType(tx, propertyId, roomTypeId, true);
      const [rate] = await tx
        .select()
        .from(schema.roomTypeRates)
        .where(and(eq(schema.roomTypeRates.id, rateId), eq(schema.roomTypeRates.roomTypeId, roomTypeId)));
      if (!rate) throw AppError.notFound('rate');
      if (rate.effectiveFrom <= property.businessDate) {
        throw new AppError(
          'CONFLICT',
          'This rate is already in effect and is kept as history. Add a new rate to change the price.',
        );
      }
      await tx.delete(schema.roomTypeRates).where(eq(schema.roomTypeRates.id, rateId));
      await this.record(tx, auth, propertyId, meta, {
        action: 'room_type.rate_removed',
        entityType: 'room_type',
        entityId: roomTypeId,
        changes: { effectiveFrom: rate.effectiveFrom, nightlyRate: rateDto(rate).nightlyRate },
      });
      return null;
    });
  }

  // ------------------------------------------------------------------------------------------------- rooms

  listRooms(auth: AuthContext, propertyId: string): Promise<RoomDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const rows = await tx
        .select({ room: schema.rooms, code: schema.roomTypes.code })
        .from(schema.rooms)
        .innerJoin(schema.roomTypes, eq(schema.roomTypes.id, schema.rooms.roomTypeId))
        .where(eq(schema.rooms.propertyId, propertyId))
        // Natural order: 2 before 10, then letters.
        .orderBy(sql`length(${schema.rooms.roomNumber})`, asc(schema.rooms.roomNumber));
      return rows.map((r) => roomDto(r.room, r.code));
    });
  }

  private async assertTypeUsable(tx: Tx, propertyId: string, roomTypeId: string): Promise<RoomTypeRow> {
    const type = await tx
      .select()
      .from(schema.roomTypes)
      .where(and(eq(schema.roomTypes.propertyId, propertyId), eq(schema.roomTypes.id, roomTypeId)));
    if (!type[0]) {
      throw AppError.validation('Review the highlighted fields.', [
        { path: 'roomTypeId', message: 'Choose a room type of this property.' },
      ]);
    }
    if (!type[0].active) {
      throw AppError.validation('Review the highlighted fields.', [
        { path: 'roomTypeId', message: 'This room type is inactive.' },
      ]);
    }
    return type[0];
  }

  async createRooms(
    auth: AuthContext,
    propertyId: string,
    body: CreateRoomRequest | BulkCreateRoomsRequest,
    meta: RequestMeta,
  ): Promise<RoomDto[]> {
    const numbers = 'roomNumber' in body ? [body.roomNumber] : expandRoomRange(body);
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const type = await this.assertTypeUsable(tx, propertyId, body.roomTypeId);
      // Report every clash at once instead of failing on the first unique violation.
      const taken = await tx
        .select({ n: schema.rooms.roomNumber })
        .from(schema.rooms)
        .where(
          and(
            eq(schema.rooms.propertyId, propertyId),
            inArray(
              sql`lower(${schema.rooms.roomNumber}::text)`,
              numbers.map((n) => n.toLowerCase()),
            ),
          ),
        );
      if (taken.length > 0) {
        const list = taken.map((t) => t.n).join(', ');
        throw new AppError('CONFLICT', `These room numbers already exist: ${list}. Nothing was added.`, [
          { path: 'roomNumber' in body ? 'roomNumber' : 'from', message: `Already exist: ${list}` },
        ]);
      }
      const rows = await tx
        .insert(schema.rooms)
        .values(
          numbers.map((n) => ({
            tenantId: auth.tenantId,
            propertyId,
            roomTypeId: type.id,
            roomNumber: n,
            floor: body.floor || null,
            createdBy: auth.userId,
          })),
        )
        .returning();
      await this.record(tx, auth, propertyId, meta, {
        action: rows.length === 1 ? 'room.created' : 'room.bulk_created',
        entityType: rows.length === 1 ? 'room' : 'room_type',
        entityId: rows.length === 1 ? rows[0]!.id : type.id,
        changes: { roomNumbers: numbers, roomType: type.code, floor: body.floor ?? null },
      });
      return rows.map((r) => roomDto(r, type.code));
    });
  }

  async updateRoom(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: UpdateRoomRequest,
    meta: RequestMeta,
  ): Promise<RoomDto> {
    try {
      return await this.db.tenant(auth.tenantId, async (tx) => {
        const [before] = await tx
          .select()
          .from(schema.rooms)
          .where(and(eq(schema.rooms.propertyId, propertyId), eq(schema.rooms.id, id)))
          .for('update');
        if (!before) throw AppError.notFound('room');
        const type = body.roomTypeId
          ? await this.assertTypeUsable(tx, propertyId, body.roomTypeId)
          : await this.roomType(tx, propertyId, before.roomTypeId);
        const [after] = await tx
          .update(schema.rooms)
          .set({ ...body, ...(body.floor === '' ? { floor: null } : {}) })
          .where(eq(schema.rooms.id, id))
          .returning();
        const changes = changeSet(before, after!, ROOM_FIELDS);
        if (Object.keys(changes).length > 0) {
          await this.record(tx, auth, propertyId, meta, {
            action: 'room.updated',
            entityType: 'room',
            entityId: id,
            changes,
          });
        }
        return roomDto(after!, type.code);
      });
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new AppError('CONFLICT', `Room ${body.roomNumber} already exists at this property.`, [
          { path: 'roomNumber', message: 'This room number is already in use.' },
        ]);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------------------------- room board

  board(auth: AuthContext, propertyId: string): Promise<RoomBoardDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const rows = await tx
        .select({ room: schema.rooms, code: schema.roomTypes.code, typeName: schema.roomTypes.name })
        .from(schema.rooms)
        .innerJoin(schema.roomTypes, eq(schema.roomTypes.id, schema.rooms.roomTypeId))
        .where(eq(schema.rooms.propertyId, propertyId))
        .orderBy(sql`length(${schema.rooms.roomNumber})`, asc(schema.rooms.roomNumber));
      // Occupancy joins in when stays exist (slice 2.5).
      const rooms = rows.map((r) => ({
        ...roomDto(r.room, r.code),
        roomTypeName: r.typeName,
        boardState: boardState(r.room),
      }));
      const counts = Object.fromEntries(BOARD_STATES.map((s) => [s, 0])) as Record<BoardState, number>;
      for (const r of rooms) counts[r.boardState] += 1;
      return { businessDate: property.businessDate, rooms, counts };
    });
  }
}
