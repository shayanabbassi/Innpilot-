import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  CloseCheckDto,
  CloseYearRequest,
  FiscalYearDto,
  ReopenYearRequest,
  YearEndEntryDto,
  YearEndPreviewDto,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { PeriodsService } from './periods.service';
import { ledgerErrors, PostingService, type PostingLine } from './posting.service';

const fy = schema.fiscalYears;
const fye = schema.fiscalYearEntries;
const P_AND_L = ['revenue', 'cost_of_sales', 'expense', 'other'];

interface Balance {
  propertyId: string;
  propertyName: string;
  accountId: string;
  code: string;
  name: string;
  /** Credit minus debit for the year: revenue positive, costs negative. */
  balance: Money;
}

/**
 * Year-end close (P4-11). The fiscal year is the calendar year (D10). Closing needs every month of the year but
 * December closed and December's own checklist clear; it then posts, for each property, an entry dated 31 December
 * that brings every revenue, cost and expense account to zero against Retained earnings (3100), and closes December.
 * Posting into the year is then refused (every month is closed). Reopening (owner, reason) reverses those entries
 * on 31 December and reopens December only.
 */
@Injectable()
export class YearEndService {
  constructor(
    private readonly db: Db,
    private readonly posting: PostingService,
    private readonly periods: PeriodsService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  preview(auth: AuthContext, year: number): Promise<YearEndPreviewDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const cur = await this.currency(tx);
      const closed = await this.closedYear(tx, year);
      const balances = closed
        ? await this.closedBalances(tx, closed.id, cur)
        : await this.balances(tx, year, cur);
      const entries = this.entries(balances, cur);
      return {
        year,
        startDate: `${year}-01-01`,
        endDate: `${year}-12-31`,
        status: closed ? 'closed' : 'open',
        items: closed ? [] : await this.checks(tx, year),
        entries,
        result: Money.sum(
          entries.map((e) => Money.of(e.result, cur)),
          cur,
        ).toString(),
        history: await this.history(tx, year, cur),
      };
    });
  }

  close(auth: AuthContext, year: number, body: CloseYearRequest, key: string | undefined, meta: RequestMeta) {
    return this.command(auth, `POST /finance/years/${year}/close`, key, body, async (tx) => {
      const cur = await this.currency(tx);
      // December's row lock serialises year closes and keeps postings out while the closing entries are made.
      const december = await this.posting.lockPeriod(tx, auth.tenantId, `${year}-12-01`, 'update');
      if (await this.closedYear(tx, year)) throw new AppError('CONFLICT', `${year} is already closed.`);
      if (december.status === 'closed') {
        throw new AppError('CONFLICT', `December ${year} is closed. Reopen it, then close the year.`);
      }
      const earlier = (await this.checks(tx, year)).filter((i) => i.check === 'months_open');
      if (earlier.length > 0) {
        throw new AppError(
          'CONFLICT',
          `Close every month of ${year} before December first.`,
          earlier.map((i) => ({ path: i.check, message: i.label })),
        );
      }
      // December's checklist: blockers refused, warnings need the reason (checked before anything is posted).
      const decemberItems = (await this.periods.checks(tx, `${year}-12`)).filter(
        (i) => i.check !== 'earlier_months_open',
      );
      if (decemberItems.some((i) => i.severity === 'blocker')) {
        throw new AppError(
          'CONFLICT',
          `December ${year} cannot be closed yet.`,
          decemberItems
            .filter((i) => i.severity === 'blocker')
            .map((i) => ({ path: i.check, message: i.detail ? `${i.label}: ${i.detail}` : i.label })),
        );
      }
      if (decemberItems.length > 0 && !body.reason) {
        throw AppError.validation('Some checks are not met. Give a reason to close anyway.', [
          { path: 'reason', message: `${decemberItems.length} warning(s) to accept.` },
        ]);
      }

      const balances = await this.balances(tx, year, cur);
      const entries = this.entries(balances, cur);
      const result = Money.sum(
        entries.map((e) => Money.of(e.result, cur)),
        cur,
      );
      const id = randomUUID();
      await tx.insert(fy).values({
        id,
        tenantId: auth.tenantId,
        year,
        result: result.toStorage(),
        closeReason: decemberItems.length > 0 ? body.reason! : null,
        closedBy: auth.userId,
      });
      const retained = await this.account(tx, 'retained_earnings');
      for (const property of new Set(balances.map((b) => b.propertyId))) {
        const own = balances.filter((b) => b.propertyId === property && !b.balance.isZero());
        if (own.length === 0) continue;
        const net = Money.sum(
          own.map((b) => b.balance),
          cur,
        );
        // Each account's balance is cleared by its opposite side; the net goes to retained earnings.
        const lines: PostingLine[] = own.map((b) =>
          b.balance.isPositive()
            ? { accountId: b.accountId, debit: b.balance.toString(), credit: '0' }
            : { accountId: b.accountId, debit: '0', credit: b.balance.negate().toString() },
        );
        if (!net.isZero()) {
          lines.push(
            net.isPositive()
              ? { accountId: retained, debit: '0', credit: net.toString(), description: `Result of ${year}` }
              : {
                  accountId: retained,
                  debit: net.negate().toString(),
                  credit: '0',
                  description: `Result of ${year}`,
                },
          );
        }
        // One source record per property's closing entry.
        const entryId = randomUUID();
        const journalId = await this.posting.post(tx, auth, {
          propertyId: property,
          accountingDate: `${year}-12-31`,
          sourceType: 'year_end_close',
          sourceId: entryId,
          reference: `Year end ${year}`,
          narration: `Year-end close ${year}: revenue, costs and expenses to retained earnings`,
          lines,
        });
        await tx.insert(fye).values({
          id: entryId,
          tenantId: auth.tenantId,
          fiscalYearId: id,
          propertyId: property,
          journalEntryId: journalId,
        });
      }
      // Then December closes like any month (the closing entries are in it, no new warnings arise).
      await this.periods.closeWith(tx, auth, december, `${year}-12`, body.reason, ['earlier_months_open']);
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: 'fiscal_year.closed',
          entityType: 'fiscal_year',
          entityId: id,
          changes: { year, result: result.toString(), properties: entries.length },
          reason: body.reason ?? null,
        },
        meta,
      );
      return { status: 200, body: await this.previewIn(tx, year, cur) };
    });
  }

  reopen(
    auth: AuthContext,
    year: number,
    body: ReopenYearRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /finance/years/${year}/reopen`, key, body, async (tx) => {
      const cur = await this.currency(tx);
      const december = await this.posting.lockPeriod(tx, auth.tenantId, `${year}-12-01`, 'update');
      const closed = await this.closedYear(tx, year);
      if (!closed) throw new AppError('CONFLICT', `${year} is not closed.`);
      // December opens first, so the reversals can be dated 31 December.
      await tx
        .update(schema.fiscalPeriods)
        .set({ status: 'open', reopenedBy: auth.userId, reopenedAt: sql`now()`, reopenReason: body.reason })
        .where(eq(schema.fiscalPeriods.id, december.id));
      const journals = await tx.select().from(fye).where(eq(fye.fiscalYearId, closed.id));
      for (const j of journals) {
        await this.posting.reverse(
          tx,
          auth,
          j.journalEntryId,
          `year ${year} reopened (${body.reason})`,
          `${year}-12-31`,
        );
      }
      await tx
        .update(fy)
        .set({
          status: 'reopened',
          reopenedBy: auth.userId,
          reopenedAt: sql`now()`,
          reopenReason: body.reason,
        })
        .where(eq(fy.id, closed.id));
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: 'fiscal_year.reopened',
          entityType: 'fiscal_year',
          entityId: closed.id,
          changes: { year, reversed: journals.length },
          reason: body.reason,
        },
        meta,
      );
      return { status: 200, body: await this.previewIn(tx, year, cur) };
    });
  }

  // ------------------------------------------------------------------------------------------- internals

  private async previewIn(tx: Tx, year: number, cur: string): Promise<YearEndPreviewDto> {
    const closed = await this.closedYear(tx, year);
    const balances = closed
      ? await this.closedBalances(tx, closed.id, cur)
      : await this.balances(tx, year, cur);
    const entries = this.entries(balances, cur);
    return {
      year,
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
      status: closed ? 'closed' : 'open',
      items: closed ? [] : await this.checks(tx, year),
      entries,
      result: Money.sum(
        entries.map((e) => Money.of(e.result, cur)),
        cur,
      ).toString(),
      history: await this.history(tx, year, cur),
    };
  }

  /** January–November must be closed; December's checklist is shown (and enforced on close). */
  private async checks(tx: Tx, year: number): Promise<CloseCheckDto[]> {
    const closedMonths = await tx.execute<{ m: string }>(sql`
      select to_char(start_date, 'YYYY-MM') as m from fiscal_periods
      where status = 'closed' and start_date between ${`${year}-01-01`}::date and ${`${year}-11-01`}::date`);
    const done = new Set(closedMonths.rows.map((r) => r.m));
    const items: CloseCheckDto[] = [];
    for (let m = 1; m <= 11; m++) {
      const month = `${year}-${String(m).padStart(2, '0')}`;
      if (!done.has(month))
        items.push({ check: 'months_open', severity: 'blocker', label: month, detail: null });
    }
    const december = (await this.periods.checks(tx, `${year}-12`)).filter(
      (i) => i.check !== 'earlier_months_open',
    );
    return [...items, ...december];
  }

  /** Each property's revenue, cost and expense balances for the year, from posted lines. */
  private async balances(tx: Tx, year: number, cur: string): Promise<Balance[]> {
    const rows = await tx.execute<{
      property_id: string;
      property_name: string;
      account_id: string;
      code: string;
      name: string;
      balance: string;
    }>(sql`
      select e.property_id, p.name as property_name, a.id as account_id, a.code, a.name,
             sum(l.credit - l.debit)::text as balance
      from journal_lines l join journal_entries e on e.id = l.journal_entry_id
      join accounts a on a.id = l.account_id join properties p on p.id = e.property_id
      where e.status <> 'draft' and a.account_class = any(${`{${P_AND_L.join(',')}}`}::text[])
        and e.accounting_date between ${`${year}-01-01`}::date and ${`${year}-12-31`}::date
      group by e.property_id, p.name, a.id, a.code, a.name
      having sum(l.credit - l.debit) <> 0
      order by p.name, a.code`);
    return rows.rows.map((r) => ({
      propertyId: r.property_id,
      propertyName: r.property_name,
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      balance: Money.fromStorage(r.balance, cur).round(),
    }));
  }

  /** For a closed year: the balances its closing entries cleared (their debits on the P&L accounts). */
  private async closedBalances(tx: Tx, fiscalYearId: string, cur: string): Promise<Balance[]> {
    const rows = await tx.execute<{
      property_id: string;
      property_name: string;
      account_id: string;
      code: string;
      name: string;
      balance: string;
    }>(sql`
      select e.property_id, p.name as property_name, a.id as account_id, a.code, a.name,
             sum(l.debit - l.credit)::text as balance
      from fiscal_year_entries x join journal_entries e on e.id = x.journal_entry_id
      join journal_lines l on l.journal_entry_id = e.id join accounts a on a.id = l.account_id
      join properties p on p.id = e.property_id
      where x.fiscal_year_id = ${fiscalYearId} and a.account_class = any(${`{${P_AND_L.join(',')}}`}::text[])
      group by e.property_id, p.name, a.id, a.code, a.name
      order by p.name, a.code`);
    return rows.rows.map((r) => ({
      propertyId: r.property_id,
      propertyName: r.property_name,
      accountId: r.account_id,
      code: r.code,
      name: r.name,
      balance: Money.fromStorage(r.balance, cur).round(),
    }));
  }

  private entries(balances: Balance[], cur: string): YearEndEntryDto[] {
    const out = new Map<string, YearEndEntryDto & { total: Money }>();
    for (const b of balances) {
      const e = out.get(b.propertyId) ?? {
        propertyId: b.propertyId,
        propertyName: b.propertyName,
        lines: [],
        result: '0.00',
        total: Money.zero(cur),
      };
      e.lines.push({ accountCode: b.code, accountName: b.name, balance: b.balance.toString() });
      e.total = e.total.add(b.balance);
      e.result = e.total.toString();
      out.set(b.propertyId, e);
    }
    return [...out.values()].map(({ total: _total, ...e }) => e);
  }

  private async history(tx: Tx, year: number, cur: string): Promise<FiscalYearDto[]> {
    const closer = alias(schema.users, 'closer');
    const reopener = alias(schema.users, 'reopener');
    const rows = await tx
      .select({ y: fy, closer: closer.fullName, reopener: reopener.fullName })
      .from(fy)
      .leftJoin(closer, eq(closer.id, fy.closedBy))
      .leftJoin(reopener, eq(reopener.id, fy.reopenedBy))
      .where(eq(fy.year, year))
      .orderBy(desc(fy.closedAt));
    return rows.map(({ y, closer: c, reopener: r }) => ({
      id: y.id,
      year: y.year,
      status: y.status as FiscalYearDto['status'],
      result: Money.fromStorage(y.result, cur).round().toString(),
      closeReason: y.closeReason,
      closedByName: c,
      closedAt: y.closedAt.toISOString(),
      reopenedByName: r,
      reopenedAt: y.reopenedAt?.toISOString() ?? null,
      reopenReason: y.reopenReason,
    }));
  }

  private async closedYear(tx: Tx, year: number) {
    const [row] = await tx
      .select()
      .from(fy)
      .where(and(eq(fy.year, year), eq(fy.status, 'closed')));
    return row;
  }

  private async account(tx: Tx, role: string): Promise<string> {
    const [a] = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.systemRole, role));
    if (!a) throw AppError.notFound('system account');
    return a.id;
  }

  private async currency(tx: Tx): Promise<string> {
    const [t] = await tx.select({ c: schema.tenants.baseCurrency }).from(schema.tenants);
    return t?.c ?? 'PKR';
  }

  private command<T>(
    auth: AuthContext,
    scope: string,
    key: string | undefined,
    body: unknown,
    execute: (tx: Tx) => Promise<{ status: number; body: T }>,
  ) {
    return ledgerErrors(async () => {
      try {
        return await this.db.tenant(auth.tenantId, (tx) =>
          this.idempotency.run(
            tx,
            { tenantId: auth.tenantId, actorUserId: auth.userId, scope, key, body },
            () => execute(tx),
          ),
        );
      } catch (err) {
        if (pgErrorCode(err) === PG_UNIQUE_VIOLATION)
          throw new AppError('CONFLICT', 'This year is already closed.');
        throw err;
      }
    });
  }
}
