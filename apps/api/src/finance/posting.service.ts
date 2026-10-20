import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { and, asc, eq, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error';
import { pgErrorHint } from '../common/pg-error';
import type { AuthContext } from '../common/request';

const e = schema.journalEntries;
const l = schema.journalLines;
const periods = schema.fiscalPeriods;

export interface PostingLine {
  accountId: string;
  /** Decimal strings, at most 2 decimal places. Exactly one side is non-zero. */
  debit: string;
  credit: string;
  description?: string | null;
  /** Set on guest receivable lines, so every folio can be reconciled to the ledger. */
  folioId?: string | null;
}

export interface PostingRequest {
  propertyId: string;
  /** Defaults to the property's business date; never later than it. */
  accountingDate?: string;
  sourceType: string;
  sourceId?: string | null;
  purpose?: string;
  narration: string;
  reference?: string | null;
  lines: PostingLine[];
  idempotencyKey?: string | null;
  reversesEntryId?: string | null;
}

/** First and last day of the calendar month containing `date` (YYYY-MM-DD). */
export function monthOf(date: string): { start: string; end: string; month: string } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, '0')}`, month: `${y}-${mm}` };
}

/**
 * The only way money reaches the ledger. Builds and posts journal entries inside the caller's tenant transaction,
 * so a source record and its journal commit or roll back together (P3-1). The database re-checks every rule at
 * commit (balance, period, immutability); this service checks first to give clear errors.
 */
@Injectable()
export class PostingService {
  /** Creates and posts an entry in one step (system postings and reversals). Returns the entry id. */
  async post(tx: Tx, auth: AuthContext, req: PostingRequest): Promise<string> {
    const id = await this.createDraft(tx, auth, req);
    await this.postDraft(tx, auth, id);
    return id;
  }

  /** Writes a draft entry and its lines. Drafts may be unbalanced; `postDraft` checks. */
  async createDraft(tx: Tx, auth: AuthContext, req: PostingRequest): Promise<string> {
    const property = await this.property(tx, req.propertyId);
    const date = req.accountingDate ?? property.businessDate;
    this.assertDate(date, property.businessDate);
    const [row] = await tx
      .insert(e)
      .values({
        tenantId: auth.tenantId,
        propertyId: req.propertyId,
        accountingDate: date,
        currencyCode: property.currencyCode,
        sourceType: req.sourceType,
        sourceId: req.sourceId ?? null,
        purpose: req.purpose ?? 'main',
        narration: req.narration,
        reference: req.reference ?? null,
        reversesEntryId: req.reversesEntryId ?? null,
        idempotencyKey: req.idempotencyKey ?? null,
        createdBy: auth.userId,
      })
      .returning({ id: e.id });
    await this.writeLines(tx, auth, row!.id, property.currencyCode, req.lines);
    return row!.id;
  }

  /** Replaces the lines of a draft. */
  async writeLines(tx: Tx, auth: AuthContext, entryId: string, currency: string, lines: PostingLine[]) {
    await tx.delete(l).where(eq(l.journalEntryId, entryId));
    if (lines.length === 0) return;
    await tx.insert(l).values(
      lines.map((line, i) => ({
        tenantId: auth.tenantId,
        journalEntryId: entryId,
        lineNo: i + 1,
        accountId: line.accountId,
        debit: this.amount(line.debit, currency),
        credit: this.amount(line.credit, currency),
        description: line.description ?? null,
        folioId: line.folioId ?? null,
      })),
    );
  }

  /**
   * Posts a draft: checks accounts, balance and period, takes the next journal number and marks it posted.
   * Throws JOURNAL_UNBALANCED or PERIOD_CLOSED with a message a person can act on.
   */
  async postDraft(tx: Tx, auth: AuthContext, entryId: string): Promise<void> {
    const [entry] = await tx.select().from(e).where(eq(e.id, entryId)).for('update');
    if (!entry) throw AppError.notFound('journal entry');
    if (entry.status !== 'draft') throw new AppError('CONFLICT', 'This journal entry is already posted.');
    const property = await this.property(tx, entry.propertyId);
    this.assertDate(entry.accountingDate, property.businessDate);

    const lines = await tx
      .select({ line: l, account: schema.accounts })
      .from(l)
      .innerJoin(schema.accounts, eq(schema.accounts.id, l.accountId))
      .where(eq(l.journalEntryId, entryId))
      .orderBy(asc(l.lineNo));
    if (lines.length < 2) {
      throw new AppError('JOURNAL_UNBALANCED', 'A journal entry needs at least two lines.');
    }
    const inactive = lines.filter((x) => !x.account.active).map((x) => x.account.code);
    if (inactive.length > 0) {
      throw AppError.validation(
        `Account ${[...new Set(inactive)].join(', ')} is inactive. Choose an active account.`,
      );
    }

    const currency = entry.currencyCode;
    const debit = Money.sum(
      lines.map((x) => Money.fromStorage(x.line.debit, currency)),
      currency,
    );
    const credit = Money.sum(
      lines.map((x) => Money.fromStorage(x.line.credit, currency)),
      currency,
    );
    if (!debit.equals(credit) || !debit.isPositive()) {
      throw new AppError(
        'JOURNAL_UNBALANCED',
        `Debits (${debit.toString()}) and credits (${credit.toString()}) must be equal and more than zero.`,
        [{ path: 'lines', message: `Difference ${debit.subtract(credit).abs().toString()}` }],
      );
    }

    const period = await this.openPeriod(tx, auth.tenantId, entry.accountingDate);
    const number = await this.nextNumber(tx, auth.tenantId, null, 'journal');
    await tx
      .update(e)
      .set({
        status: 'posted',
        journalNumber: number,
        periodId: period.id,
        totalDebit: debit.toStorage(),
        totalCredit: credit.toStorage(),
        postedBy: auth.userId,
        postedAt: sql`now()`,
      })
      .where(eq(e.id, entryId));
  }

  /**
   * The fiscal period for `date`, created on first use and share-locked so it cannot be closed while this
   * transaction posts into it. Throws PERIOD_CLOSED for a closed month.
   */
  async openPeriod(tx: Tx, tenantId: string, date: string) {
    const period = await this.lockPeriod(tx, tenantId, date, 'share');
    if (period.status !== 'open') {
      throw new AppError(
        'PERIOD_CLOSED',
        `The accounting period ${monthOf(date).month} is closed. Post in an open period, or ask someone allowed to reopen it.`,
      );
    }
    return period;
  }

  /** Fetches (creating if needed) and locks the period containing `date`. */
  async lockPeriod(tx: Tx, tenantId: string, date: string, mode: 'share' | 'update') {
    const { start, end } = monthOf(date);
    await tx.insert(periods).values({ tenantId, startDate: start, endDate: end }).onConflictDoNothing();
    const [period] = await tx
      .select()
      .from(periods)
      .where(and(eq(periods.tenantId, tenantId), eq(periods.startDate, start)))
      .for(mode === 'share' ? 'share' : 'update');
    return period!;
  }

  /**
   * Takes the next number of a series. The counter row stays locked until commit, so numbers are unique and
   * gapless: a rolled-back transaction also rolls back its number.
   */
  async nextNumber(tx: Tx, tenantId: string, propertyId: string | null, series: string): Promise<number> {
    const s = schema.documentSequences;
    const result = await tx.execute<{ n: string }>(sql`
      insert into ${s} (tenant_id, property_id, series, next_number) values (${tenantId}, ${propertyId}, ${series}, 2)
      on conflict (tenant_id, property_id, series) do update set next_number = ${s}.next_number + 1
      returning next_number - 1 as n`);
    return Number(result.rows[0]!.n);
  }

  /** Rejects amounts finer than the currency's minor unit (D5) instead of rounding them silently. */
  private amount(value: string, currency: string): string {
    const m = Money.of(value || '0', currency);
    if (!m.round().equals(m))
      throw AppError.validation(`${value} has more decimal places than ${currency} allows.`);
    if (m.isNegative()) throw AppError.validation('Amounts cannot be negative.');
    return m.toStorage();
  }

  private assertDate(date: string, businessDate: string) {
    if (date > businessDate) {
      throw AppError.validation(
        `The accounting date ${date} is after the business date ${businessDate}. Entries cannot be dated in the future.`,
      );
    }
  }

  private async property(tx: Tx, propertyId: string) {
    const [p] = await tx
      .select({
        businessDate: schema.properties.businessDate,
        currencyCode: schema.properties.currencyCode,
      })
      .from(schema.properties)
      .where(eq(schema.properties.id, propertyId));
    if (!p) throw AppError.notFound('property');
    const [tenant] = await tx.select({ c: schema.tenants.baseCurrency }).from(schema.tenants);
    // The ledger balances in one currency (accounting spec §1). Foreign currency comes later.
    if (tenant?.c !== p.currencyCode) {
      throw AppError.validation(
        `This property uses ${p.currencyCode} but the ledger is kept in ${tenant?.c ?? 'the base currency'}.`,
      );
    }
    return p;
  }
}

/** Maps the ledger's database-level rule failures (raised at commit) to the same errors the service gives. */
export async function ledgerErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const hint = pgErrorHint(err);
    if (hint === 'JOURNAL_UNBALANCED') {
      throw new AppError('JOURNAL_UNBALANCED', 'The journal entry does not balance.');
    }
    if (hint === 'PERIOD_CLOSED') throw new AppError('PERIOD_CLOSED', 'The accounting period is closed.');
    throw err;
  }
}

/** Entry statuses that count in the ledger: a reversed entry stays, offset by its reversal. */
export const POSTED = ['posted', 'reversed'] as const;
