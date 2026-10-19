import { Controller, Get, Query } from '@nestjs/common';
import { auditEventsQuery, type AuditEventDto, type AuditEventsQuery } from '@innpilot/contracts';
import { schema } from '@innpilot/db';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { Page } from '../common/envelope.interceptor';
import type { AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { Db } from '../db/db.module';

interface Cursor {
  at: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Postgres timestamptz text output, e.g. 2026-10-19 14:06:45.123456+00
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (
      typeof c.at !== 'string' ||
      typeof c.id !== 'string' ||
      !UUID.test(c.id) ||
      !PG_TIMESTAMP.test(c.at)
    ) {
      throw new Error('bad cursor');
    }
    return c;
  } catch {
    throw AppError.validation('The page cursor is invalid. Reload the list.');
  }
}

@Controller('audit-events')
export class AuditController {
  constructor(private readonly db: Db) {}

  /** Newest first, keyset-paginated so the list stays stable while new events arrive. */
  @Get()
  @RequirePermission('audit.read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(auditEventsQuery)) query: AuditEventsQuery,
  ): Promise<Page<AuditEventDto>> {
    const e = schema.auditEvents;
    const conditions: (SQL | undefined)[] = [
      query.entityType ? eq(e.entityType, query.entityType) : undefined,
      query.entityId ? eq(e.entityId, query.entityId) : undefined,
    ];
    if (query.cursor) {
      const c = decodeCursor(query.cursor);
      // Row comparison on the exact database timestamp text: JS Dates would drop microseconds.
      conditions.push(sql`(${e.occurredAt}, ${e.id}) < (${c.at}::timestamptz, ${c.id}::uuid)`);
    }
    return this.db.tenant(auth.tenantId, async (tx) => {
      const rows = await tx
        .select({ event: e, actorName: schema.users.fullName, cursorAt: sql<string>`${e.occurredAt}::text` })
        .from(e)
        .leftJoin(schema.users, eq(schema.users.id, e.actorUserId))
        .where(and(...conditions))
        .orderBy(desc(e.occurredAt), desc(e.id))
        .limit(query.limit + 1);
      const page = rows.slice(0, query.limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > query.limit && last ? encodeCursor({ at: last.cursorAt, id: last.event.id }) : null;
      return new Page(
        page.map(({ event, actorName }) => ({
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
        })),
        nextCursor,
      );
    });
  }
}
