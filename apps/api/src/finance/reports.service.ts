import { Injectable } from '@nestjs/common';
import type {
  AccountClass,
  LedgerDto,
  LedgerQuery,
  TrialBalanceDto,
  TrialBalanceQuery,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { Money } from '@innpilot/money';
import { eq, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error';
import type { AuthContext } from '../common/request';
import { Db } from '../db/db.module';
import { accountDto } from './accounts.service';

/**
 * Ledger views computed only from posted entries (reversed entries stay, offset by their reversals); drafts never
 * count. All sums are done by Postgres NUMERIC, so the same filters on the same ledger always give the same totals.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly db: Db) {}

  ledger(auth: AuthContext, q: LedgerQuery): Promise<LedgerDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [account] = await tx.select().from(schema.accounts).where(eq(schema.accounts.id, q.accountId));
      if (!account) throw AppError.notFound('account');
      const property = q.propertyId ? sql`and e.property_id = ${q.propertyId}` : sql``;
      const opening = await tx.execute<{ b: string }>(sql`
        select coalesce(sum(l.debit - l.credit), 0)::text as b
        from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        where l.account_id = ${q.accountId} and e.status <> 'draft' and e.accounting_date < ${q.from}::date ${property}`);
      const rows = await tx.execute<{
        entry_id: string;
        journal_number: string;
        accounting_date: string;
        narration: string;
        reference: string | null;
        source_type: string;
        debit: string;
        credit: string;
      }>(sql`
        select e.id as entry_id, e.journal_number, e.accounting_date::text, e.narration, e.reference, e.source_type,
               l.debit::text, l.credit::text
        from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        where l.account_id = ${q.accountId} and e.status <> 'draft'
          and e.accounting_date between ${q.from}::date and ${q.to}::date ${property}
        order by e.accounting_date, e.journal_number, l.line_no`);

      const currency = await this.currency(tx);
      let balance = Money.fromStorage(opening.rows[0]!.b, currency);
      const openingBalance = balance;
      let dr = Money.zero(currency);
      let cr = Money.zero(currency);
      const lines = rows.rows.map((r) => {
        const d = Money.fromStorage(r.debit, currency);
        const c = Money.fromStorage(r.credit, currency);
        dr = dr.add(d);
        cr = cr.add(c);
        balance = balance.add(d).subtract(c);
        return {
          entryId: r.entry_id,
          journalNumber: Number(r.journal_number),
          accountingDate: r.accounting_date,
          narration: r.narration,
          reference: r.reference,
          sourceType: r.source_type,
          debit: d.round().toString(),
          credit: c.round().toString(),
          balance: balance.round().toString(),
        };
      });
      return {
        account: accountDto(account),
        from: q.from,
        to: q.to,
        openingBalance: openingBalance.round().toString(),
        totalDebit: dr.round().toString(),
        totalCredit: cr.round().toString(),
        closingBalance: balance.round().toString(),
        lines,
      };
    });
  }

  /** The ledger is kept in the tenant's base currency. */
  private async currency(tx: Tx): Promise<string> {
    const [tenant] = await tx.select({ c: schema.tenants.baseCurrency }).from(schema.tenants);
    if (!tenant) throw AppError.notFound('tenant');
    return tenant.c;
  }

  /** FIN-006: every account, active or not, with opening, movement and closing; debits must equal credits. */
  trialBalance(auth: AuthContext, q: TrialBalanceQuery): Promise<TrialBalanceDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const property = q.propertyId ? sql`and e.property_id = ${q.propertyId}` : sql``;
      const { rows } = await tx.execute<{
        id: string;
        code: string;
        name: string;
        account_class: string;
        active: boolean;
        opening: string;
        debit: string;
        credit: string;
      }>(sql`
        select a.id, a.code, a.name, a.account_class, a.active,
               coalesce(sum(m.debit - m.credit) filter (where m.accounting_date < ${q.from}::date), 0)::text as opening,
               coalesce(sum(m.debit) filter (where m.accounting_date >= ${q.from}::date), 0)::text as debit,
               coalesce(sum(m.credit) filter (where m.accounting_date >= ${q.from}::date), 0)::text as credit
        from accounts a
        left join (
          select l.account_id, l.debit, l.credit, e.accounting_date
          from journal_lines l join journal_entries e on e.id = l.journal_entry_id
          where e.status <> 'draft' and e.accounting_date <= ${q.to}::date ${property}
        ) m on m.account_id = a.id
        group by a.id
        order by a.code`);
      const currency = await this.currency(tx);
      const zero = Money.zero(currency);
      const totals = {
        openingDebit: zero,
        openingCredit: zero,
        debit: zero,
        credit: zero,
        closingDebit: zero,
        closingCredit: zero,
      };
      const out = rows.map((r) => {
        const opening = Money.fromStorage(r.opening, currency);
        const debit = Money.fromStorage(r.debit, currency);
        const credit = Money.fromStorage(r.credit, currency);
        const closing = opening.add(debit).subtract(credit);
        const amounts = {
          openingDebit: opening.isPositive() ? opening : zero,
          openingCredit: opening.isNegative() ? opening.negate() : zero,
          debit,
          credit,
          closingDebit: closing.isPositive() ? closing : zero,
          closingCredit: closing.isNegative() ? closing.negate() : zero,
        };
        for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] = totals[k].add(amounts[k]);
        return {
          accountId: r.id,
          code: r.code,
          name: r.name,
          accountClass: r.account_class as AccountClass,
          active: r.active,
          ...str(amounts),
        };
      });
      return {
        from: q.from,
        to: q.to,
        currencyCode: currency,
        rows: out,
        totals: str(totals),
        balanced:
          totals.openingDebit.equals(totals.openingCredit) &&
          totals.debit.equals(totals.credit) &&
          totals.closingDebit.equals(totals.closingCredit),
      };
    });
  }
}

function str<K extends string>(m: Record<K, Money>): Record<K, string> {
  return Object.fromEntries(Object.entries<Money>(m).map(([k, v]) => [k, v.round().toString()])) as Record<
    K,
    string
  >;
}
