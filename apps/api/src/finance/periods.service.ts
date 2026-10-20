import { Injectable } from '@nestjs/common';
import type { FiscalPeriodDto, ReopenPeriodRequest } from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { monthOf, PostingService } from './posting.service';

const p = schema.fiscalPeriods;
const closer = alias(schema.users, 'closer');
const reopener = alias(schema.users, 'reopener');

/** How many months the period list shows back from the latest business date. */
const MONTHS_SHOWN = 12;

/**
 * Monthly accounting periods (FIN-005). Closing blocks all posting into the month; reopening needs its own
 * permission and a reason, and both are audited (AUD-001).
 */
@Injectable()
export class PeriodsService {
  constructor(
    private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
  ) {}

  /** The last 12 months up to the latest business date, plus any older months already closed or used. */
  list(auth: AuthContext): Promise<FiscalPeriodDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [latest] = await tx
        .select({ d: sql<string>`max(${schema.properties.businessDate})::text` })
        .from(schema.properties);
      const current = monthOf(latest?.d ?? new Date().toISOString().slice(0, 10)).start;
      const rows = await tx
        .select({ p, closedByName: closer.fullName, reopenedByName: reopener.fullName })
        .from(p)
        .leftJoin(closer, eq(closer.id, p.closedBy))
        .leftJoin(reopener, eq(reopener.id, p.reopenedBy));
      const counts = await tx.execute<{ month: string; posted: number; drafts: number }>(sql`
        select to_char(accounting_date, 'YYYY-MM') as month,
               count(*) filter (where status <> 'draft')::int as posted,
               count(*) filter (where status = 'draft')::int as drafts
        from journal_entries group by 1`);
      const countByMonth = new Map(counts.rows.map((c) => [c.month, c]));
      const byMonth = new Map(rows.map((r) => [r.p.startDate.slice(0, 7), r]));

      const months = new Set<string>([...byMonth.keys(), ...countByMonth.keys()]);
      for (let i = 0; i < MONTHS_SHOWN; i++) months.add(shiftMonth(current, -i));
      return [...months]
        .filter((m) => m <= current.slice(0, 7) || byMonth.has(m))
        .sort()
        .reverse()
        .map((m): FiscalPeriodDto => {
          const r = byMonth.get(m);
          const range = monthOf(`${m}-01`);
          const c = countByMonth.get(m);
          return {
            month: m,
            startDate: range.start,
            endDate: range.end,
            status: (r?.p.status as FiscalPeriodDto['status']) ?? 'open',
            closedAt: r?.p.closedAt?.toISOString() ?? null,
            closedByName: r?.closedByName ?? null,
            reopenedAt: r?.p.reopenedAt?.toISOString() ?? null,
            reopenedByName: r?.reopenedByName ?? null,
            reopenReason: r?.p.reopenReason ?? null,
            postedEntries: c?.posted ?? 0,
            draftEntries: c?.drafts ?? 0,
          };
        });
    });
  }

  close(auth: AuthContext, month: string, meta: RequestMeta): Promise<FiscalPeriodDto[]> {
    return this.change(auth, month, meta, async (tx, period) => {
      if (period.status === 'closed') throw new AppError('CONFLICT', `${month} is already closed.`);
      await tx
        .update(p)
        .set({ status: 'closed', closedBy: auth.userId, closedAt: sql`now()` })
        .where(eq(p.id, period.id));
      return { action: 'period.closed', reason: null };
    });
  }

  reopen(
    auth: AuthContext,
    month: string,
    body: ReopenPeriodRequest,
    meta: RequestMeta,
  ): Promise<FiscalPeriodDto[]> {
    return this.change(auth, month, meta, async (tx, period) => {
      if (period.status !== 'closed') throw new AppError('CONFLICT', `${month} is not closed.`);
      await tx
        .update(p)
        .set({ status: 'open', reopenedBy: auth.userId, reopenedAt: sql`now()`, reopenReason: body.reason })
        .where(eq(p.id, period.id));
      return { action: 'period.reopened', reason: body.reason };
    });
  }

  /** Locks the month's row (waiting for any posting that holds it) before changing its state. */
  private async change(
    auth: AuthContext,
    month: string,
    meta: RequestMeta,
    apply: (tx: Tx, period: typeof p.$inferSelect) => Promise<{ action: string; reason: string | null }>,
  ): Promise<FiscalPeriodDto[]> {
    await this.db.tenant(auth.tenantId, async (tx) => {
      const period = await this.posting.lockPeriod(tx, auth.tenantId, `${month}-01`, 'update');
      const { action, reason } = await apply(tx, period);
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action,
          entityType: 'fiscal_period',
          entityId: period.id,
          changes: { month },
          reason,
        },
        meta,
      );
    });
    return this.list(auth);
  }
}

/** `YYYY-MM-01` shifted by whole months, as `YYYY-MM`. */
function shiftMonth(start: string, by: number): string {
  const [y, m] = start.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
