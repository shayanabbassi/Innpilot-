import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  CashAccountDto,
  CashAccountKind,
  CashMovementsDto,
  CashMovementsQuery,
  CreateCashAccountRequest,
  OpeningBalancesDto,
  OpeningBalancesRequest,
  TransferDto,
  TransferListQuery,
  TransferRequest,
  UpdateCashAccountRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService, changeSet } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ledgerErrors, PostingService } from './posting.service';

const ca = schema.cashAccounts;
const ct = schema.cashTransfers;
const ob = schema.openingBalances;
const acc = schema.accounts;
type CashRow = typeof ca.$inferSelect;
type PropertyRow = typeof schema.properties.$inferSelect;

/** The system ledger account each kind posts to unless another asset account is chosen. */
const DEFAULT_LEDGER_ROLE: Record<Exclude<CashAccountKind, 'other'>, string> = {
  cash: 'cash_on_hand',
  bank: 'bank',
  card_clearing: 'payment_clearing',
};
const CASH_ROLES = new Set(Object.values(DEFAULT_LEDGER_ROLE));

/** Opening balances on these follow guest folios, so they cannot be opened as plain amounts. */
const FOLIO_ROLES = new Set(['guest_receivable', 'guest_deposits']);
const BALANCE_SHEET = new Set(['asset', 'liability', 'equity']);

/**
 * Cash drawers and bank accounts (P4-1 to P4-3). Their money lives only in the ledger: balances and movements are
 * read from posted journal lines carrying the cash account, so the cashbook can never disagree with the ledger.
 * Transfers and opening balances are journals posted through PostingService like everything else.
 */
@Injectable()
export class CashService {
  constructor(
    private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ------------------------------------------------------------------------------------------- accounts

  list(auth: AuthContext, propertyId: string): Promise<CashAccountDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      return this.dtos(tx, auth, propertyId);
    });
  }

  async create(
    auth: AuthContext,
    propertyId: string,
    body: CreateCashAccountRequest,
    meta: RequestMeta,
  ): Promise<CashAccountDto> {
    try {
      return await this.db.tenant(auth.tenantId, async (tx) => {
        await this.property(tx, propertyId);
        const ledger = await this.ledgerFor(tx, propertyId, body);
        const [row] = await tx
          .insert(ca)
          .values({
            tenantId: auth.tenantId,
            propertyId,
            name: body.name,
            kind: body.kind,
            details: body.details || null,
            ledgerAccountId: ledger.id,
          })
          .returning();
        await this.record(tx, auth, propertyId, meta, 'cash_account.created', 'cash_account', row!.id, {
          name: row!.name,
          kind: row!.kind,
          ledgerAccountCode: ledger.code,
        });
        return this.one(tx, auth, propertyId, row!.id);
      });
    } catch (err) {
      throw this.duplicateName(err);
    }
  }

  async update(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: UpdateCashAccountRequest,
    meta: RequestMeta,
  ): Promise<CashAccountDto> {
    try {
      return await this.db.tenant(auth.tenantId, async (tx) => {
        const before = await this.lockAccount(tx, propertyId, id);
        if (body.active === false && before.active) {
          const balance = await this.balance(tx, id);
          if (!balance.isZero()) {
            throw new AppError(
              'CONFLICT',
              `${before.name} still holds ${balance.toString()}. Move the money out before closing the account.`,
            );
          }
        }
        const set = {
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.details !== undefined ? { details: body.details || null } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        };
        // Drizzle refuses an update with nothing to set.
        const row = Object.keys(set).length
          ? (await tx.update(ca).set(set).where(eq(ca.id, id)).returning())[0]!
          : before;
        const changes = changeSet(before, row, ['name', 'details', 'active']);
        if (Object.keys(changes).length > 0) {
          await this.record(tx, auth, propertyId, meta, 'cash_account.updated', 'cash_account', id, changes);
        }
        return this.one(tx, auth, propertyId, id);
      });
    } catch (err) {
      throw this.duplicateName(err);
    }
  }

  // ------------------------------------------------------------------------------------------- movements

  movements(
    auth: AuthContext,
    propertyId: string,
    id: string,
    q: CashMovementsQuery,
  ): Promise<CashMovementsDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const account = await this.one(tx, auth, propertyId, id);
      const currency = property.currencyCode;
      const opening = await tx.execute<{ b: string }>(sql`
        select coalesce(sum(l.debit - l.credit), 0)::text as b
        from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        where l.cash_account_id = ${id} and e.status <> 'draft' and e.accounting_date < ${q.from}::date`);
      const rows = await tx.execute<{
        entry_id: string;
        journal_number: string;
        accounting_date: string;
        narration: string;
        description: string | null;
        reference: string | null;
        source_type: string;
        debit: string;
        credit: string;
      }>(sql`
        select e.id as entry_id, e.journal_number, e.accounting_date::text, e.narration, l.description,
               e.reference, e.source_type, l.debit::text, l.credit::text
        from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        where l.cash_account_id = ${id} and e.status <> 'draft'
          and e.accounting_date between ${q.from}::date and ${q.to}::date
        order by e.accounting_date, e.journal_number, l.line_no`);
      let balance = Money.fromStorage(opening.rows[0]!.b, currency);
      const openingBalance = balance;
      let totalIn = Money.zero(currency);
      let totalOut = Money.zero(currency);
      const lines = rows.rows.map((r) => {
        const d = Money.fromStorage(r.debit, currency);
        const c = Money.fromStorage(r.credit, currency);
        totalIn = totalIn.add(d);
        totalOut = totalOut.add(c);
        balance = balance.add(d).subtract(c);
        return {
          entryId: r.entry_id,
          journalNumber: Number(r.journal_number),
          accountingDate: r.accounting_date,
          narration: r.narration,
          description: r.description,
          reference: r.reference,
          sourceType: r.source_type,
          in: d.round().toString(),
          out: c.round().toString(),
          balance: balance.round().toString(),
        };
      });
      return {
        account,
        from: q.from,
        to: q.to,
        openingBalance: openingBalance.round().toString(),
        totalIn: totalIn.round().toString(),
        totalOut: totalOut.round().toString(),
        closingBalance: balance.round().toString(),
        lines,
      };
    });
  }

  // ------------------------------------------------------------------------------------------- transfers

  listTransfers(auth: AuthContext, propertyId: string, q: TransferListQuery): Promise<TransferDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const rows = await tx
        .select({ id: ct.id })
        .from(ct)
        .where(
          and(
            eq(ct.propertyId, propertyId),
            q.from ? gte(ct.businessDate, q.from) : undefined,
            q.to ? lte(ct.businessDate, q.to) : undefined,
          ),
        )
        .orderBy(desc(ct.createdAt))
        .limit(q.limit);
      return this.transferDtos(
        tx,
        rows.map((x) => x.id),
      );
    });
  }

  /**
   * One journal per transfer: Dr the receiving account, Cr the sending one, both tagged (P4-2). Never revenue or
   * expense. A cash drawer cannot hand over more than it holds.
   */
  transfer(
    auth: AuthContext,
    propertyId: string,
    body: TransferRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /properties/${propertyId}/transfers`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const currency = property.currencyCode;
      // Lock both in a fixed order so two transfers between the same pair cannot deadlock.
      const [first, second] = [body.fromCashAccountId, body.toCashAccountId].sort();
      const a = await this.lockAccount(tx, propertyId, first!);
      const b = await this.lockAccount(tx, propertyId, second!);
      const from = a.id === body.fromCashAccountId ? a : b;
      const to = from === a ? b : a;
      for (const [x, path] of [
        [from, 'fromCashAccountId'],
        [to, 'toCashAccountId'],
      ] as const) {
        if (!x.active) {
          throw AppError.validation(`${x.name} is closed.`, [{ path, message: 'Choose an active account.' }]);
        }
      }
      const amount = Money.of(body.amount, currency);
      if (from.kind === 'cash') {
        const held = await this.balance(tx, from.id);
        if (amount.compare(held) > 0) {
          throw new AppError(
            'CONFLICT',
            `${from.name} holds ${held.toString()} ${currency}. A cash drawer cannot hand over more than it holds.`,
            [{ path: 'amount', message: `At most ${held.isPositive() ? held.toString() : '0.00'}` }],
          );
        }
      }
      const id = randomUUID();
      const journalId = await this.posting.post(tx, auth, {
        propertyId,
        sourceType: 'cash_transfer',
        sourceId: id,
        reference: body.reference || null,
        narration: `Transfer from ${from.name} to ${to.name}${body.notes ? `: ${body.notes}` : ''}`,
        lines: [
          { accountId: to.ledgerAccountId, debit: amount.toString(), credit: '0', cashAccountId: to.id },
          { accountId: from.ledgerAccountId, debit: '0', credit: amount.toString(), cashAccountId: from.id },
        ],
        idempotencyKey: key ?? null,
      });
      await tx.insert(ct).values({
        id,
        tenantId: auth.tenantId,
        propertyId,
        fromCashAccountId: from.id,
        toCashAccountId: to.id,
        amount: amount.toStorage(),
        businessDate: property.businessDate,
        reference: body.reference || null,
        notes: body.notes || null,
        journalEntryId: journalId,
        createdBy: auth.userId,
      });
      await this.record(tx, auth, propertyId, meta, 'cash.transferred', 'cash_transfer', id, {
        from: from.name,
        to: to.name,
        amount: amount.toString(),
      });
      return { status: 201, body: (await this.transferDtos(tx, [id]))[0]! };
    });
  }

  // ------------------------------------------------------------------------------------------- opening balances

  openingBalances(auth: AuthContext, propertyId: string): Promise<OpeningBalancesDto | null> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      return this.openingDto(tx, property);
    });
  }

  /**
   * The one-time opening entry for a property (P4-3): balance sheet accounts only, any difference to Opening
   * balance equity. Corrections afterwards are ordinary journals.
   */
  postOpeningBalances(
    auth: AuthContext,
    propertyId: string,
    body: OpeningBalancesRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /properties/${propertyId}/opening-balances`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const currency = property.currencyCode;
      // Serialise concurrent attempts on the property; the unique key is the final guard.
      await tx
        .select({ id: schema.properties.id })
        .from(schema.properties)
        .where(eq(schema.properties.id, propertyId))
        .for('update');
      const [existing] = await tx.select({ id: ob.id }).from(ob).where(eq(ob.propertyId, propertyId));
      if (existing) {
        throw new AppError(
          'CONFLICT',
          'Opening balances have already been entered for this property. Correct them with a journal entry.',
        );
      }
      const accounts = await tx.select().from(acc);
      const byId = new Map(accounts.map((x) => [x.id, x]));
      const issues = body.lines.flatMap((line, i) => {
        const a = byId.get(line.accountId);
        const path = `lines.${i}.accountId`;
        if (!a || !a.active) return [{ path, message: 'Choose an active account.' }];
        if (!BALANCE_SHEET.has(a.accountClass)) {
          return [
            {
              path,
              message: `${a.code} is not a balance sheet account. Only assets, liabilities and equity are opened.`,
            },
          ];
        }
        if (a.systemRole === 'opening_balance_equity') {
          return [{ path, message: 'The difference goes to this account automatically.' }];
        }
        if (a.systemRole && FOLIO_ROLES.has(a.systemRole)) {
          return [{ path, message: `${a.code} ${a.name} follows guest folios and cannot be opened here.` }];
        }
        return [];
      });
      if (issues.length > 0) throw AppError.validation('Some lines cannot be opened.', issues);

      const debit = Money.sum(
        body.lines.map((x) => Money.of(x.debit, currency)),
        currency,
      );
      const credit = Money.sum(
        body.lines.map((x) => Money.of(x.credit, currency)),
        currency,
      );
      const difference = debit.subtract(credit);
      const equity = accounts.find((x) => x.systemRole === 'opening_balance_equity');
      if (!equity) throw AppError.notFound('opening balance equity account');
      const lines = body.lines.map((x) => ({
        accountId: x.accountId,
        debit: x.debit,
        credit: x.credit,
        description: x.description ?? null,
        cashAccountId: x.cashAccountId ?? null,
        supplierId: x.supplierId ?? null,
      }));
      if (!difference.isZero()) {
        lines.push({
          accountId: equity.id,
          debit: difference.isNegative() ? difference.negate().toString() : '0',
          credit: difference.isPositive() ? difference.toString() : '0',
          description: 'Difference to opening balance equity',
          cashAccountId: null,
          supplierId: null,
        });
      }
      const id = randomUUID();
      const journalId = await this.posting.post(tx, auth, {
        propertyId,
        accountingDate: body.asOf,
        sourceType: 'opening_balance',
        sourceId: id,
        narration: `Opening balances as at ${body.asOf}`,
        lines,
        idempotencyKey: key ?? null,
      });
      await tx.insert(ob).values({
        id,
        tenantId: auth.tenantId,
        propertyId,
        asOf: body.asOf,
        journalEntryId: journalId,
        createdBy: auth.userId,
      });
      await this.record(
        tx,
        auth,
        propertyId,
        meta,
        'finance.opening_balances_posted',
        'opening_balance',
        id,
        {
          asOf: body.asOf,
          lines: body.lines.length,
          equityAmount: difference.toString(),
        },
      );
      return { status: 201, body: (await this.openingDto(tx, property))! };
    });
  }

  // ------------------------------------------------------------------------------------------- internals

  /** The ledger account for a new cash account: the kind's system account, or a chosen asset account. */
  private async ledgerFor(tx: Tx, propertyId: string, body: CreateCashAccountRequest) {
    if (!body.ledgerAccountId) {
      const role = DEFAULT_LEDGER_ROLE[body.kind as Exclude<CashAccountKind, 'other'>];
      const [row] = await tx.select().from(acc).where(eq(acc.systemRole, role));
      if (!row) throw AppError.notFound('ledger account');
      return row;
    }
    const [row] = await tx.select().from(acc).where(eq(acc.id, body.ledgerAccountId));
    const issue = (message: string) => AppError.validation(message, [{ path: 'ledgerAccountId', message }]);
    if (!row || !row.active) throw issue('Choose an active account from the chart of accounts.');
    if (row.accountClass !== 'asset') throw issue('Cash and bank accounts post to an asset account.');
    if (row.systemRole && !CASH_ROLES.has(row.systemRole)) {
      throw issue(`${row.code} ${row.name} is used by other posting rules.`);
    }
    // A ledger account already holding untagged money would make the cashbook disagree with the ledger.
    const [used] = await tx
      .select({ id: ca.id })
      .from(ca)
      .where(and(eq(ca.propertyId, propertyId), eq(ca.ledgerAccountId, row.id)))
      .limit(1);
    if (!used) {
      const posted = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        where l.account_id = ${row.id} and e.property_id = ${propertyId} and e.status <> 'draft'`);
      if (Number(posted.rows[0]!.n) > 0) {
        throw issue(
          `${row.code} already has postings. Choose an unused account or one already used for cash.`,
        );
      }
    }
    return row;
  }

  private async balance(tx: Tx, cashAccountId: string): Promise<Money> {
    const [property] = await tx
      .select({ c: schema.properties.currencyCode })
      .from(ca)
      .innerJoin(schema.properties, eq(schema.properties.id, ca.propertyId))
      .where(eq(ca.id, cashAccountId));
    const r = await tx.execute<{ b: string }>(sql`
      select coalesce(sum(l.debit - l.credit), 0)::text as b
      from journal_lines l join journal_entries e on e.id = l.journal_entry_id
      where l.cash_account_id = ${cashAccountId} and e.status <> 'draft'`);
    return Money.fromStorage(r.rows[0]!.b, property!.c).round();
  }

  private async lockAccount(tx: Tx, propertyId: string, id: string): Promise<CashRow> {
    const [row] = await tx
      .select()
      .from(ca)
      .where(and(eq(ca.propertyId, propertyId), eq(ca.id, id)))
      .for('update');
    if (!row) throw AppError.notFound('cash account');
    return row;
  }

  private async one(tx: Tx, auth: AuthContext, propertyId: string, id: string): Promise<CashAccountDto> {
    const [dto] = await this.dtos(tx, auth, propertyId, id);
    if (!dto) throw AppError.notFound('cash account');
    return dto;
  }

  private async dtos(tx: Tx, auth: AuthContext, propertyId: string, id?: string): Promise<CashAccountDto[]> {
    const showBalance = auth.permissionsByProperty.get(propertyId)?.has('journal.read') ?? false;
    const rows = await tx
      .select({
        c: ca,
        code: acc.code,
        ledgerName: acc.name,
        balance: sql<string>`(select coalesce(sum(l.debit - l.credit), 0)::text
          from journal_lines l join journal_entries e on e.id = l.journal_entry_id
          where l.cash_account_id = ${ca.id} and e.status <> 'draft')`,
        currency: schema.properties.currencyCode,
      })
      .from(ca)
      .innerJoin(acc, eq(acc.id, ca.ledgerAccountId))
      .innerJoin(schema.properties, eq(schema.properties.id, ca.propertyId))
      .where(and(eq(ca.propertyId, propertyId), id ? eq(ca.id, id) : undefined))
      .orderBy(asc(acc.code), asc(ca.createdAt));
    return rows.map(({ c, code, ledgerName, balance, currency }) => ({
      id: c.id,
      name: c.name,
      kind: c.kind as CashAccountKind,
      details: c.details,
      ledgerAccountId: c.ledgerAccountId,
      ledgerAccountCode: code,
      ledgerAccountName: ledgerName,
      active: c.active,
      balance: showBalance ? Money.fromStorage(balance, currency).round().toString() : null,
    }));
  }

  private async transferDtos(tx: Tx, ids: string[]): Promise<TransferDto[]> {
    if (ids.length === 0) return [];
    const fromA = alias(ca, 'from_account');
    const toA = alias(ca, 'to_account');
    const rows = await tx
      .select({
        t: ct,
        fromName: fromA.name,
        toName: toA.name,
        by: schema.users.fullName,
        journalNumber: schema.journalEntries.journalNumber,
      })
      .from(ct)
      .innerJoin(fromA, eq(fromA.id, ct.fromCashAccountId))
      .innerJoin(toA, eq(toA.id, ct.toCashAccountId))
      .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, ct.journalEntryId))
      .leftJoin(schema.users, eq(schema.users.id, ct.createdBy))
      .where(inArray(ct.id, ids))
      .orderBy(desc(ct.createdAt));
    return rows.map(({ t, fromName, toName, by, journalNumber }) => ({
      id: t.id,
      fromCashAccountId: t.fromCashAccountId,
      fromCashAccountName: fromName,
      toCashAccountId: t.toCashAccountId,
      toCashAccountName: toName,
      amount: money2(t.amount),
      businessDate: t.businessDate,
      reference: t.reference,
      notes: t.notes,
      journalEntryId: t.journalEntryId,
      journalNumber,
      createdByName: by,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  private async openingDto(tx: Tx, property: PropertyRow): Promise<OpeningBalancesDto | null> {
    const [row] = await tx
      .select({ o: ob, e: schema.journalEntries, by: schema.users.fullName })
      .from(ob)
      .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, ob.journalEntryId))
      .leftJoin(schema.users, eq(schema.users.id, ob.createdBy))
      .where(eq(ob.propertyId, property.id));
    if (!row) return null;
    const [eq3900] = await tx
      .execute<{ amount: string }>(
        sql`
      select coalesce(sum(l.credit - l.debit), 0)::text as amount
      from journal_lines l join accounts a on a.id = l.account_id
      where l.journal_entry_id = ${row.e.id} and a.system_role = 'opening_balance_equity'`,
      )
      .then((r) => r.rows);
    return {
      id: row.o.id,
      asOf: row.o.asOf,
      journalEntryId: row.e.id,
      journalNumber: row.e.journalNumber,
      totalDebit: money2(row.e.totalDebit),
      totalCredit: money2(row.e.totalCredit),
      equityAmount: Money.fromStorage(eq3900!.amount, property.currencyCode).round().toString(),
      createdByName: row.by,
      createdAt: row.o.createdAt.toISOString(),
    };
  }

  private duplicateName(err: unknown) {
    if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
      return AppError.validation('That name is already used.', [
        { path: 'name', message: 'Another cash or bank account has this name.' },
      ]);
    }
    return err;
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
    entityType: string,
    entityId: string,
    changes: Record<string, unknown>,
  ) {
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType,
        entityId,
        changes,
      },
      meta,
    );
  }
}

/** NUMERIC(19,4) → 2-decimal API form (amounts are whole paisa). */
function money2(value: string): string {
  return value.replace(/^(-?\d+)\.(\d{2})\d*$/, '$1.$2');
}
