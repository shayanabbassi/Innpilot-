import { Injectable } from '@nestjs/common';
import type {
  JournalDraftRequest,
  JournalEntryDto,
  JournalLineDto,
  JournalListDto,
  JournalListQuery,
  ReverseJournalRequest,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { and, asc, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { IdempotencyService } from '../idempotency/idempotency.service';
import { ledgerErrors, PostingService } from './posting.service';

const e = schema.journalEntries;
const l = schema.journalLines;
const creator = alias(schema.users, 'creator');
const poster = alias(schema.users, 'poster');
const reverses = alias(schema.journalEntries, 'reverses');
const reversedBy = alias(schema.journalEntries, 'reversed_by');

type Head = Omit<JournalEntryDto, 'lines'>;

/**
 * Manual journals: draft → post → (reverse). Posted entries are never edited (FIN-004); a reversal is an equal and
 * opposite entry linked to the original. Only manual entries are reversed here: entries from folios and payments
 * are corrected through their own workflows so the source records stay in step with the ledger.
 */
@Injectable()
export class JournalsService {
  constructor(
    private readonly db: Db,
    private readonly posting: PostingService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
  ) {}

  list(auth: AuthContext, q: JournalListQuery): Promise<JournalListDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const where = and(
        q.status ? eq(e.status, q.status) : undefined,
        q.propertyId ? eq(e.propertyId, q.propertyId) : undefined,
        q.from ? gte(e.accountingDate, q.from) : undefined,
        q.to ? lte(e.accountingDate, q.to) : undefined,
      );
      const [total] = await tx.select({ n: count() }).from(e).where(where);
      const items = await this.heads(tx, where, q.limit, q.offset);
      return { items, total: total?.n ?? 0 };
    });
  }

  get(auth: AuthContext, id: string): Promise<JournalEntryDto> {
    return this.db.tenant(auth.tenantId, (tx) => this.load(tx, id));
  }

  createDraft(
    auth: AuthContext,
    body: JournalDraftRequest,
    key: string | undefined,
    meta: RequestMeta,
  ): Promise<{ status: number; body: JournalEntryDto }> {
    return this.db.tenant(auth.tenantId, (tx) =>
      this.idempotency.run(
        tx,
        {
          tenantId: auth.tenantId,
          actorUserId: auth.userId,
          scope: 'POST /finance/journal-entries/draft',
          key,
          body,
        },
        async () => {
          await this.assertAccounts(tx, body);
          const id = await this.posting.createDraft(tx, auth, {
            propertyId: body.propertyId,
            accountingDate: body.accountingDate,
            sourceType: 'manual',
            narration: body.narration,
            reference: body.reference ?? null,
            lines: body.lines,
            idempotencyKey: key ?? null,
          });
          await this.record(tx, auth, meta, 'journal.draft_created', id, body.propertyId);
          return { status: 201, body: await this.load(tx, id) };
        },
      ),
    );
  }

  updateDraft(auth: AuthContext, id: string, body: JournalDraftRequest): Promise<JournalEntryDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const entry = await this.lockDraft(tx, id);
      await this.assertAccounts(tx, body);
      const [property] = await tx
        .select({ businessDate: schema.properties.businessDate, currency: schema.properties.currencyCode })
        .from(schema.properties)
        .where(eq(schema.properties.id, body.propertyId));
      if (!property) throw AppError.notFound('property');
      const date = body.accountingDate ?? property.businessDate;
      if (date > property.businessDate) {
        throw AppError.validation(
          `The accounting date ${date} is after the business date ${property.businessDate}.`,
        );
      }
      await tx
        .update(e)
        .set({
          propertyId: body.propertyId,
          accountingDate: date,
          currencyCode: property.currency,
          narration: body.narration,
          reference: body.reference ?? null,
        })
        .where(eq(e.id, entry.id));
      await this.posting.writeLines(tx, auth, id, property.currency, body.lines);
      return this.load(tx, id);
    });
  }

  deleteDraft(auth: AuthContext, id: string, meta: RequestMeta): Promise<{ id: string }> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const entry = await this.lockDraft(tx, id);
      await tx.delete(e).where(eq(e.id, id));
      await this.record(tx, auth, meta, 'journal.draft_deleted', id, entry.propertyId, {
        narration: entry.narration,
      });
      return { id };
    });
  }

  post(
    auth: AuthContext,
    id: string,
    key: string | undefined,
    meta: RequestMeta,
  ): Promise<{ status: number; body: JournalEntryDto }> {
    return ledgerErrors(() =>
      this.db.tenant(auth.tenantId, (tx) =>
        this.idempotency.run(
          tx,
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            scope: `POST /finance/journal-entries/${id}/post`,
            key,
            body: {},
          },
          async () => {
            const entry = await this.lockDraft(tx, id);
            await this.posting.postDraft(tx, auth, id);
            const posted = await this.load(tx, id);
            await this.record(tx, auth, meta, 'journal.posted', id, entry.propertyId, {
              journalNumber: posted.journalNumber,
              accountingDate: posted.accountingDate,
              total: posted.totalDebit,
            });
            return { status: 200, body: posted };
          },
        ),
      ),
    );
  }

  reverse(
    auth: AuthContext,
    id: string,
    body: ReverseJournalRequest,
    key: string | undefined,
    meta: RequestMeta,
  ): Promise<{ status: number; body: JournalEntryDto }> {
    return ledgerErrors(() =>
      this.db.tenant(auth.tenantId, (tx) =>
        this.idempotency.run(
          tx,
          {
            tenantId: auth.tenantId,
            actorUserId: auth.userId,
            scope: `POST /finance/journal-entries/${id}/reverse`,
            key,
            body,
          },
          async () => {
            const [original] = await tx.select().from(e).where(eq(e.id, id)).for('update');
            if (!original) throw AppError.notFound('journal entry');
            if (original.status === 'draft') {
              throw new AppError(
                'CONFLICT',
                'Drafts are not in the ledger. Edit or delete the draft instead.',
              );
            }
            if (original.status === 'reversed') {
              throw new AppError('CONFLICT', `Journal ${original.journalNumber} has already been reversed.`);
            }
            if (original.sourceType !== 'manual') {
              throw new AppError(
                'CONFLICT',
                'Only manual journals are reversed here. Correct this entry from the record that created it.',
              );
            }
            const lines = await tx.select().from(l).where(eq(l.journalEntryId, id)).orderBy(asc(l.lineNo));
            const reversalId = await this.posting.post(tx, auth, {
              propertyId: original.propertyId,
              accountingDate: body.accountingDate,
              sourceType: 'reversal',
              sourceId: original.id,
              purpose: 'reversal',
              narration: `Reversal of journal ${original.journalNumber}: ${body.reason}`,
              reference: original.reference,
              reversesEntryId: original.id,
              idempotencyKey: key ?? null,
              // Equal and opposite: every debit becomes a credit of the same amount on the same account.
              lines: lines.map((x) => ({
                accountId: x.accountId,
                debit: x.credit,
                credit: x.debit,
                description: x.description,
                folioId: x.folioId,
              })),
            });
            await tx.update(e).set({ status: 'reversed', reversedById: reversalId }).where(eq(e.id, id));
            await this.audit.record(
              tx,
              {
                tenantId: auth.tenantId,
                propertyId: original.propertyId,
                actor: { type: 'user', userId: auth.userId },
                action: 'journal.reversed',
                entityType: 'journal_entry',
                entityId: id,
                changes: { journalNumber: original.journalNumber, reversalId },
                reason: body.reason,
              },
              meta,
            );
            return { status: 200, body: await this.load(tx, reversalId) };
          },
        ),
      ),
    );
  }

  // ------------------------------------------------------------------------------------------- internals

  private async lockDraft(tx: Tx, id: string) {
    const [entry] = await tx.select().from(e).where(eq(e.id, id)).for('update');
    if (!entry) throw AppError.notFound('journal entry');
    if (entry.status !== 'draft') {
      throw new AppError('CONFLICT', 'Posted journal entries cannot be changed. Reverse the entry instead.');
    }
    if (entry.sourceType !== 'manual')
      throw new AppError('CONFLICT', 'Only manual drafts can be changed here.');
    return entry;
  }

  /** Accounts must exist in this tenant (RLS hides others) and be active. */
  private async assertAccounts(tx: Tx, body: JournalDraftRequest) {
    const ids = [...new Set(body.lines.map((x) => x.accountId))];
    const found = await tx
      .select({ id: schema.accounts.id, code: schema.accounts.code, active: schema.accounts.active })
      .from(schema.accounts);
    const byId = new Map(found.map((a) => [a.id, a]));
    const issues = body.lines.flatMap((line, i) => {
      const a = byId.get(line.accountId);
      if (!a)
        return [{ path: `lines.${i}.accountId`, message: 'Choose an account from the chart of accounts.' }];
      if (!a.active) return [{ path: `lines.${i}.accountId`, message: `Account ${a.code} is inactive.` }];
      return [];
    });
    if (issues.length > 0 || ids.some((id) => !byId.has(id))) {
      throw AppError.validation('Some lines use accounts that cannot be posted to.', issues);
    }
    const [property] = await tx
      .select({ id: schema.properties.id })
      .from(schema.properties)
      .where(eq(schema.properties.id, body.propertyId));
    if (!property) throw AppError.notFound('property');
  }

  private async record(
    tx: Tx,
    auth: AuthContext,
    meta: RequestMeta,
    action: string,
    id: string,
    propertyId: string,
    changes: Record<string, unknown> = {},
  ) {
    await this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId,
        actor: { type: 'user', userId: auth.userId },
        action,
        entityType: 'journal_entry',
        entityId: id,
        changes,
      },
      meta,
    );
  }

  private async load(tx: Tx, id: string): Promise<JournalEntryDto> {
    const [head] = await this.heads(tx, eq(e.id, id), 1, 0);
    if (!head) throw AppError.notFound('journal entry');
    const lines = await tx
      .select({ line: l, code: schema.accounts.code, name: schema.accounts.name })
      .from(l)
      .innerJoin(schema.accounts, eq(schema.accounts.id, l.accountId))
      .where(eq(l.journalEntryId, id))
      .orderBy(asc(l.lineNo));
    return {
      ...head,
      lines: lines.map(({ line, code, name }): JournalLineDto => ({
        id: line.id,
        lineNo: line.lineNo,
        accountId: line.accountId,
        accountCode: code,
        accountName: name,
        debit: money(line.debit),
        credit: money(line.credit),
        description: line.description,
      })),
    };
  }

  private async heads(tx: Tx, where: SQL | undefined, limit: number, offset: number): Promise<Head[]> {
    const rows = await tx
      .select({
        e,
        createdByName: creator.fullName,
        postedByName: poster.fullName,
        reversesNumber: reverses.journalNumber,
        reversedByNumber: reversedBy.journalNumber,
      })
      .from(e)
      .leftJoin(creator, eq(creator.id, e.createdBy))
      .leftJoin(poster, eq(poster.id, e.postedBy))
      .leftJoin(reverses, eq(reverses.id, e.reversesEntryId))
      .leftJoin(reversedBy, eq(reversedBy.id, e.reversedById))
      .where(where)
      .orderBy(desc(e.accountingDate), desc(e.journalNumber), desc(e.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.map((r) => ({
      id: r.e.id,
      propertyId: r.e.propertyId,
      journalNumber: r.e.journalNumber,
      status: r.e.status as Head['status'],
      accountingDate: r.e.accountingDate,
      currencyCode: r.e.currencyCode,
      sourceType: r.e.sourceType,
      sourceId: r.e.sourceId,
      reference: r.e.reference,
      narration: r.e.narration,
      totalDebit: money(r.e.totalDebit),
      totalCredit: money(r.e.totalCredit),
      reversesEntryId: r.e.reversesEntryId,
      reversesNumber: r.reversesNumber,
      reversedById: r.e.reversedById,
      reversedByNumber: r.reversedByNumber,
      createdByName: r.createdByName,
      createdAt: r.e.createdAt.toISOString(),
      postedByName: r.postedByName,
      postedAt: r.e.postedAt?.toISOString() ?? null,
    }));
  }
}

/**
 * NUMERIC(19,4) from the database → the 2-decimal API form. Ledger amounts are whole paisa (the database checks),
 * so the dropped digits are always zeros.
 */
export function money(value: string): string {
  return value.replace(/^(-?\d+)\.(\d{2})\d*$/, '$1.$2');
}
