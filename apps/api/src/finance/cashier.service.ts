import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  ApproveClosingRequest,
  CashClosingDto,
  CashierShiftDetailDto,
  CashierShiftDto,
  OpenShiftRequest,
  ReopenClosingRequest,
  ShiftListQuery,
  SubmitClosingRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, desc, eq, gte, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ledgerErrors, PostingService } from './posting.service';

const sh = schema.cashierShifts;
const cl = schema.cashClosings;
const ca = schema.cashAccounts;
type ShiftRow = typeof sh.$inferSelect;
type ClosingRow = typeof cl.$inferSelect;
type PropertyRow = typeof schema.properties.$inferSelect;

/**
 * Cashier shifts and cash closings (P4-4, P4-5; CASH-001, QA scenario B). Shifts are optional (D11). While one is
 * open on a drawer, PostingService links every cash line on that drawer to it, so
 *   expected cash = opening count + cash in − cash out of the shift,
 * read from posted journal lines. Closing records the count; any variance needs an explanation; above the
 * property's threshold it waits for approval by someone else holding `cashier.approve`. The variance is posted to
 * Cash over and short (6970) when the closing is final, so the drawer's ledger balance then equals the count.
 */
@Injectable()
export class CashierService {
  constructor(
    private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ------------------------------------------------------------------------------------------- reads

  /** The caller's open shift on this property, or null. */
  current(auth: AuthContext, propertyId: string): Promise<CashierShiftDto | null> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const [row] = await tx
        .select({ id: sh.id })
        .from(sh)
        .where(and(eq(sh.propertyId, propertyId), eq(sh.userId, auth.userId), eq(sh.status, 'open')));
      return row ? (await this.dtos(tx, property, [row.id]))[0]! : null;
    });
  }

  /** Everyone's shifts for supervisors and ledger readers; otherwise only the caller's own. */
  list(auth: AuthContext, propertyId: string, q: ShiftListQuery): Promise<CashierShiftDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const live = sql`exists (select 1 from cash_closings c where c.shift_id = ${sh.id} and c.status = 'submitted')`;
      const filters: Record<ShiftListQuery['status'], SQL | undefined> = {
        open: eq(sh.status, 'open'),
        awaiting_approval: live,
        closed: and(eq(sh.status, 'closed'), sql`not ${live}`),
        all: undefined,
      };
      const rows = await tx
        .select({ id: sh.id })
        .from(sh)
        .where(
          and(
            eq(sh.propertyId, propertyId),
            this.seesAll(auth, propertyId) ? undefined : eq(sh.userId, auth.userId),
            filters[q.status],
            q.from ? gte(sh.businessDate, q.from) : undefined,
            q.to ? lte(sh.businessDate, q.to) : undefined,
          ),
        )
        .orderBy(desc(sh.openedAt))
        .limit(q.limit);
      return this.dtos(
        tx,
        property,
        rows.map((r) => r.id),
      );
    });
  }

  get(auth: AuthContext, propertyId: string, id: string): Promise<CashierShiftDetailDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const shift = await this.shift(tx, propertyId, id);
      if (shift.userId !== auth.userId && !this.seesAll(auth, propertyId)) throw AppError.notFound('shift');
      const [dto] = await this.dtos(tx, property, [id]);
      const rows = await tx.execute<{
        entry_id: string;
        journal_number: string | null;
        accounting_date: string;
        source_type: string;
        narration: string;
        reference: string | null;
        debit: string;
        credit: string;
      }>(sql`
        select e.id as entry_id, e.journal_number, e.accounting_date::text, e.source_type, e.narration, e.reference,
               l.debit::text, l.credit::text
        from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        where l.cashier_shift_id = ${id} and e.status <> 'draft'
        order by e.posted_at, e.journal_number, l.line_no`);
      const cur = property.currencyCode;
      return {
        ...dto!,
        movements: rows.rows.map((r) => ({
          entryId: r.entry_id,
          journalNumber: r.journal_number === null ? null : Number(r.journal_number),
          accountingDate: r.accounting_date,
          sourceType: r.source_type,
          narration: r.narration,
          reference: r.reference,
          in: Money.fromStorage(r.debit, cur).round().toString(),
          out: Money.fromStorage(r.credit, cur).round().toString(),
        })),
      };
    });
  }

  // ------------------------------------------------------------------------------------------- commands

  open(
    auth: AuthContext,
    propertyId: string,
    body: OpenShiftRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /properties/${propertyId}/cashier-shifts/open`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const [drawer] = await tx
        .select()
        .from(ca)
        .where(and(eq(ca.propertyId, propertyId), eq(ca.id, body.cashAccountId)))
        .for('update');
      if (!drawer) throw AppError.notFound('cash account');
      if (drawer.kind !== 'cash' || !drawer.active) {
        throw AppError.validation('Shifts are opened on an active cash drawer.', [
          { path: 'cashAccountId', message: 'Choose a cash drawer.' },
        ]);
      }
      const [mine] = await tx
        .select({ name: ca.name })
        .from(sh)
        .innerJoin(ca, eq(ca.id, sh.cashAccountId))
        .where(and(eq(sh.userId, auth.userId), eq(sh.status, 'open')));
      if (mine)
        throw new AppError('CONFLICT', `You already have a shift open on ${mine.name}. Close it first.`);
      const [taken] = await tx
        .select({ by: schema.users.fullName })
        .from(sh)
        .innerJoin(schema.users, eq(schema.users.id, sh.userId))
        .where(and(eq(sh.cashAccountId, drawer.id), eq(sh.status, 'open')));
      if (taken) {
        throw new AppError('CONFLICT', `${drawer.name} already has a shift open by ${taken.by}.`);
      }
      const book = await this.drawerBalance(tx, drawer.id, property.currencyCode);
      const count = Money.of(body.openingCount, property.currencyCode);
      const [row] = await tx
        .insert(sh)
        .values({
          tenantId: auth.tenantId,
          propertyId,
          cashAccountId: drawer.id,
          userId: auth.userId,
          businessDate: property.businessDate,
          openingCount: count.toStorage(),
          bookBalanceAtOpen: book.toStorage(),
        })
        .returning();
      await this.record(tx, auth, propertyId, meta, 'cashier.shift_opened', row!.id, {
        drawer: drawer.name,
        openingCount: count.toString(),
        bookBalance: book.toString(),
      });
      return { status: 201, body: (await this.dtos(tx, property, [row!.id]))[0]! };
    });
  }

  /**
   * Closes the caller's shift with the counted cash (CASH-001). The expected amount is fixed from the posted lines;
   * a variance needs an explanation; above the threshold the closing waits for approval, otherwise it is final and
   * the variance is posted now.
   */
  submitClosing(
    auth: AuthContext,
    propertyId: string,
    shiftId: string,
    body: SubmitClosingRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    const scope = `POST /properties/${propertyId}/cashier-shifts/${shiftId}/submit-closing`;
    return this.command(auth, scope, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const cur = property.currencyCode;
      const shift = await this.lockShift(tx, propertyId, shiftId);
      if (shift.userId !== auth.userId) {
        throw new AppError('FORBIDDEN', 'Only the cashier who opened this shift can close it.');
      }
      if (shift.status !== 'open') {
        throw new AppError('CASH_CLOSING_ALREADY_SUBMITTED', 'This shift has already been closed.');
      }
      const { cashIn, cashOut } = await this.movementTotals(tx, shift.id, cur);
      const expected = Money.fromStorage(shift.openingCount, cur).add(cashIn).subtract(cashOut);
      const counted = Money.of(body.countedAmount, cur);
      const variance = counted.subtract(expected);
      const explanation = body.explanation?.trim() || null;
      if (!variance.isZero() && (!explanation || explanation.length < 3)) {
        throw AppError.validation('Explain the difference between the counted and the expected cash.', [
          {
            path: 'explanation',
            message: `${variance.isNegative() ? 'Short' : 'Over'} by ${variance.abs().toString()}. Say why.`,
          },
        ]);
      }
      const threshold = Money.fromStorage(property.cashVarianceThreshold, cur);
      const approvalRequired = variance.abs().compare(threshold) > 0;

      // Closed first: from here no posting can join the shift, including the variance entry below.
      await tx
        .update(sh)
        .set({ status: 'closed', closedAt: sql`now()` })
        .where(eq(sh.id, shift.id));
      const id = randomUUID();
      const journalId = approvalRequired
        ? null
        : await this.postVariance(tx, auth, property, shift, id, variance);
      await tx.insert(cl).values({
        id,
        tenantId: auth.tenantId,
        propertyId,
        shiftId: shift.id,
        cashAccountId: shift.cashAccountId,
        businessDate: property.businessDate,
        expectedAmount: expected.toStorage(),
        countedAmount: counted.toStorage(),
        variance: variance.toStorage(),
        explanation,
        threshold: threshold.toStorage(),
        approvalRequired,
        status: approvalRequired ? 'submitted' : 'approved',
        submittedBy: auth.userId,
        varianceJournalEntryId: journalId,
      });
      await this.record(tx, auth, propertyId, meta, 'cashier.closing_submitted', shift.id, {
        expected: expected.toString(),
        counted: counted.toString(),
        variance: variance.toString(),
        approvalRequired,
      });
      return { status: 200, body: await this.detail(tx, property, shift.id) };
    });
  }

  /** Approves a closing waiting for approval; the approver cannot be the cashier who submitted it. */
  approveClosing(
    auth: AuthContext,
    propertyId: string,
    shiftId: string,
    body: ApproveClosingRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    const scope = `POST /properties/${propertyId}/cashier-shifts/${shiftId}/approve-closing`;
    return this.command(auth, scope, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const shift = await this.lockShift(tx, propertyId, shiftId);
      const closing = await this.liveClosing(tx, shift.id);
      if (!closing || closing.status !== 'submitted') {
        throw new AppError('CONFLICT', 'There is no closing waiting for approval on this shift.');
      }
      if (closing.submittedBy === auth.userId) {
        throw new AppError('FORBIDDEN', 'You submitted this closing. Someone else must approve it.');
      }
      const variance = Money.fromStorage(closing.variance, property.currencyCode);
      const journalId = await this.postVariance(tx, auth, property, shift, closing.id, variance);
      await tx
        .update(cl)
        .set({
          status: 'approved',
          approvedBy: auth.userId,
          approvedAt: sql`now()`,
          approvalNote: body.note || null,
          varianceJournalEntryId: journalId,
        })
        .where(eq(cl.id, closing.id));
      await this.record(tx, auth, propertyId, meta, 'cashier.closing_approved', shift.id, {
        variance: variance.toString(),
        note: body.note || null,
      });
      return { status: 200, body: await this.detail(tx, property, shift.id) };
    });
  }

  /**
   * Reopens a submitted or approved closing (owner only, with a reason): any variance entry is reversed, the
   * closing is kept as history and the shift is open again for a recount.
   */
  reopen(
    auth: AuthContext,
    propertyId: string,
    shiftId: string,
    body: ReopenClosingRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    const scope = `POST /properties/${propertyId}/cashier-shifts/${shiftId}/reopen`;
    return this.command(auth, scope, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const shift = await this.lockShift(tx, propertyId, shiftId);
      const closing = await this.liveClosing(tx, shift.id);
      if (!closing) throw new AppError('CONFLICT', 'This shift has no closing to reopen.');
      // Reversed while the shift is still closed, so the reversal does not join it.
      if (closing.varianceJournalEntryId) {
        await this.reverseVariance(tx, auth, closing.varianceJournalEntryId, body.reason);
      }
      await tx
        .update(cl)
        .set({
          status: 'reopened',
          reopenedBy: auth.userId,
          reopenedAt: sql`now()`,
          reopenReason: body.reason,
        })
        .where(eq(cl.id, closing.id));
      try {
        await tx.update(sh).set({ status: 'open', closedAt: null }).where(eq(sh.id, shift.id));
      } catch (err) {
        if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
          throw new AppError(
            'CONFLICT',
            'The cashier or the drawer has another shift open. Close that shift before reopening this one.',
          );
        }
        throw err;
      }
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId,
          actor: { type: 'user', userId: auth.userId },
          action: 'cashier.closing_reopened',
          entityType: 'cashier_shift',
          entityId: shift.id,
          changes: { variance: closing.variance, previousStatus: closing.status },
          reason: body.reason,
        },
        meta,
      );
      return { status: 200, body: await this.detail(tx, property, shift.id) };
    });
  }

  // ------------------------------------------------------------------------------------------- internals

  /** Shortage: Dr Cash over and short, Cr drawer. Overage: the other way. Nothing for no variance. */
  private async postVariance(
    tx: Tx,
    auth: AuthContext,
    property: PropertyRow,
    shift: ShiftRow,
    closingId: string,
    variance: Money,
  ): Promise<string | null> {
    if (variance.isZero()) return null;
    const [overShort] = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.systemRole, 'cash_over_short'));
    const [drawer] = await tx.select().from(ca).where(eq(ca.id, shift.cashAccountId));
    if (!overShort || !drawer) throw AppError.notFound('account');
    const amount = variance.abs().toString();
    const short = variance.isNegative();
    return this.posting.post(tx, auth, {
      propertyId: property.id,
      sourceType: 'cash_closing',
      sourceId: closingId,
      narration: `Cash ${short ? 'short' : 'over'} on ${drawer.name}, shift of ${shift.businessDate}`,
      lines: short
        ? [
            { accountId: overShort.id, debit: amount, credit: '0' },
            { accountId: drawer.ledgerAccountId, debit: '0', credit: amount, cashAccountId: drawer.id },
          ]
        : [
            { accountId: drawer.ledgerAccountId, debit: amount, credit: '0', cashAccountId: drawer.id },
            { accountId: overShort.id, debit: '0', credit: amount },
          ],
    });
  }

  private async reverseVariance(tx: Tx, auth: AuthContext, entryId: string, reason: string) {
    const [original] = await tx
      .select({ status: schema.journalEntries.status })
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.id, entryId));
    if (original?.status !== 'posted') return;
    await this.posting.reverse(tx, auth, entryId, `cash closing reopened (${reason})`);
  }

  private async movementTotals(tx: Tx, shiftId: string, cur: string) {
    const r = await tx.execute<{ i: string; o: string }>(sql`
      select coalesce(sum(l.debit), 0)::text as i, coalesce(sum(l.credit), 0)::text as o
      from journal_lines l join journal_entries e on e.id = l.journal_entry_id
      where l.cashier_shift_id = ${shiftId} and e.status <> 'draft'`);
    return { cashIn: Money.fromStorage(r.rows[0]!.i, cur), cashOut: Money.fromStorage(r.rows[0]!.o, cur) };
  }

  private async drawerBalance(tx: Tx, cashAccountId: string, cur: string): Promise<Money> {
    const r = await tx.execute<{ b: string }>(sql`
      select coalesce(sum(l.debit - l.credit), 0)::text as b
      from journal_lines l join journal_entries e on e.id = l.journal_entry_id
      where l.cash_account_id = ${cashAccountId} and e.status <> 'draft'`);
    return Money.fromStorage(r.rows[0]!.b, cur).round();
  }

  private seesAll(auth: AuthContext, propertyId: string): boolean {
    const p = auth.permissionsByProperty.get(propertyId);
    return !!p && (p.has('cashier.approve') || p.has('journal.read'));
  }

  private async shift(tx: Tx, propertyId: string, id: string): Promise<ShiftRow> {
    const [row] = await tx
      .select()
      .from(sh)
      .where(and(eq(sh.propertyId, propertyId), eq(sh.id, id)));
    if (!row) throw AppError.notFound('shift');
    return row;
  }

  private async lockShift(tx: Tx, propertyId: string, id: string): Promise<ShiftRow> {
    const [row] = await tx
      .select()
      .from(sh)
      .where(and(eq(sh.propertyId, propertyId), eq(sh.id, id)))
      .for('update');
    if (!row) throw AppError.notFound('shift');
    return row;
  }

  private async liveClosing(tx: Tx, shiftId: string): Promise<ClosingRow | undefined> {
    const [row] = await tx
      .select()
      .from(cl)
      .where(and(eq(cl.shiftId, shiftId), ne(cl.status, 'reopened')))
      .for('update');
    return row;
  }

  private async detail(tx: Tx, property: PropertyRow, id: string): Promise<CashierShiftDto> {
    return (await this.dtos(tx, property, [id]))[0]!;
  }

  private async dtos(tx: Tx, property: PropertyRow, ids: string[]): Promise<CashierShiftDto[]> {
    if (ids.length === 0) return [];
    const cur = property.currencyCode;
    const m = (v: string) => Money.fromStorage(v, cur).round();
    const rows = await tx
      .select({ s: sh, drawer: ca.name, user: schema.users.fullName })
      .from(sh)
      .innerJoin(ca, eq(ca.id, sh.cashAccountId))
      .innerJoin(schema.users, eq(schema.users.id, sh.userId))
      .where(inArray(sh.id, ids))
      .orderBy(desc(sh.openedAt));
    const totals = await tx.execute<{ shift_id: string; i: string; o: string }>(sql`
      select l.cashier_shift_id as shift_id, coalesce(sum(l.debit), 0)::text as i, coalesce(sum(l.credit), 0)::text as o
      from journal_lines l join journal_entries e on e.id = l.journal_entry_id
      where l.cashier_shift_id = any(${`{${ids.join(',')}}`}::uuid[]) and e.status <> 'draft'
      group by l.cashier_shift_id`);
    const closings = await this.closingDtos(tx, cur, ids);
    return rows.map(({ s, drawer, user }) => {
      const t = totals.rows.find((x) => x.shift_id === s.id);
      const cashIn = m(t?.i ?? '0');
      const cashOut = m(t?.o ?? '0');
      const mine = closings.filter((c) => c.shiftId === s.id);
      const live = mine.find((c) => c.dto.status !== 'reopened')?.dto ?? null;
      const opening = m(s.openingCount);
      return {
        id: s.id,
        cashAccountId: s.cashAccountId,
        cashAccountName: drawer,
        userId: s.userId,
        userName: user,
        businessDate: s.businessDate,
        openedAt: s.openedAt.toISOString(),
        openingCount: opening.toString(),
        bookBalanceAtOpen: m(s.bookBalanceAtOpen).toString(),
        openingDifference: opening.subtract(m(s.bookBalanceAtOpen)).toString(),
        status: s.status as CashierShiftDto['status'],
        closedAt: s.closedAt?.toISOString() ?? null,
        cashIn: cashIn.toString(),
        cashOut: cashOut.toString(),
        expected:
          s.status === 'closed' && live
            ? live.expectedAmount
            : opening.add(cashIn).subtract(cashOut).toString(),
        closing: live,
        reopenedClosings: mine.filter((c) => c.dto.status === 'reopened').map((c) => c.dto),
      };
    });
  }

  private async closingDtos(tx: Tx, cur: string, shiftIds: string[]) {
    const m = (v: string) => Money.fromStorage(v, cur).round().toString();
    const rows = await tx.execute<{
      id: string;
      shift_id: string;
      business_date: string;
      expected_amount: string;
      counted_amount: string;
      variance: string;
      explanation: string | null;
      threshold: string;
      approval_required: boolean;
      status: CashClosingDto['status'];
      submitted_by_name: string | null;
      submitted_at: Date;
      approved_by_name: string | null;
      approved_at: Date | null;
      approval_note: string | null;
      variance_journal_entry_id: string | null;
      journal_number: string | null;
      reopened_by_name: string | null;
      reopened_at: Date | null;
      reopen_reason: string | null;
    }>(sql`
      select c.id, c.shift_id, c.business_date::text, c.expected_amount::text, c.counted_amount::text,
             c.variance::text, c.explanation, c.threshold::text, c.approval_required, c.status,
             su.full_name as submitted_by_name, c.submitted_at, au.full_name as approved_by_name, c.approved_at,
             c.approval_note, c.variance_journal_entry_id, e.journal_number, ru.full_name as reopened_by_name,
             c.reopened_at, c.reopen_reason
      from cash_closings c
      left join users su on su.id = c.submitted_by
      left join users au on au.id = c.approved_by
      left join users ru on ru.id = c.reopened_by
      left join journal_entries e on e.id = c.variance_journal_entry_id
      where c.shift_id = any(${`{${shiftIds.join(',')}}`}::uuid[])
      order by c.submitted_at`);
    const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
    return rows.rows.map((r) => ({
      shiftId: r.shift_id,
      dto: {
        id: r.id,
        businessDate: r.business_date,
        expectedAmount: m(r.expected_amount),
        countedAmount: m(r.counted_amount),
        variance: m(r.variance),
        explanation: r.explanation,
        threshold: m(r.threshold),
        approvalRequired: r.approval_required,
        status: r.status,
        submittedByName: r.submitted_by_name,
        submittedAt: iso(r.submitted_at)!,
        approvedByName: r.approved_by_name,
        approvedAt: iso(r.approved_at),
        approvalNote: r.approval_note,
        varianceJournalEntryId: r.variance_journal_entry_id,
        varianceJournalNumber: r.journal_number === null ? null : Number(r.journal_number),
        reopenedByName: r.reopened_by_name,
        reopenedAt: iso(r.reopened_at),
        reopenReason: r.reopen_reason,
      } satisfies CashClosingDto,
    }));
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
        // Two people opening at once: the one-open-shift indexes decide.
        if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
          throw new AppError('CONFLICT', 'That cashier or drawer already has a shift open.');
        }
        throw err;
      }
    });
  }

  private async property(tx: Tx, propertyId: string): Promise<PropertyRow> {
    const [row] = await tx.select().from(schema.properties).where(eq(schema.properties.id, propertyId));
    if (!row) throw AppError.notFound('property');
    return row;
  }

  private async record(
    tx: Tx,
    auth: AuthContext,
    propertyId: string,
    meta: RequestMeta,
    action: string,
    shiftId: string,
    changes: Record<string, unknown>,
  ) {
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType: 'cashier_shift',
        entityId: shiftId,
        changes,
      },
      meta,
    );
  }
}
