import { Injectable } from '@nestjs/common';
import {
  canTransition,
  ROLES,
  type CompleteTaskRequest,
  type CreateTaskRequest,
  type HousekeepingState,
  type RoleCode,
  type StaffMemberDto,
  type TaskDto,
  type TaskListQuery,
  type UpdateTaskRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';

const tasks = schema.housekeepingTasks;
const rooms = schema.rooms;
type TaskRow = typeof tasks.$inferSelect;

/**
 * Room cleaning and inspection. Room states only change through the allowed transitions; tasks follow the room:
 * a room that becomes dirty gets exactly one open cleaning task, starting it marks the room as being cleaned, and
 * finishing it marks the room clean. Housekeeping screens never carry guest data.
 */
@Injectable()
export class HousekeepingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------------------- room states

  setState(
    auth: AuthContext,
    propertyId: string,
    roomId: string,
    to: HousekeepingState,
    reason: string | undefined,
    meta: RequestMeta,
  ) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.changeState(tx, auth, propertyId, roomId, to, reason ?? null, meta);
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId));
      return { id: room!.id, housekeepingState: room!.housekeepingState };
    });
  }

  /** For other modules (room moves now, check-out later): the room needs cleaning. */
  async markDirty(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    roomId: string,
    reason: string,
    meta: RequestMeta | null,
  ) {
    const [room] = await tx.select().from(rooms).where(eq(rooms.id, roomId));
    if (!room) return;
    if (room.housekeepingState === 'dirty') {
      await this.ensureTask(tx, auth, propertyId, roomId, 'clean', 'room_dirty');
      return;
    }
    await this.changeState(tx, auth, propertyId, roomId, 'dirty', reason, meta);
  }

  private async changeState(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    roomId: string,
    to: HousekeepingState,
    reason: string | null,
    meta: RequestMeta | null,
    source: 'room_dirty' | 'inspection_failed' = 'room_dirty',
  ): Promise<void> {
    const [room] = await tx
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, roomId), eq(rooms.propertyId, propertyId)))
      .for('update');
    if (!room) throw AppError.notFound('room');
    const from = room.housekeepingState;
    if (from === to) return;
    if (!canTransition(from, to)) {
      throw new AppError('CONFLICT', `A ${from} room cannot be marked ${to}.`, [
        { path: 'state', message: `Allowed from ${from}: see the housekeeping rules.` },
      ]);
    }
    await tx.update(rooms).set({ housekeepingState: to }).where(eq(rooms.id, roomId));
    await tx.insert(schema.roomStatusEvents).values({
      tenantId: auth.tenantId,
      propertyId,
      roomId,
      dimension: 'housekeeping',
      fromState: from,
      toState: to,
      reason,
      actorUserId: auth.userId,
    });

    // Keep tasks in step with the room.
    const now = sql`now()`;
    const openOf = (type: 'clean' | 'inspect') =>
      and(eq(tasks.roomId, roomId), eq(tasks.taskType, type), inArray(tasks.status, ['open', 'in_progress']));
    if (to === 'dirty') {
      await tx
        .update(tasks)
        .set({ status: 'cancelled', completedAt: now, completedBy: auth.userId })
        .where(openOf('inspect'));
      await this.ensureTask(tx, auth, propertyId, roomId, 'clean', source);
    } else if (to === 'cleaning') {
      await this.ensureTask(tx, auth, propertyId, roomId, 'clean', 'room_dirty');
      await tx
        .update(tasks)
        .set({ status: 'in_progress', startedAt: sql`coalesce(${tasks.startedAt}, now())` })
        .where(openOf('clean'));
    } else if (to === 'clean') {
      await tx
        .update(tasks)
        .set({ status: 'done', completedAt: now, completedBy: auth.userId })
        .where(openOf('clean'));
    } else if (to === 'inspected') {
      await tx
        .update(tasks)
        .set({ status: 'done', completedAt: now, completedBy: auth.userId })
        .where(openOf('inspect'));
    }
    if (meta) {
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId,
          actor: { type: 'user', userId: auth.userId },
          action: 'room.housekeeping_changed',
          entityType: 'room',
          entityId: roomId,
          changes: { from, to },
          reason,
        },
        meta,
      );
    }
  }

  /** Creates the open task of this type for the room unless one exists (the partial unique index decides). */
  private async ensureTask(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    roomId: string,
    taskType: 'clean' | 'inspect',
    source: 'manual' | 'room_dirty' | 'inspection_failed',
    extra: { assignedUserId?: string | null; notes?: string | null } = {},
  ): Promise<string | null> {
    const [row] = await tx
      .insert(tasks)
      .values({
        tenantId: auth.tenantId,
        propertyId,
        roomId,
        taskType,
        source,
        createdBy: auth.userId,
        assignedUserId: extra.assignedUserId ?? null,
        notes: extra.notes ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: tasks.id });
    return row?.id ?? null;
  }

  // ---------------------------------------------------------------------------------------------- tasks

  list(auth: AuthContext, propertyId: string, q: TaskListQuery): Promise<TaskDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const status =
        q.status === 'active' ? inArray(tasks.status, ['open', 'in_progress']) : eq(tasks.status, q.status);
      const rows = await tx
        .select({ t: tasks, room: rooms, code: schema.roomTypes.code, assignee: schema.users.fullName })
        .from(tasks)
        .innerJoin(rooms, eq(rooms.id, tasks.roomId))
        .innerJoin(schema.roomTypes, eq(schema.roomTypes.id, rooms.roomTypeId))
        .leftJoin(schema.users, eq(schema.users.id, tasks.assignedUserId))
        .where(
          and(
            eq(tasks.propertyId, propertyId),
            status,
            // "Mine" includes unassigned tasks, which anyone on shift may pick up.
            q.mine === 'true'
              ? or(eq(tasks.assignedUserId, auth.userId), isNull(tasks.assignedUserId))
              : undefined,
          ),
        )
        .orderBy(sql`length(${rooms.roomNumber})`, asc(rooms.roomNumber), asc(tasks.createdAt))
        .limit(500);
      return rows.map(({ t, room, code, assignee }) => this.dto(t, room, code, assignee));
    });
  }

  create(
    auth: AuthContext,
    propertyId: string,
    body: CreateTaskRequest,
    meta: RequestMeta,
  ): Promise<TaskDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [room] = await tx
        .select()
        .from(rooms)
        .where(and(eq(rooms.id, body.roomId), eq(rooms.propertyId, propertyId)));
      if (!room) {
        throw AppError.validation('Review the highlighted fields.', [
          { path: 'roomId', message: 'Choose a room.' },
        ]);
      }
      if (body.assignedUserId) await this.assertAssignable(tx, propertyId, body.assignedUserId);
      const id = await this.ensureTask(tx, auth, propertyId, room.id, body.taskType, 'manual', {
        assignedUserId: body.assignedUserId ?? null,
        notes: body.notes ?? null,
      });
      if (!id) {
        throw new AppError('CONFLICT', `Room ${room.roomNumber} already has an open ${body.taskType} task.`);
      }
      await this.record(tx, auth, propertyId, room.id, meta, 'housekeeping.task_created', {
        taskId: id,
        taskType: body.taskType,
      });
      return this.load(tx, propertyId, id);
    });
  }

  update(auth: AuthContext, propertyId: string, id: string, body: UpdateTaskRequest, meta: RequestMeta) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const task = await this.lock(tx, propertyId, id);
      if (task.status === 'done' || task.status === 'cancelled')
        throw new AppError('CONFLICT', 'This task is closed.');
      if (body.assignedUserId) await this.assertAssignable(tx, propertyId, body.assignedUserId);
      await tx.update(tasks).set(body).where(eq(tasks.id, id));
      if ('assignedUserId' in body) {
        await this.record(tx, auth, propertyId, task.roomId, meta, 'housekeeping.task_assigned', {
          taskId: id,
          to: body.assignedUserId,
        });
      }
      return this.load(tx, propertyId, id);
    });
  }

  start(auth: AuthContext, propertyId: string, id: string, meta: RequestMeta) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const task = await this.lock(tx, propertyId, id);
      if (task.status !== 'open') throw new AppError('CONFLICT', 'Only an open task can be started.');
      if (task.taskType === 'clean') {
        await this.changeState(tx, auth, propertyId, task.roomId, 'cleaning', null, meta);
      } else {
        await tx
          .update(tasks)
          .set({ status: 'in_progress', startedAt: sql`now()` })
          .where(eq(tasks.id, id));
      }
      if (!task.assignedUserId)
        await tx.update(tasks).set({ assignedUserId: auth.userId }).where(eq(tasks.id, id));
      return this.load(tx, propertyId, id);
    });
  }

  /** Cleaning done → room clean. Inspection passed → inspected; failed → dirty with a new cleaning task. */
  complete(auth: AuthContext, propertyId: string, id: string, body: CompleteTaskRequest, meta: RequestMeta) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const task = await this.lock(tx, propertyId, id);
      if (task.status === 'done' || task.status === 'cancelled')
        throw new AppError('CONFLICT', 'This task is closed.');
      if (body.notes) await tx.update(tasks).set({ notes: body.notes }).where(eq(tasks.id, id));
      if (task.taskType === 'clean') {
        const [room] = await tx.select().from(rooms).where(eq(rooms.id, task.roomId));
        if (room!.housekeepingState === 'dirty') {
          await this.changeState(tx, auth, propertyId, task.roomId, 'cleaning', null, null);
        }
        await this.changeState(tx, auth, propertyId, task.roomId, 'clean', body.notes ?? null, meta);
      } else {
        const [room] = await tx.select().from(rooms).where(eq(rooms.id, task.roomId));
        if (room!.housekeepingState !== 'clean') {
          throw new AppError('CONFLICT', 'Only a clean room can be inspected.');
        }
        if (body.passed === false) {
          await tx
            .update(tasks)
            .set({ status: 'done', completedAt: sql`now()`, completedBy: auth.userId })
            .where(eq(tasks.id, id));
          await this.changeState(
            tx,
            auth,
            propertyId,
            task.roomId,
            'dirty',
            body.notes ?? 'Inspection failed',
            meta,
            'inspection_failed',
          );
        } else {
          await this.changeState(tx, auth, propertyId, task.roomId, 'inspected', body.notes ?? null, meta);
        }
      }
      return this.load(tx, propertyId, id);
    });
  }

  cancel(auth: AuthContext, propertyId: string, id: string, meta: RequestMeta) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const task = await this.lock(tx, propertyId, id);
      if (task.status === 'done' || task.status === 'cancelled')
        throw new AppError('CONFLICT', 'This task is closed.');
      const [room] = await tx.select().from(rooms).where(eq(rooms.id, task.roomId));
      if (
        task.taskType === 'clean' &&
        room!.housekeepingState !== 'clean' &&
        room!.housekeepingState !== 'inspected'
      ) {
        throw new AppError(
          'CONFLICT',
          'The room still needs cleaning, so its cleaning task cannot be cancelled.',
        );
      }
      await tx
        .update(tasks)
        .set({ status: 'cancelled', completedAt: sql`now()`, completedBy: auth.userId })
        .where(eq(tasks.id, id));
      await this.record(tx, auth, propertyId, task.roomId, meta, 'housekeeping.task_cancelled', {
        taskId: id,
      });
      return this.load(tx, propertyId, id);
    });
  }

  /** Staff who can be given housekeeping tasks at this property. */
  staff(auth: AuthContext, propertyId: string): Promise<StaffMemberDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const rows = await tx
        .select({
          id: schema.users.id,
          fullName: schema.users.fullName,
          role: schema.userRoles.roleCode,
          prop: schema.userRoles.propertyId,
        })
        .from(schema.users)
        .innerJoin(schema.userRoles, eq(schema.userRoles.userId, schema.users.id))
        .where(eq(schema.users.status, 'active'));
      const eligible = new Map<string, string>();
      for (const r of rows) {
        if (
          (r.prop === null || r.prop === propertyId) &&
          ROLES[r.role as RoleCode].permissions.includes('housekeeping.write')
        ) {
          eligible.set(r.id, r.fullName);
        }
      }
      return [...eligible]
        .map(([id, fullName]) => ({ id, fullName }))
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
    });
  }

  // ------------------------------------------------------------------------------------------- internals

  private async assertAssignable(tx: Tx, propertyId: string, userId: string) {
    const rows = await tx
      .select({
        role: schema.userRoles.roleCode,
        prop: schema.userRoles.propertyId,
        status: schema.users.status,
      })
      .from(schema.userRoles)
      .innerJoin(schema.users, eq(schema.users.id, schema.userRoles.userId))
      .where(eq(schema.userRoles.userId, userId));
    const ok = rows.some(
      (r) =>
        r.status === 'active' &&
        (r.prop === null || r.prop === propertyId) &&
        ROLES[r.role as RoleCode].permissions.includes('housekeeping.write'),
    );
    if (!ok) {
      throw AppError.validation('Review the highlighted fields.', [
        { path: 'assignedUserId', message: 'Choose a housekeeping staff member of this property.' },
      ]);
    }
  }

  private async lock(tx: Tx, propertyId: string, id: string): Promise<TaskRow> {
    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.propertyId, propertyId)))
      .for('update');
    if (!task) throw AppError.notFound('task');
    return task;
  }

  private record(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    roomId: string,
    meta: RequestMeta,
    action: string,
    changes: Record<string, unknown>,
  ) {
    return this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType: 'room',
        entityId: roomId,
        changes,
      },
      meta,
    );
  }

  private async load(tx: Tx, propertyId: string, id: string): Promise<TaskDto> {
    const [row] = await tx
      .select({ t: tasks, room: rooms, code: schema.roomTypes.code, assignee: schema.users.fullName })
      .from(tasks)
      .innerJoin(rooms, eq(rooms.id, tasks.roomId))
      .innerJoin(schema.roomTypes, eq(schema.roomTypes.id, rooms.roomTypeId))
      .leftJoin(schema.users, eq(schema.users.id, tasks.assignedUserId))
      .where(and(eq(tasks.id, id), eq(tasks.propertyId, propertyId)));
    if (!row) throw AppError.notFound('task');
    return this.dto(row.t, row.room, row.code, row.assignee);
  }

  private dto(t: TaskRow, room: typeof rooms.$inferSelect, code: string, assignee: string | null): TaskDto {
    return {
      id: t.id,
      roomId: t.roomId,
      roomNumber: room.roomNumber,
      floor: room.floor,
      roomTypeCode: code,
      housekeepingState: room.housekeepingState,
      taskType: t.taskType,
      status: t.status,
      source: t.source,
      assignedUserId: t.assignedUserId,
      assignedName: assignee,
      notes: t.notes,
      createdAt: t.createdAt.toISOString(),
      startedAt: t.startedAt?.toISOString() ?? null,
      completedAt: t.completedAt?.toISOString() ?? null,
    };
  }
}
