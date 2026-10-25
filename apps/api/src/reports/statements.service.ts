import { Injectable } from '@nestjs/common';
import type {
  BalanceSheetDto,
  BalanceSheetQuery,
  BsSection,
  PlSection,
  ProfitLossDto,
  ProfitLossQuery,
  TrialBalanceDto,
  TrialBalanceQuery,
} from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { sql } from 'drizzle-orm';
import type { AuthContext } from '../common/request';
import { Db } from '../db/db.module';
import { ReportsService } from '../finance/reports.service';
import {
  addDays,
  daysBetween,
  ledgerCurrency,
  notYearEndClose,
  previousYear,
  propertyFilter,
  reportScope,
  reportTimezone,
} from './report-scope';

const PL_DEFINITIONS = {
  revenue:
    'Posted revenue for the dates, including room nights accrued by the night audit. Not cash received.',
  cost_of_sales: 'Direct costs of what was sold (food and beverage, guest supplies).',
  operating_expense: 'Running costs of the hotel posted for the dates.',
  other: 'Interest, finance costs, disposals and rounding; income positive.',
  grossProfit: 'Revenue minus cost of sales.',
  operatingProfit: 'Gross profit minus operating expenses.',
  netProfit: 'Operating profit plus other income and expense. Year-end closing entries are left out.',
};

const BS_DEFINITIONS = {
  totalAssets: 'Balances of asset accounts on the date (debit balances positive).',
  totalLiabilities: 'Balances of liability accounts on the date (credit balances positive).',
  currentYearResult:
    'Profit or loss of the calendar year up to the date, not yet moved to retained earnings.',
  earlierYearsResult: 'Profit or loss of earlier years whose year-end close has not been run.',
  totalEquity: 'Equity accounts plus both results.',
  difference: 'Assets minus liabilities and equity; zero whenever the ledger balances.',
};

const PL_CLASSES: Record<string, PlSection> = {
  revenue: 'revenue',
  cost_of_sales: 'cost_of_sales',
  expense: 'operating_expense',
  other: 'other',
};

/**
 * The financial statements (P5-5, P5-6), read only from posted journal lines; drafts never count and nothing is
 * stored, so the same filters on the same ledger always give the same figures.
 */
@Injectable()
export class StatementsService {
  constructor(
    private readonly db: Db,
    private readonly ledger: ReportsService,
  ) {}

  /** FIN-006 under the report permission, for one property or (tenant-wide roles) all of them. */
  trialBalance(auth: AuthContext, q: TrialBalanceQuery): Promise<TrialBalanceDto> {
    reportScope(auth, 'report.financial', q.propertyId);
    return this.ledger.trialBalance(auth, q);
  }

  profitLoss(auth: AuthContext, q: ProfitLossQuery): Promise<ProfitLossDto> {
    const { propertyId } = reportScope(auth, 'report.financial', q.propertyId);
    const cmp = comparisonRange(q);
    return this.db.tenant(auth.tenantId, async (tx) => {
      // Without a comparison the comparison sums cover an empty range and are ignored.
      const cFrom = cmp?.from ?? '9999-12-31';
      const cTo = cmp?.to ?? '0001-01-01';
      const { rows } = await tx.execute<{
        id: string;
        code: string;
        name: string;
        account_class: string;
        cur: string;
        cmp: string;
      }>(sql`
        select a.id, a.code, a.name, a.account_class,
               coalesce(sum(m.credit - m.debit) filter (where m.d between ${q.from}::date and ${q.to}::date), 0)::text as cur,
               coalesce(sum(m.credit - m.debit) filter (where m.d between ${cFrom}::date and ${cTo}::date), 0)::text as cmp
        from accounts a
        left join (
          select l.account_id, l.debit, l.credit, e.accounting_date as d
          from journal_lines l join journal_entries e on e.id = l.journal_entry_id
          where e.status <> 'draft' and ${notYearEndClose} ${propertyFilter(propertyId)}
            and (e.accounting_date between ${q.from}::date and ${q.to}::date
                 or e.accounting_date between ${cFrom}::date and ${cTo}::date)
        ) m on m.account_id = a.id
        where a.account_class in ('revenue', 'cost_of_sales', 'expense', 'other')
        group by a.id
        order by a.code`);

      const currency = await ledgerCurrency(tx);
      const zero = Money.zero(currency);
      const fig = (cur: Money, c: Money) => ({
        amount: cur.round().toString(),
        comparison: cmp ? c.round().toString() : null,
      });
      const sections = new Map<
        PlSection,
        { rows: ProfitLossDto['sections'][number]['rows']; cur: Money; cmp: Money }
      >(
        (['revenue', 'cost_of_sales', 'operating_expense', 'other'] as const).map((k) => [
          k,
          { rows: [], cur: zero, cmp: zero },
        ]),
      );
      for (const r of rows) {
        const key = PL_CLASSES[r.account_class]!;
        // Credits minus debits; costs and expenses are shown as positive amounts.
        const sign = key === 'cost_of_sales' || key === 'operating_expense' ? -1 : 1;
        let cur = Money.fromStorage(r.cur, currency);
        let c = Money.fromStorage(r.cmp, currency);
        if (sign < 0) {
          cur = cur.negate();
          c = c.negate();
        }
        if (cur.isZero() && (!cmp || c.isZero())) continue;
        const s = sections.get(key)!;
        s.cur = s.cur.add(cur);
        s.cmp = s.cmp.add(c);
        s.rows.push({ accountId: r.id, code: r.code, name: r.name, ...fig(cur, c) });
      }
      const t = (k: PlSection) => sections.get(k)!;
      const gross = [
        t('revenue').cur.subtract(t('cost_of_sales').cur),
        t('revenue').cmp.subtract(t('cost_of_sales').cmp),
      ] as const;
      const operating = [
        gross[0].subtract(t('operating_expense').cur),
        gross[1].subtract(t('operating_expense').cmp),
      ] as const;
      const net = [operating[0].add(t('other').cur), operating[1].add(t('other').cmp)] as const;

      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: PL_DEFINITIONS,
        from: q.from,
        to: q.to,
        compare: q.compare,
        comparisonFrom: cmp?.from ?? null,
        comparisonTo: cmp?.to ?? null,
        sections: [...sections].map(([key, s]) => ({ key, rows: s.rows, total: fig(s.cur, s.cmp) })),
        grossProfit: fig(...gross),
        operatingProfit: fig(...operating),
        netProfit: fig(...net),
      };
    });
  }

  balanceSheet(auth: AuthContext, q: BalanceSheetQuery): Promise<BalanceSheetDto> {
    const { propertyId } = reportScope(auth, 'report.financial', q.propertyId);
    // D10: the fiscal year is the calendar year.
    const yearStart = `${q.asOf.slice(0, 4)}-01-01`;
    return this.db.tenant(auth.tenantId, async (tx) => {
      const { rows } = await tx.execute<{
        id: string;
        code: string;
        name: string;
        account_class: string;
        report_group: string;
        balance: string;
        this_year: string;
      }>(sql`
        select a.id, a.code, a.name, a.account_class, a.report_group,
               coalesce(sum(m.debit - m.credit), 0)::text as balance,
               coalesce(sum(m.debit - m.credit) filter (where m.d >= ${yearStart}::date), 0)::text as this_year
        from accounts a
        left join (
          select l.account_id, l.debit, l.credit, e.accounting_date as d
          from journal_lines l join journal_entries e on e.id = l.journal_entry_id
          where e.status <> 'draft' and e.accounting_date <= ${q.asOf}::date ${propertyFilter(propertyId)}
        ) m on m.account_id = a.id
        group by a.id
        order by a.code`);

      const currency = await ledgerCurrency(tx);
      const zero = Money.zero(currency);
      const sections = new Map<
        BsSection,
        { rows: BalanceSheetDto['sections'][number]['rows']; total: Money }
      >(
        (
          [
            'current_asset',
            'non_current_asset',
            'current_liability',
            'non_current_liability',
            'equity',
          ] as const
        ).map((k) => [k, { rows: [], total: zero }]),
      );
      // What is left on revenue, cost and expense accounts is the result not yet closed to retained earnings.
      let currentYear = zero;
      let earlierYears = zero;
      for (const r of rows) {
        const balance = Money.fromStorage(r.balance, currency);
        if (!['asset', 'liability', 'equity'].includes(r.account_class)) {
          const thisYear = Money.fromStorage(r.this_year, currency);
          currentYear = currentYear.subtract(thisYear);
          earlierYears = earlierYears.subtract(balance.subtract(thisYear));
          continue;
        }
        if (balance.isZero()) continue;
        // Assets are shown as debit balances, liabilities and equity as credit balances.
        const amount = r.account_class === 'asset' ? balance : balance.negate();
        const s = sections.get(r.report_group as BsSection)!;
        s.total = s.total.add(amount);
        s.rows.push({ accountId: r.id, code: r.code, name: r.name, amount: amount.round().toString() });
      }
      const total = (k: BsSection) => sections.get(k)!.total;
      const assets = total('current_asset').add(total('non_current_asset'));
      const liabilities = total('current_liability').add(total('non_current_liability'));
      const equity = total('equity').add(currentYear).add(earlierYears);
      const difference = assets.subtract(liabilities).subtract(equity);
      const s = (m: Money) => m.round().toString();

      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: BS_DEFINITIONS,
        asOf: q.asOf,
        sections: [...sections].map(([key, v]) => ({ key, rows: v.rows, total: s(v.total) })),
        currentYearResult: s(currentYear),
        earlierYearsResult: s(earlierYears),
        totalAssets: s(assets),
        totalLiabilities: s(liabilities),
        totalEquity: s(equity),
        totalLiabilitiesAndEquity: s(liabilities.add(equity)),
        difference: s(difference),
        balanced: difference.round().isZero(),
      };
    });
  }
}

/** The comparison column: the same number of days just before, or the same dates a year earlier. */
export function comparisonRange(q: Pick<ProfitLossQuery, 'from' | 'to' | 'compare'>) {
  if (q.compare === 'previous_period') {
    const days = daysBetween(q.from, q.to) + 1;
    return { from: addDays(q.from, -days), to: addDays(q.from, -1) };
  }
  if (q.compare === 'previous_year') return { from: previousYear(q.from), to: previousYear(q.to) };
  return null;
}
