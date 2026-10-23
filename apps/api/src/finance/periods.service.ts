import { Injectable } from '@nestjs/common';
import type {
  ClosePeriodRequest,
  CloseCheckDto,
  FiscalPeriodDto,
  PeriodChecklistDto,
  ReopenPeriodRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { and, eq, sql } from 'drizzle-orm';
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
 * Monthly accounting periods (FIN-005). A month closes only when its checklist (P4-10) has no blockers: every
 * property's business date past the month (night audits run), no draft journals, no open cashier shift or closing
 * waiting for approval. Warnings (bank not reconciled to month end, earlier months open) need a reason, kept with
 * the period. Closing blocks all posting into the month; reopening needs its own permission and a reason; both are
 * audited (AUD-001).
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
            closeReason: r?.p.closeReason ?? null,
            postedEntries: c?.posted ?? 0,
            draftEntries: c?.drafts ?? 0,
          };
        });
    });
  }

  checklist(auth: AuthContext, month: string): Promise<PeriodChecklistDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [row] = await tx
        .select({ status: p.status })
        .from(p)
        .where(and(eq(p.tenantId, auth.tenantId), eq(p.startDate, `${month}-01`)));
      const items = await this.checks(tx, month);
      return summarise(month, (row?.status as PeriodChecklistDto['status']) ?? 'open', items);
    });
  }

  close(
    auth: AuthContext,
    month: string,
    body: ClosePeriodRequest,
    meta: RequestMeta,
  ): Promise<FiscalPeriodDto[]> {
    return this.change(auth, month, meta, async (tx, period) => {
      if (period.status === 'closed') throw new AppError('CONFLICT', `${month} is already closed.`);
      const items = await this.closeWith(tx, auth, period, month, body.reason);
      return { action: 'period.closed', reason: body.reason ?? null, changes: { checklist: items.length } };
    });
  }

  /**
   * Closes a locked period after its checklist: refuses blockers, needs a reason for warnings. Used by the month-end
   * close and, for December, by the year-end close.
   */
  async closeWith(
    tx: Tx,
    auth: AuthContext,
    period: typeof p.$inferSelect,
    month: string,
    reason: string | undefined,
    ignore: CloseCheckDto['check'][] = [],
  ): Promise<CloseCheckDto[]> {
    const items = (await this.checks(tx, month)).filter((i) => !ignore.includes(i.check));
    const blockers = items.filter((i) => i.severity === 'blocker');
    if (blockers.length > 0) {
      throw new AppError(
        'CONFLICT',
        `${month} cannot be closed yet: ${blockers.length} item(s) must be dealt with first.`,
        blockers.map((b) => ({ path: b.check, message: b.detail ? `${b.label}: ${b.detail}` : b.label })),
      );
    }
    if (items.length > 0 && !reason) {
      throw AppError.validation('Some checks are not met. Give a reason to close anyway.', [
        { path: 'reason', message: `${items.length} warning(s) to accept.` },
      ]);
    }
    await tx
      .update(p)
      .set({
        status: 'closed',
        closedBy: auth.userId,
        closedAt: sql`now()`,
        closeReason: items.length > 0 ? reason! : null,
        closeChecklist: items,
      })
      .where(eq(p.id, period.id));
    return items;
  }

  reopen(
    auth: AuthContext,
    month: string,
    body: ReopenPeriodRequest,
    meta: RequestMeta,
  ): Promise<FiscalPeriodDto[]> {
    return this.change(auth, month, meta, async (tx, period) => {
      if (period.status !== 'closed') throw new AppError('CONFLICT', `${month} is not closed.`);
      const [year] = await tx
        .select({ id: schema.fiscalYears.id })
        .from(schema.fiscalYears)
        .where(
          and(
            eq(schema.fiscalYears.year, Number(month.slice(0, 4))),
            eq(schema.fiscalYears.status, 'closed'),
          ),
        );
      if (year) {
        throw new AppError(
          'CONFLICT',
          `${month.slice(0, 4)} has been closed at year end. Reopen the year instead.`,
        );
      }
      await tx
        .update(p)
        .set({ status: 'open', reopenedBy: auth.userId, reopenedAt: sql`now()`, reopenReason: body.reason })
        .where(eq(p.id, period.id));
      return { action: 'period.reopened', reason: body.reason, changes: {} };
    });
  }

  /** The month-end checklist (P4-10). */
  async checks(tx: Tx, month: string): Promise<CloseCheckDto[]> {
    const { start, end } = monthOf(`${month}-01`);
    const items: CloseCheckDto[] = [];
    const q = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>) =>
      (await tx.execute<T>(query)).rows;

    for (const r of await q<{ name: string; d: string }>(sql`
      select name, business_date::text as d from properties
      where status = 'active' and business_date <= ${end}::date order by name`)) {
      items.push({
        check: 'business_dates_open',
        severity: 'blocker',
        label: r.name,
        detail: `Business date ${r.d}; run the night audit through ${end}.`,
      });
    }
    for (const r of await q<{ narration: string; d: string }>(sql`
      select narration, accounting_date::text as d from journal_entries
      where status = 'draft' and accounting_date between ${start}::date and ${end}::date
      order by accounting_date`)) {
      items.push({
        check: 'draft_journals',
        severity: 'blocker',
        label: r.narration,
        detail: `Draft dated ${r.d}`,
      });
    }
    for (const r of await q<{ drawer: string; cashier: string }>(sql`
      select ca.name as drawer, u.full_name as cashier from cashier_shifts s
      join cash_accounts ca on ca.id = s.cash_account_id join users u on u.id = s.user_id
      where s.status = 'open' and s.business_date <= ${end}::date`)) {
      items.push({ check: 'open_shifts', severity: 'blocker', label: r.drawer, detail: r.cashier });
    }
    for (const r of await q<{ drawer: string; variance: string }>(sql`
      select ca.name as drawer, c.variance::numeric(19,2)::text as variance from cash_closings c
      join cash_accounts ca on ca.id = c.cash_account_id
      where c.status = 'submitted' and c.business_date <= ${end}::date`)) {
      items.push({
        check: 'closings_pending',
        severity: 'blocker',
        label: r.drawer,
        detail: `Variance ${r.variance} waiting for approval`,
      });
    }
    for (const r of await q<{ name: string; last: string | null }>(sql`
      select ca.name, (select max(b.statement_date)::text from bank_reconciliations b
                       where b.cash_account_id = ca.id and b.status = 'completed') as last
      from cash_accounts ca
      where ca.kind = 'bank'
        and exists (select 1 from journal_lines l join journal_entries e on e.id = l.journal_entry_id
                    where l.cash_account_id = ca.id and e.status <> 'draft' and e.accounting_date <= ${end}::date)
        and not exists (select 1 from bank_reconciliations b where b.cash_account_id = ca.id
                        and b.status = 'completed' and b.statement_date >= ${end}::date)
      order by ca.name`)) {
      items.push({
        check: 'bank_not_reconciled',
        severity: 'warning',
        label: r.name,
        detail: r.last ? `Reconciled to ${r.last}` : 'Never reconciled',
      });
    }
    for (const r of await q<{ m: string }>(sql`
      select distinct to_char(e.accounting_date, 'YYYY-MM') as m from journal_entries e
      where e.status <> 'draft' and e.accounting_date < ${start}::date
        and not exists (select 1 from fiscal_periods f where f.start_date = date_trunc('month', e.accounting_date)::date
                        and f.status = 'closed')
      order by 1`)) {
      items.push({ check: 'earlier_months_open', severity: 'warning', label: r.m, detail: null });
    }
    return items;
  }

  /** Locks the month's row (waiting for any posting that holds it) before changing its state. */
  private async change(
    auth: AuthContext,
    month: string,
    meta: RequestMeta,
    apply: (
      tx: Tx,
      period: typeof p.$inferSelect,
    ) => Promise<{ action: string; reason: string | null; changes: Record<string, unknown> }>,
  ): Promise<FiscalPeriodDto[]> {
    await this.db.tenant(auth.tenantId, async (tx) => {
      const period = await this.posting.lockPeriod(tx, auth.tenantId, `${month}-01`, 'update');
      const { action, reason, changes } = await apply(tx, period);
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action,
          entityType: 'fiscal_period',
          entityId: period.id,
          changes: { month, ...changes },
          reason,
        },
        meta,
      );
    });
    return this.list(auth);
  }
}

export function summarise(month: string, status: PeriodChecklistDto['status'], items: CloseCheckDto[]) {
  return {
    month,
    status,
    items,
    blockers: items.filter((i) => i.severity === 'blocker').length,
    warnings: items.filter((i) => i.severity === 'warning').length,
  };
}

/** `YYYY-MM-01` shifted by whole months, as `YYYY-MM`. */
function shiftMonth(start: string, by: number): string {
  const [y, m] = start.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
