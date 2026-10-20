import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  ExpenseAccountDto,
  ExpenseDraftRequest,
  ExpenseDto,
  ExpenseListQuery,
  ExpenseStatus,
  PayExpenseRequest,
  SubmitExpenseRequest,
  VoidExpenseRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ledgerErrors, PostingService, type PostingLine } from './posting.service';

const v = schema.expenseVouchers;
const el = schema.expenseLines;
const ep = schema.expensePayments;
const ca = schema.cashAccounts;
type VoucherRow = typeof v.$inferSelect;
type PropertyRow = typeof schema.properties.$inferSelect;

const pad = (n: number) => String(n).padStart(6, '0');
const LINE_CLASSES = new Set(['expense', 'cost_of_sales', 'asset']);

/**
 * Expenses and supplier bills (P4-6, P4-7). Two flows, each posted once through PostingService:
 *   cash expense — recorded when the money leaves: Dr expense lines (+ Dr Tax recoverable), Cr the cash or bank
 *     account; reviewed afterwards by someone else holding `expense.approve`;
 *   supplier bill — submitted, then approved by someone else: Dr expense lines (+ Dr Tax recoverable), Cr Accounts
 *     payable with the supplier; paid in one or more payments: Dr Accounts payable, Cr cash or bank.
 * Lines and amounts are fixed once submitted (the database refuses changes); mistakes are voided with a reason, and
 * anything already posted is reversed, never deleted.
 */
@Injectable()
export class ExpenseService {
  constructor(
    private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // ------------------------------------------------------------------------------------------- reads

  /** Everyone's for approvers, payers and ledger readers; otherwise only the vouchers the caller created. */
  list(auth: AuthContext, propertyId: string, q: ExpenseListQuery): Promise<ExpenseDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const filters: Record<ExpenseListQuery['status'], SQL | undefined> = {
        to_approve: sql`(${v.status} = 'submitted' or (${v.kind} = 'cash' and ${v.status} = 'paid' and ${v.approvedBy} is null))`,
        unpaid: inArray(v.status, ['approved', 'partly_paid']),
        draft: eq(v.status, 'draft'),
        paid: eq(v.status, 'paid'),
        void: eq(v.status, 'void'),
        all: undefined,
      };
      const rows = await tx
        .select({ id: v.id })
        .from(v)
        .where(
          and(
            eq(v.propertyId, propertyId),
            this.seesAll(auth, propertyId) ? undefined : eq(v.createdBy, auth.userId),
            filters[q.status],
            q.supplierId ? eq(v.supplierId, q.supplierId) : undefined,
            q.from ? gte(v.expenseDate, q.from) : undefined,
            q.to ? lte(v.expenseDate, q.to) : undefined,
          ),
        )
        .orderBy(desc(v.createdAt))
        .limit(q.limit);
      return this.dtos(
        tx,
        property,
        rows.map((r) => r.id),
      );
    });
  }

  get(auth: AuthContext, propertyId: string, id: string): Promise<ExpenseDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const row = await this.voucher(tx, propertyId, id);
      this.assertVisible(auth, propertyId, row);
      return (await this.dtos(tx, property, [id]))[0]!;
    });
  }

  /** Accounts expense lines may use, for people who cannot read the whole chart of accounts. */
  accounts(auth: AuthContext, propertyId: string): Promise<ExpenseAccountDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.property(tx, propertyId);
      const cashLedgers = new Set(
        (await tx.select({ id: ca.ledgerAccountId }).from(ca).where(eq(ca.propertyId, propertyId))).map(
          (x) => x.id,
        ),
      );
      const rows = await tx.select().from(schema.accounts).orderBy(asc(schema.accounts.code));
      return rows
        .filter((a) => a.active && LINE_CLASSES.has(a.accountClass))
        .filter((a) => a.accountClass !== 'asset' || (!a.systemRole && !cashLedgers.has(a.id)))
        .map((a) => ({ id: a.id, code: a.code, name: a.name }));
    });
  }

  // ------------------------------------------------------------------------------------------- drafts

  create(
    auth: AuthContext,
    propertyId: string,
    body: ExpenseDraftRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /properties/${propertyId}/expenses`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const draft = await this.validateDraft(tx, property, body);
      const number = await this.posting.nextNumber(tx, auth.tenantId, propertyId, 'expense');
      const id = randomUUID();
      await tx.insert(v).values({
        id,
        tenantId: auth.tenantId,
        propertyId,
        voucherNumber: `EXP-${pad(number)}`,
        kind: body.kind,
        createdBy: auth.userId,
        ...draft.fields,
      });
      await this.writeLines(tx, auth, id, body);
      await this.record(tx, auth, propertyId, meta, 'expense.created', id, {
        voucherNumber: `EXP-${pad(number)}`,
        kind: body.kind,
        total: draft.fields.totalAmount,
      });
      return { status: 201, body: (await this.dtos(tx, property, [id]))[0]! };
    });
  }

  update(auth: AuthContext, propertyId: string, id: string, body: ExpenseDraftRequest, meta: RequestMeta) {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = await this.property(tx, propertyId);
      const row = await this.lock(tx, propertyId, id);
      this.assertVisible(auth, propertyId, row);
      if (row.status !== 'draft') {
        throw new AppError('CONFLICT', 'Only a draft can be changed. Void it and record it again instead.');
      }
      if (body.kind !== row.kind) throw AppError.validation('The kind of an expense cannot change.');
      const draft = await this.validateDraft(tx, property, body);
      await tx.update(v).set(draft.fields).where(eq(v.id, id));
      await tx.delete(el).where(eq(el.voucherId, id));
      await this.writeLines(tx, auth, id, body);
      await this.record(tx, auth, propertyId, meta, 'expense.updated', id, {
        voucherNumber: row.voucherNumber,
        total: draft.fields.totalAmount,
      });
      return (await this.dtos(tx, property, [id]))[0]!;
    });
  }

  // ------------------------------------------------------------------------------------------- workflow

  /**
   * Submits a draft. A cash expense is paid now: posted from its cash or bank account in one step. A bill goes for
   * approval.
   */
  submit(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: SubmitExpenseRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(
      auth,
      `POST /properties/${propertyId}/expenses/${id}/submit`,
      key,
      body,
      async (tx) => {
        const property = await this.property(tx, propertyId);
        const row = await this.lock(tx, propertyId, id);
        this.assertVisible(auth, propertyId, row);
        if (row.status !== 'draft')
          throw new AppError('CONFLICT', `${row.voucherNumber} has already been submitted.`);
        if (row.kind === 'bill') {
          await tx
            .update(v)
            .set({ status: 'submitted', submittedBy: auth.userId, submittedAt: sql`now()` })
            .where(eq(v.id, id));
          await this.record(tx, auth, propertyId, meta, 'expense.submitted', id, {
            voucherNumber: row.voucherNumber,
          });
        } else {
          const cashAccountId = body.cashAccountId ?? row.cashAccountId;
          if (!cashAccountId) {
            throw AppError.validation('Choose the drawer or bank account the money was paid from.', [
              { path: 'cashAccountId', message: 'Choose an account.' },
            ]);
          }
          const cash = await this.cashAccount(
            tx,
            property,
            cashAccountId,
            Money.fromStorage(row.totalAmount, property.currencyCode),
          );
          const journalId = await this.posting.post(tx, auth, {
            propertyId,
            sourceType: 'expense',
            sourceId: id,
            reference: row.voucherNumber,
            narration: `Expense ${row.voucherNumber}: ${row.description}`,
            lines: [
              ...(await this.costLines(tx, property, id)),
              {
                accountId: cash.ledgerAccountId,
                debit: '0',
                credit: Money.fromStorage(row.totalAmount, property.currencyCode).toString(),
                cashAccountId: cash.id,
              },
            ],
            idempotencyKey: key ?? null,
          });
          await tx
            .update(v)
            .set({
              status: 'paid',
              cashAccountId: cash.id,
              journalEntryId: journalId,
              submittedBy: auth.userId,
              submittedAt: sql`now()`,
            })
            .where(eq(v.id, id));
          await this.record(tx, auth, propertyId, meta, 'expense.paid', id, {
            voucherNumber: row.voucherNumber,
            amount: Money.fromStorage(row.totalAmount, property.currencyCode).toString(),
            from: cash.name,
          });
        }
        return { status: 200, body: (await this.dtos(tx, property, [id]))[0]! };
      },
    );
  }

  /**
   * Approves a submitted bill into accounts payable, or reviews a paid cash expense. Never by whoever created or
   * submitted it (maker-checker).
   */
  approve(auth: AuthContext, propertyId: string, id: string, key: string | undefined, meta: RequestMeta) {
    return this.command(
      auth,
      `POST /properties/${propertyId}/expenses/${id}/approve`,
      key,
      {},
      async (tx) => {
        const property = await this.property(tx, propertyId);
        const row = await this.lock(tx, propertyId, id);
        if (row.createdBy === auth.userId || row.submittedBy === auth.userId) {
          throw new AppError('FORBIDDEN', 'You recorded this expense. Someone else must approve it.');
        }
        if (row.kind === 'bill' && row.status === 'submitted') {
          const total = Money.fromStorage(row.totalAmount, property.currencyCode);
          const payable = await this.systemAccount(tx, 'accounts_payable');
          const journalId = await this.posting.post(tx, auth, {
            propertyId,
            sourceType: 'expense',
            sourceId: id,
            reference: row.billReference ?? row.voucherNumber,
            narration: `Bill ${row.voucherNumber}: ${row.description}`,
            lines: [
              ...(await this.costLines(tx, property, id)),
              { accountId: payable, debit: '0', credit: total.toString(), supplierId: row.supplierId },
            ],
          });
          await tx
            .update(v)
            .set({
              status: 'approved',
              approvedBy: auth.userId,
              approvedAt: sql`now()`,
              journalEntryId: journalId,
            })
            .where(eq(v.id, id));
        } else if (row.kind === 'cash' && row.status === 'paid' && !row.approvedBy) {
          await tx
            .update(v)
            .set({ approvedBy: auth.userId, approvedAt: sql`now()` })
            .where(eq(v.id, id));
        } else {
          throw new AppError('CONFLICT', `${row.voucherNumber} is not waiting for approval.`);
        }
        await this.record(tx, auth, propertyId, meta, 'expense.approved', id, {
          voucherNumber: row.voucherNumber,
        });
        return { status: 200, body: (await this.dtos(tx, property, [id]))[0]! };
      },
    );
  }

  /** Pays part or all of an approved bill: Dr Accounts payable (the supplier), Cr cash or bank. */
  pay(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: PayExpenseRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /properties/${propertyId}/expenses/${id}/pay`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const cur = property.currencyCode;
      const row = await this.lock(tx, propertyId, id);
      if (row.kind !== 'bill' || !['approved', 'partly_paid'].includes(row.status)) {
        throw new AppError('CONFLICT', `${row.voucherNumber} is not an approved, unpaid bill.`);
      }
      const amount = Money.of(body.amount, cur);
      const outstanding = Money.fromStorage(row.totalAmount, cur).subtract(await this.paid(tx, id, cur));
      if (amount.compare(outstanding) > 0) {
        throw new AppError(
          'PAYMENT_EXCEEDS_BALANCE',
          `Only ${outstanding.toString()} ${cur} is still owed on this bill.`,
          [{ path: 'amount', message: `At most ${outstanding.toString()}` }],
        );
      }
      const cash = await this.cashAccount(tx, property, body.cashAccountId, amount);
      const payable = await this.systemAccount(tx, 'accounts_payable');
      const paymentId = randomUUID();
      const journalId = await this.posting.post(tx, auth, {
        propertyId,
        sourceType: 'expense_payment',
        sourceId: paymentId,
        reference: body.reference || row.voucherNumber,
        narration: `Payment of bill ${row.voucherNumber}`,
        lines: [
          { accountId: payable, debit: amount.toString(), credit: '0', supplierId: row.supplierId },
          { accountId: cash.ledgerAccountId, debit: '0', credit: amount.toString(), cashAccountId: cash.id },
        ],
        idempotencyKey: key ?? null,
      });
      await tx.insert(ep).values({
        id: paymentId,
        tenantId: auth.tenantId,
        propertyId,
        voucherId: id,
        cashAccountId: cash.id,
        amount: amount.toStorage(),
        businessDate: property.businessDate,
        reference: body.reference || null,
        journalEntryId: journalId,
        createdBy: auth.userId,
      });
      const status: ExpenseStatus = amount.equals(outstanding) ? 'paid' : 'partly_paid';
      await tx.update(v).set({ status }).where(eq(v.id, id));
      await this.record(tx, auth, propertyId, meta, 'expense.payment_made', id, {
        voucherNumber: row.voucherNumber,
        amount: amount.toString(),
        from: cash.name,
      });
      return { status: 201, body: (await this.dtos(tx, property, [id]))[0]! };
    });
  }

  /**
   * Voids a voucher with a reason. A draft or submitted one simply stops; a posted one (an approved bill not yet
   * paid, or a paid cash expense) is reversed, which needs `expense.approve`. A bill with payments cannot be voided.
   */
  void(
    auth: AuthContext,
    propertyId: string,
    id: string,
    body: VoidExpenseRequest,
    key: string | undefined,
    meta: RequestMeta,
  ) {
    return this.command(auth, `POST /properties/${propertyId}/expenses/${id}/void`, key, body, async (tx) => {
      const property = await this.property(tx, propertyId);
      const row = await this.lock(tx, propertyId, id);
      this.assertVisible(auth, propertyId, row);
      if (row.status === 'void') throw new AppError('CONFLICT', `${row.voucherNumber} is already void.`);
      if (row.status === 'partly_paid' || (row.kind === 'bill' && row.status === 'paid')) {
        throw new AppError('CONFLICT', 'This bill has payments. It cannot be voided.');
      }
      if (row.journalEntryId) {
        if (!auth.permissionsByProperty.get(propertyId)?.has('expense.approve')) {
          throw new AppError('FORBIDDEN', 'Voiding a posted expense needs someone who can approve expenses.');
        }
        await this.posting.reverse(
          tx,
          auth,
          row.journalEntryId,
          `${row.voucherNumber} voided (${body.reason})`,
        );
      }
      await tx
        .update(v)
        .set({ status: 'void', voidedBy: auth.userId, voidedAt: sql`now()`, voidReason: body.reason })
        .where(eq(v.id, id));
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId,
          actor: { type: 'user', userId: auth.userId },
          action: 'expense.voided',
          entityType: 'expense',
          entityId: id,
          changes: {
            voucherNumber: row.voucherNumber,
            previousStatus: row.status,
            reversed: !!row.journalEntryId,
          },
          reason: body.reason,
        },
        meta,
      );
      return { status: 200, body: (await this.dtos(tx, property, [id]))[0]! };
    });
  }

  // ------------------------------------------------------------------------------------------- internals

  /** Cost side of the entry: each line's account with any non-recoverable tax, and recoverable tax to 1300. */
  private async costLines(tx: Tx, property: PropertyRow, voucherId: string): Promise<PostingLine[]> {
    const cur = property.currencyCode;
    const lines = await tx.select().from(el).where(eq(el.voucherId, voucherId)).orderBy(asc(el.lineNo));
    const out: PostingLine[] = lines.map((x) => {
      const amount = Money.fromStorage(x.amount, cur);
      const tax = Money.fromStorage(x.taxAmount, cur);
      return {
        accountId: x.accountId,
        debit: (x.taxRecoverable ? amount : amount.add(tax)).round().toString(),
        credit: '0',
        description: x.description,
      };
    });
    const recoverable = Money.sum(
      lines.filter((x) => x.taxRecoverable).map((x) => Money.fromStorage(x.taxAmount, cur)),
      cur,
    );
    if (recoverable.isPositive()) {
      out.push({
        accountId: await this.systemAccount(tx, 'tax_recoverable'),
        debit: recoverable.round().toString(),
        credit: '0',
        description: 'Recoverable purchase tax',
      });
    }
    return out;
  }

  private async validateDraft(tx: Tx, property: PropertyRow, body: ExpenseDraftRequest) {
    const cur = property.currencyCode;
    if (body.expenseDate > property.businessDate) {
      throw AppError.validation('The expense date cannot be after the business date.', [
        { path: 'expenseDate', message: `At most ${property.businessDate}` },
      ]);
    }
    const accounts = await tx.select().from(schema.accounts);
    const cashLedgers = new Set(
      (await tx.select({ id: ca.ledgerAccountId }).from(ca).where(eq(ca.propertyId, property.id))).map(
        (x) => x.id,
      ),
    );
    const issues = body.lines.flatMap((line, i) => {
      const a = accounts.find((x) => x.id === line.accountId);
      const path = `lines.${i}.accountId`;
      if (!a || !a.active) return [{ path, message: 'Choose an active account.' }];
      if (
        !LINE_CLASSES.has(a.accountClass) ||
        (a.accountClass === 'asset' && (a.systemRole || cashLedgers.has(a.id)))
      ) {
        return [{ path, message: `${a.code} ${a.name} cannot be used for an expense.` }];
      }
      return [];
    });
    if (issues.length > 0)
      throw AppError.validation('Some lines use accounts that cannot take an expense.', issues);

    let dueDate: string | null = null;
    if (body.supplierId) {
      const [supplier] = await tx
        .select()
        .from(schema.suppliers)
        .where(eq(schema.suppliers.id, body.supplierId));
      if (!supplier || !supplier.active) {
        throw AppError.validation('Choose an active supplier.', [
          { path: 'supplierId', message: 'Choose a supplier.' },
        ]);
      }
      if (body.kind === 'bill') {
        const d = new Date(`${body.expenseDate}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + supplier.paymentTermsDays);
        dueDate = body.dueDate ?? d.toISOString().slice(0, 10);
      }
    }
    if (body.cashAccountId) {
      const [c] = await tx
        .select()
        .from(ca)
        .where(and(eq(ca.propertyId, property.id), eq(ca.id, body.cashAccountId)));
      if (!c || !c.active) {
        throw AppError.validation('Choose an active cash or bank account.', [
          { path: 'cashAccountId', message: 'Choose an account.' },
        ]);
      }
    }
    const net = Money.sum(
      body.lines.map((x) => Money.of(x.amount, cur)),
      cur,
    );
    const tax = Money.sum(
      body.lines.map((x) => Money.of(x.taxAmount, cur)),
      cur,
    );
    for (const [i, line] of body.lines.entries()) {
      const t = Money.of(line.taxAmount, cur);
      if (!t.round().equals(t)) {
        throw AppError.validation('Tax has more decimal places than the currency allows.', [
          { path: `lines.${i}.taxAmount`, message: 'At most 2 decimal places.' },
        ]);
      }
    }
    return {
      fields: {
        supplierId: body.supplierId ?? null,
        payee: body.payee || null,
        expenseDate: body.expenseDate,
        dueDate,
        billReference: body.billReference || null,
        description: body.description,
        attachmentRef: body.attachmentRef || null,
        cashAccountId: body.kind === 'cash' ? (body.cashAccountId ?? null) : null,
        netAmount: net.toStorage(),
        taxAmount: tax.toStorage(),
        totalAmount: net.add(tax).toStorage(),
      },
    };
  }

  private async writeLines(tx: Tx, auth: AuthContext, voucherId: string, body: ExpenseDraftRequest) {
    await tx.insert(el).values(
      body.lines.map((x, i) => ({
        tenantId: auth.tenantId,
        voucherId,
        lineNo: i + 1,
        accountId: x.accountId,
        description: x.description || null,
        amount: x.amount,
        taxAmount: x.taxAmount,
        taxRecoverable: x.taxRecoverable,
      })),
    );
  }

  /** An active cash or bank account of the property; a cash drawer cannot pay out more than it holds. */
  private async cashAccount(tx: Tx, property: PropertyRow, id: string, amount: Money) {
    const [c] = await tx
      .select()
      .from(ca)
      .where(and(eq(ca.propertyId, property.id), eq(ca.id, id)))
      .for('update');
    if (!c || !c.active) {
      throw AppError.validation('Choose an active cash or bank account.', [
        { path: 'cashAccountId', message: 'Choose an account.' },
      ]);
    }
    if (c.kind === 'cash') {
      const r = await tx.execute<{ b: string }>(sql`
        select coalesce(sum(l.debit - l.credit), 0)::text as b
        from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        where l.cash_account_id = ${c.id} and e.status <> 'draft'`);
      const held = Money.fromStorage(r.rows[0]!.b, property.currencyCode).round();
      if (amount.compare(held) > 0) {
        throw new AppError(
          'CONFLICT',
          `${c.name} holds ${held.toString()} ${property.currencyCode}. A cash drawer cannot pay out more than it holds.`,
          [{ path: 'cashAccountId', message: `${c.name} holds ${held.toString()}` }],
        );
      }
    }
    return c;
  }

  private async paid(tx: Tx, voucherId: string, cur: string): Promise<Money> {
    const r = await tx.execute<{ p: string }>(
      sql`select coalesce(sum(amount), 0)::text as p from expense_payments where voucher_id = ${voucherId}`,
    );
    return Money.fromStorage(r.rows[0]!.p, cur).round();
  }

  private seesAll(auth: AuthContext, propertyId: string): boolean {
    const p = auth.permissionsByProperty.get(propertyId);
    return !!p && (p.has('expense.approve') || p.has('expense.pay') || p.has('journal.read'));
  }

  private assertVisible(auth: AuthContext, propertyId: string, row: VoucherRow) {
    if (row.createdBy !== auth.userId && !this.seesAll(auth, propertyId)) throw AppError.notFound('expense');
  }

  private async voucher(tx: Tx, propertyId: string, id: string): Promise<VoucherRow> {
    const [row] = await tx
      .select()
      .from(v)
      .where(and(eq(v.propertyId, propertyId), eq(v.id, id)));
    if (!row) throw AppError.notFound('expense');
    return row;
  }

  private async lock(tx: Tx, propertyId: string, id: string): Promise<VoucherRow> {
    const [row] = await tx
      .select()
      .from(v)
      .where(and(eq(v.propertyId, propertyId), eq(v.id, id)))
      .for('update');
    if (!row) throw AppError.notFound('expense');
    return row;
  }

  private async systemAccount(tx: Tx, role: string): Promise<string> {
    const [a] = await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.systemRole, role));
    if (!a) throw AppError.notFound('system account');
    return a.id;
  }

  private async dtos(tx: Tx, property: PropertyRow, ids: string[]): Promise<ExpenseDto[]> {
    if (ids.length === 0) return [];
    const cur = property.currencyCode;
    const m = (x: string) => Money.fromStorage(x, cur).round();
    const creator = alias(schema.users, 'creator');
    const submitter = alias(schema.users, 'submitter');
    const approver = alias(schema.users, 'approver');
    const voider = alias(schema.users, 'voider');
    const rows = await tx
      .select({
        v,
        supplier: schema.suppliers.name,
        cash: ca.name,
        journalNumber: schema.journalEntries.journalNumber,
        creator: creator.fullName,
        submitter: submitter.fullName,
        approver: approver.fullName,
        voider: voider.fullName,
      })
      .from(v)
      .leftJoin(schema.suppliers, eq(schema.suppliers.id, v.supplierId))
      .leftJoin(ca, eq(ca.id, v.cashAccountId))
      .leftJoin(schema.journalEntries, eq(schema.journalEntries.id, v.journalEntryId))
      .leftJoin(creator, eq(creator.id, v.createdBy))
      .leftJoin(submitter, eq(submitter.id, v.submittedBy))
      .leftJoin(approver, eq(approver.id, v.approvedBy))
      .leftJoin(voider, eq(voider.id, v.voidedBy))
      .where(inArray(v.id, ids))
      .orderBy(desc(v.createdAt));
    const lines = await tx
      .select({ l: el, code: schema.accounts.code, name: schema.accounts.name })
      .from(el)
      .innerJoin(schema.accounts, eq(schema.accounts.id, el.accountId))
      .where(inArray(el.voucherId, ids))
      .orderBy(asc(el.lineNo));
    const payer = alias(schema.users, 'payer');
    const payments = await tx
      .select({ p: ep, cash: ca.name, n: schema.journalEntries.journalNumber, by: payer.fullName })
      .from(ep)
      .innerJoin(ca, eq(ca.id, ep.cashAccountId))
      .innerJoin(schema.journalEntries, eq(schema.journalEntries.id, ep.journalEntryId))
      .leftJoin(payer, eq(payer.id, ep.createdBy))
      .where(inArray(ep.voucherId, ids))
      .orderBy(asc(ep.createdAt));
    return rows.map((r) => {
      const mine = payments.filter((p) => p.p.voucherId === r.v.id);
      const total = m(r.v.totalAmount);
      const paidAmount =
        r.v.kind === 'cash'
          ? r.v.status === 'paid'
            ? total
            : Money.zero(cur)
          : Money.sum(
              mine.map((p) => m(p.p.amount)),
              cur,
            );
      const live = r.v.status !== 'void' && r.v.status !== 'draft';
      return {
        id: r.v.id,
        voucherNumber: r.v.voucherNumber,
        kind: r.v.kind as ExpenseDto['kind'],
        status: r.v.status as ExpenseStatus,
        supplierId: r.v.supplierId,
        supplierName: r.supplier,
        payee: r.v.payee,
        expenseDate: r.v.expenseDate,
        dueDate: r.v.dueDate,
        billReference: r.v.billReference,
        description: r.v.description,
        attachmentRef: r.v.attachmentRef,
        cashAccountId: r.v.cashAccountId,
        cashAccountName: r.cash,
        netAmount: m(r.v.netAmount).toString(),
        taxAmount: m(r.v.taxAmount).toString(),
        totalAmount: total.toString(),
        paidAmount: paidAmount.toString(),
        outstanding: (live ? total.subtract(paidAmount) : Money.zero(cur)).toString(),
        needsApproval:
          r.v.status === 'submitted' || (r.v.kind === 'cash' && r.v.status === 'paid' && !r.v.approvedBy),
        journalEntryId: r.v.journalEntryId,
        journalNumber: r.journalNumber,
        createdById: r.v.createdBy,
        createdByName: r.creator,
        createdAt: r.v.createdAt.toISOString(),
        submittedByName: r.submitter,
        submittedAt: r.v.submittedAt?.toISOString() ?? null,
        approvedByName: r.approver,
        approvedAt: r.v.approvedAt?.toISOString() ?? null,
        voidedByName: r.voider,
        voidedAt: r.v.voidedAt?.toISOString() ?? null,
        voidReason: r.v.voidReason,
        lines: lines
          .filter((x) => x.l.voucherId === r.v.id)
          .map(({ l, code, name }) => ({
            id: l.id,
            lineNo: l.lineNo,
            accountId: l.accountId,
            accountCode: code,
            accountName: name,
            description: l.description,
            amount: m(l.amount).toString(),
            taxAmount: m(l.taxAmount).toString(),
            taxRecoverable: l.taxRecoverable,
          })),
        payments: mine.map(({ p, cash, n, by }) => ({
          id: p.id,
          amount: m(p.amount).toString(),
          cashAccountId: p.cashAccountId,
          cashAccountName: cash,
          businessDate: p.businessDate,
          reference: p.reference,
          journalEntryId: p.journalEntryId,
          journalNumber: n,
          createdByName: by,
          createdAt: p.createdAt.toISOString(),
        })),
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
        entityType: 'expense',
        entityId: id,
        changes,
      },
      meta,
    );
  }
}
