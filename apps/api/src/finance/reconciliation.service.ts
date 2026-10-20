import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  CardSettlementDto,
  CardSettlementRequest,
  CompleteReconciliationRequest,
  ReconciliationDetailDto,
  ReconciliationDto,
  ReconciliationItemsRequest,
  ReconciliationListQuery,
  StartReconciliationRequest,
  UpdateReconciliationRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ledgerErrors, PostingService } from './posting.service';

const br = schema.bankReconciliations;
const ri = schema.reconciliationItems;
const ca = schema.cashAccounts;
const cs = schema.cardSettlements;
type RecRow = typeof br.$inferSelect;
type PropertyRow = typeof schema.properties.$inferSelect;

/**
 * Bank reconciliation (P4-8) and card settlements (P4-2). A reconciliation ticks the ledger lines of one bank or
 * card-clearing account that appear on a statement; the cleared balance is every line reconciled so far plus the
 * ticked ones. It is finished only when the difference to the statement is zero or explained — the difference is
 * recorded, never booked away silently. A card settlement moves the clearing balance to the bank, less the card
 * company's fee, which goes to bank charges.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ------------------------------------------------------------------------------------------- reads

  list(auth: AuthContext, propertyId: string, q: ReconciliationListQuery): Promise<ReconciliationDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const rows = await tx
        .select({ id: br.id })
        .from(br)
        .where(
          and(
            eq(br.propertyId, propertyId),
            q.cashAccountId ? eq(br.cashAccountId, q.cashAccountId) : undefined,
          ),
        )
        .orderBy(desc(br.statementDate), desc(br.createdAt))
        .limit(200);
      return this.dtos(
        tx,
        property,
        rows.map((r) => r.id),
      );
    });
  }

  get(auth: AuthContext, propertyId: string, id: string): Promise<ReconciliationDetailDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      await this.rec(tx, propertyId, id);
      return this.detail(tx, property, id);
    });
  }

  // ------------------------------------------------------------------------------------------- commands

  async start(
    auth: AuthContext,
    propertyId: string,
    body: StartReconciliationRequest,
    meta: RequestMeta,
  ): Promise<ReconciliationDetailDto> {
    try {
      return await this.db.tenant(auth.tenantId, async (tx) => {
        const property = await this.property(tx, propertyId);
        const [account] = await tx
          .select()
          .from(ca)
          .where(and(eq(ca.propertyId, propertyId), eq(ca.id, body.cashAccountId)))
          .for('update');
        if (!account) throw AppError.notFound('cash account');
        if (account.kind === 'cash') {
          throw AppError.validation(
            'Cash drawers are counted in cashier shifts, not reconciled to a statement.',
            [{ path: 'cashAccountId', message: 'Choose a bank or card account.' }],
          );
        }
        await this.assertDate(tx, property, account.id, body.statementDate, null);
        const [row] = await tx
          .insert(br)
          .values({
            tenantId: auth.tenantId,
            propertyId,
            cashAccountId: account.id,
            statementDate: body.statementDate,
            statementBalance: Money.of(body.statementBalance, property.currencyCode).toStorage(),
            createdBy: auth.userId,
          })
          .returning();
        await this.record(tx, auth, propertyId, meta, 'reconciliation.started', row!.id, {
          account: account.name,
          statementDate: body.statementDate,
          statementBalance: body.statementBalance,
        });
        return this.detail(tx, property, row!.id);
      });
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new AppError(
          'CONFLICT',
          'This account already has a reconciliation in progress. Finish or abandon it first.',
        );
      }
      throw err;
    }
  }

  update(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: UpdateReconciliationRequest,
  ): Promise<ReconciliationDetailDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const rec = await this.lockOpen(tx, propertyId, id);
      if (body.statementDate) {
        await this.assertDate(tx, property, rec.cashAccountId, body.statementDate, rec.id);
        // Lines dated after a moved-back statement date no longer belong to it.
        await tx.execute(sql`
          delete from reconciliation_items i using journal_lines l, journal_entries e
          where i.reconciliation_id = ${id} and l.id = i.journal_line_id and e.id = l.journal_entry_id
            and e.accounting_date > ${body.statementDate}::date`);
      }
      const set = {
        ...(body.statementDate ? { statementDate: body.statementDate } : {}),
        ...(body.statementBalance
          ? { statementBalance: Money.of(body.statementBalance, property.currencyCode).toStorage() }
          : {}),
      };
      await tx.update(br).set(set).where(eq(br.id, id));
      return this.detail(tx, property, id);
    });
  }

  /** Replaces the ticked lines. Lines already reconciled elsewhere, or of another account, are refused. */
  setItems(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: ReconciliationItemsRequest,
  ): Promise<ReconciliationDetailDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const rec = await this.lockOpen(tx, propertyId, id);
      const wanted = [...new Set(body.journalLineIds)];
      if (wanted.length > 0) {
        const eligible = await tx.execute<{ id: string }>(sql`
          select l.id from journal_lines l join journal_entries e on e.id = l.journal_entry_id
          where l.id = any(${`{${wanted.join(',')}}`}::uuid[]) and l.cash_account_id = ${rec.cashAccountId}
            and e.status <> 'draft' and e.accounting_date <= ${rec.statementDate}::date
            and not exists (select 1 from reconciliation_items x
                            where x.journal_line_id = l.id and x.reconciliation_id <> ${id})`);
        const ok = new Set(eligible.rows.map((r) => r.id));
        const bad = wanted.filter((x) => !ok.has(x));
        if (bad.length > 0) {
          throw AppError.validation(
            `${bad.length} line(s) cannot be ticked: they belong to another account, are dated after the statement, or are already reconciled.`,
            [{ path: 'journalLineIds', message: 'Refresh the list and try again.' }],
          );
        }
      }
      await tx.delete(ri).where(eq(ri.reconciliationId, id));
      if (wanted.length > 0) {
        await tx.insert(ri).values(
          wanted.map((lineId) => ({
            tenantId: auth.tenantId,
            reconciliationId: id,
            journalLineId: lineId,
          })),
        );
      }
      return this.detail(tx, property, id);
    });
  }

  complete(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: CompleteReconciliationRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    const scope = `POST /properties/${propertyId}/reconciliations/${id}/complete`;
    return this.command(auth, scope, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const rec = await this.lockOpen(tx, propertyId, id);
      const cur = property.currencyCode;
      const cleared = await this.cleared(tx, rec, cur);
      const difference = Money.fromStorage(rec.statementBalance, cur).subtract(cleared);
      const explanation = body.explanation?.trim() || null;
      if (!difference.isZero() && (!explanation || explanation.length < 3)) {
        throw AppError.validation('Explain the difference between the statement and the ticked lines.', [
          { path: 'explanation', message: `The difference is ${difference.toString()}. Say why.` },
        ]);
      }
      await tx
        .update(br)
        .set({
          status: 'completed',
          clearedBalance: cleared.toStorage(),
          difference: difference.toStorage(),
          differenceExplanation: difference.isZero() ? null : explanation,
          completedBy: auth.userId,
          completedAt: sql`now()`,
        })
        .where(eq(br.id, id));
      await this.record(tx, auth, propertyId, meta, 'reconciliation.completed', id, {
        statementBalance: Money.fromStorage(rec.statementBalance, cur).toString(),
        clearedBalance: cleared.toString(),
        difference: difference.toString(),
      });
      return { status: 200, body: await this.detail(tx, property, id) };
    });
  }

  /** Abandons a reconciliation still in progress; its ticks go with it. A completed one stays. */
  abandon(auth: AuthContext, propertyId: string, id: string, meta: RequestMeta): Promise<{ id: string }> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const rec = await this.lockOpen(tx, propertyId, id);
      await tx.delete(br).where(eq(br.id, id));
      await this.record(tx, auth, propertyId, meta, 'reconciliation.abandoned', id, {
        statementDate: rec.statementDate,
      });
      return { id };
    });
  }

  // ------------------------------------------------------------------------------------------- card settlements

  listSettlements(auth: AuthContext, propertyId: string): Promise<CardSettlementDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const rows = await tx
        .select({ id: cs.id })
        .from(cs)
        .where(eq(cs.propertyId, propertyId))
        .orderBy(desc(cs.createdAt))
        .limit(50);
      return this.settlementDtos(
        tx,
        property,
        rows.map((r) => r.id),
      );
    });
  }

  settle(
    auth: AuthContext,
    propertyId: string,
    body: CardSettlementRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /properties/${propertyId}/card-settlements`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const cur = property.currencyCode;
      const lock = async (id: string) => {
        const [row] = await tx
          .select()
          .from(ca)
          .where(and(eq(ca.propertyId, propertyId), eq(ca.id, id)))
          .for('update');
        if (!row) throw AppError.notFound('cash account');
        return row;
      };
      const clearing = await lock(body.clearingAccountId);
      const bank = await lock(body.bankAccountId);
      if (clearing.kind !== 'card_clearing' || !clearing.active) {
        throw AppError.validation('Choose an active card clearing account.', [
          { path: 'clearingAccountId', message: 'Choose the card terminal account.' },
        ]);
      }
      if (bank.kind !== 'bank' || !bank.active) {
        throw AppError.validation('Choose an active bank account.', [
          { path: 'bankAccountId', message: 'Choose a bank account.' },
        ]);
      }
      const gross = Money.of(body.grossAmount, cur);
      const fee = Money.of(body.feeAmount, cur);
      if (fee.compare(gross) >= 0) {
        throw AppError.validation('The fee must be less than the amount settled.', [
          { path: 'feeAmount', message: `Less than ${gross.toString()}` },
        ]);
      }
      const held = await this.balance(tx, clearing.id, cur);
      if (gross.compare(held) > 0) {
        throw new AppError(
          'CONFLICT',
          `${clearing.name} holds ${held.toString()} ${cur}. A settlement cannot be more than the card payments waiting.`,
          [{ path: 'grossAmount', message: `At most ${held.isPositive() ? held.toString() : '0.00'}` }],
        );
      }
      const [charges] = await tx
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(eq(schema.accounts.systemRole, 'bank_charges'));
      if (!charges) throw AppError.notFound('bank charges account');
      const net = gross.subtract(fee);
      const id = randomUUID();
      const journalId = await this.posting.post(tx, auth, {
        propertyId,
        sourceType: 'card_settlement',
        sourceId: id,
        reference: body.reference || null,
        narration: `Card settlement from ${clearing.name} to ${bank.name}`,
        lines: [
          { accountId: bank.ledgerAccountId, debit: net.toString(), credit: '0', cashAccountId: bank.id },
          ...(fee.isPositive()
            ? [{ accountId: charges.id, debit: fee.toString(), credit: '0', description: 'Card fee' }]
            : []),
          {
            accountId: clearing.ledgerAccountId,
            debit: '0',
            credit: gross.toString(),
            cashAccountId: clearing.id,
          },
        ],
        idempotencyKey: key ?? null,
      });
      await tx.insert(cs).values({
        id,
        tenantId: auth.tenantId,
        propertyId,
        clearingAccountId: clearing.id,
        bankAccountId: bank.id,
        grossAmount: gross.toStorage(),
        feeAmount: fee.toStorage(),
        businessDate: property.businessDate,
        reference: body.reference || null,
        journalEntryId: journalId,
        createdBy: auth.userId,
      });
      await this.record(tx, auth, propertyId, meta, 'cash.card_settled', id, {
        gross: gross.toString(),
        fee: fee.toString(),
        to: bank.name,
      });
      return { status: 201, body: (await this.settlementDtos(tx, property, [id]))[0]! };
    });
  }

  // ------------------------------------------------------------------------------------------- internals

  /** Statement dates move forward: after the last completed one, and not after the business date. */
  private async assertDate(
    tx: Tx,
    property: PropertyRow,
    accountId: string,
    date: string,
    selfId: string | null,
  ) {
    if (date > property.businessDate) {
      throw AppError.validation('The statement date cannot be after the business date.', [
        { path: 'statementDate', message: `At most ${property.businessDate}` },
      ]);
    }
    const [last] = await tx
      .select({ d: br.statementDate })
      .from(br)
      .where(
        and(
          eq(br.cashAccountId, accountId),
          eq(br.status, 'completed'),
          selfId ? sql`${br.id} <> ${selfId}` : undefined,
        ),
      )
      .orderBy(desc(br.statementDate))
      .limit(1);
    if (last && date <= last.d) {
      throw AppError.validation(
        `This account is reconciled up to ${last.d}. Choose a later statement date.`,
        [{ path: 'statementDate', message: `After ${last.d}` }],
      );
    }
  }

  /** Lines reconciled in completed reconciliations of the account plus the lines ticked in this one. */
  private async cleared(tx: Tx, rec: RecRow, cur: string): Promise<Money> {
    const r = await tx.execute<{ b: string }>(sql`
      select coalesce(sum(l.debit - l.credit), 0)::text as b
      from reconciliation_items i
      join bank_reconciliations b on b.id = i.reconciliation_id
      join journal_lines l on l.id = i.journal_line_id
      where b.cash_account_id = ${rec.cashAccountId} and (b.status = 'completed' or b.id = ${rec.id})`);
    return Money.fromStorage(r.rows[0]!.b, cur).round();
  }

  private async balance(tx: Tx, cashAccountId: string, cur: string): Promise<Money> {
    const r = await tx.execute<{ b: string }>(sql`
      select coalesce(sum(l.debit - l.credit), 0)::text as b
      from journal_lines l join journal_entries e on e.id = l.journal_entry_id
      where l.cash_account_id = ${cashAccountId} and e.status <> 'draft'`);
    return Money.fromStorage(r.rows[0]!.b, cur).round();
  }

  private async rec(tx: Tx, propertyId: string, id: string): Promise<RecRow> {
    const [row] = await tx
      .select()
      .from(br)
      .where(and(eq(br.propertyId, propertyId), eq(br.id, id)));
    if (!row) throw AppError.notFound('reconciliation');
    return row;
  }

  private async lockOpen(tx: Tx, propertyId: string, id: string): Promise<RecRow> {
    const [row] = await tx
      .select()
      .from(br)
      .where(and(eq(br.propertyId, propertyId), eq(br.id, id)))
      .for('update');
    if (!row) throw AppError.notFound('reconciliation');
    if (row.status !== 'in_progress') {
      throw new AppError('CONFLICT', 'This reconciliation is completed and cannot be changed.');
    }
    return row;
  }

  private async detail(tx: Tx, property: PropertyRow, id: string): Promise<ReconciliationDetailDto> {
    const [dto] = await this.dtos(tx, property, [id]);
    const rec = await this.rec(tx, property.id, id);
    const cur = property.currencyCode;
    const open = rec.status === 'in_progress';
    const rows = await tx.execute<{
      line_id: string;
      entry_id: string;
      journal_number: string | null;
      accounting_date: string;
      narration: string;
      description: string | null;
      reference: string | null;
      source_type: string;
      amount: string;
      ticked: boolean;
    }>(sql`
      select l.id as line_id, e.id as entry_id, e.journal_number, e.accounting_date::text, e.narration,
             l.description, e.reference, e.source_type, (l.debit - l.credit)::text as amount,
             exists (select 1 from reconciliation_items x where x.journal_line_id = l.id and x.reconciliation_id = ${id})
               as ticked
      from journal_lines l join journal_entries e on e.id = l.journal_entry_id
      where l.cash_account_id = ${rec.cashAccountId} and e.status <> 'draft'
        and (
          exists (select 1 from reconciliation_items x where x.journal_line_id = l.id and x.reconciliation_id = ${id})
          or (${open}::boolean and e.accounting_date <= ${rec.statementDate}::date
              and not exists (select 1 from reconciliation_items x where x.journal_line_id = l.id))
        )
      order by e.accounting_date, e.journal_number, l.line_no`);
    return {
      ...dto!,
      lines: rows.rows.map((r) => ({
        journalLineId: r.line_id,
        entryId: r.entry_id,
        journalNumber: r.journal_number === null ? null : Number(r.journal_number),
        accountingDate: r.accounting_date,
        narration: r.narration,
        description: r.description,
        reference: r.reference,
        sourceType: r.source_type,
        amount: Money.fromStorage(r.amount, cur).round().toString(),
        ticked: r.ticked,
      })),
    };
  }

  private async dtos(tx: Tx, property: PropertyRow, ids: string[]): Promise<ReconciliationDto[]> {
    if (ids.length === 0) return [];
    const cur = property.currencyCode;
    const creator = alias(schema.users, 'creator');
    const completer = alias(schema.users, 'completer');
    const rows = await tx
      .select({
        r: br,
        account: ca.name,
        creator: creator.fullName,
        completer: completer.fullName,
        ticked: sql<string>`(select count(*)::text from reconciliation_items x where x.reconciliation_id = ${br.id})`,
        previous: sql<string | null>`(select max(p.statement_date)::text from bank_reconciliations p
          where p.cash_account_id = ${br.cashAccountId} and p.status = 'completed'
            and p.statement_date < ${br.statementDate})`,
      })
      .from(br)
      .innerJoin(ca, eq(ca.id, br.cashAccountId))
      .leftJoin(creator, eq(creator.id, br.createdBy))
      .leftJoin(completer, eq(completer.id, br.completedBy))
      .where(inArray(br.id, ids))
      .orderBy(desc(br.statementDate), desc(br.createdAt));
    const out: ReconciliationDto[] = [];
    for (const { r, account, creator: by, completer: done, ticked, previous } of rows) {
      const statement = Money.fromStorage(r.statementBalance, cur).round();
      const cleared =
        r.status === 'completed'
          ? Money.fromStorage(r.clearedBalance!, cur).round()
          : await this.cleared(tx, r, cur);
      out.push({
        id: r.id,
        cashAccountId: r.cashAccountId,
        cashAccountName: account,
        statementDate: r.statementDate,
        statementBalance: statement.toString(),
        status: r.status as ReconciliationDto['status'],
        clearedBalance: cleared.toString(),
        difference: statement.subtract(cleared).toString(),
        differenceExplanation: r.differenceExplanation,
        previousStatementDate: previous,
        tickedCount: Number(ticked),
        createdByName: by,
        createdAt: r.createdAt.toISOString(),
        completedByName: done,
        completedAt: r.completedAt?.toISOString() ?? null,
      });
    }
    return out;
  }

  private async settlementDtos(tx: Tx, property: PropertyRow, ids: string[]): Promise<CardSettlementDto[]> {
    if (ids.length === 0) return [];
    const cur = property.currencyCode;
    const clearing = alias(ca, 'clearing');
    const bank = alias(ca, 'bank');
    const rows = await tx
      .select({ s: cs, clearing: clearing.name, bank: bank.name, by: schema.users.fullName })
      .from(cs)
      .innerJoin(clearing, eq(clearing.id, cs.clearingAccountId))
      .innerJoin(bank, eq(bank.id, cs.bankAccountId))
      .leftJoin(schema.users, eq(schema.users.id, cs.createdBy))
      .where(inArray(cs.id, ids))
      .orderBy(desc(cs.createdAt));
    return rows.map(({ s, clearing: c, bank: b, by }) => {
      const gross = Money.fromStorage(s.grossAmount, cur).round();
      const fee = Money.fromStorage(s.feeAmount, cur).round();
      return {
        id: s.id,
        clearingAccountName: c,
        bankAccountName: b,
        grossAmount: gross.toString(),
        feeAmount: fee.toString(),
        netAmount: gross.subtract(fee).toString(),
        businessDate: s.businessDate,
        reference: s.reference,
        journalEntryId: s.journalEntryId,
        createdByName: by,
        createdAt: s.createdAt.toISOString(),
      };
    });
  }

  private command<T>(
    auth: AuthContext,
    scope: string,
    key: string | undefined,
    body: unknown,
    execute: (tx: Tx) => Promise<{ status: number; body: T }>,
  ) {
    return ledgerErrors(() =>
      this.db.tenant(auth.tenantId, (tx) =>
        this.idempotency.run(
          tx,
          { tenantId: auth.tenantId, actorUserId: auth.userId, scope, key, body },
          () => execute(tx),
        ),
      ),
    );
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
    id: string,
    changes: Record<string, unknown>,
  ) {
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType: action.startsWith('cash.') ? 'card_settlement' : 'bank_reconciliation',
        entityId: id,
        changes,
      },
      meta,
    );
  }
}
