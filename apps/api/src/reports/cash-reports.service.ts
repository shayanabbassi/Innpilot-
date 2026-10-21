import { Injectable } from '@nestjs/common';
import type {
  CashbookDto,
  CashbookQuery,
  CashFlowDto,
  CashFlowLine,
  CashFlowQuery,
  RevenueDto,
  RevenueQuery,
  TaxSummaryDto,
  TaxSummaryQuery,
} from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { sql } from 'drizzle-orm';
import type { AuthContext } from '../common/request';
import { Db } from '../db/db.module';
import { ledgerCurrency, notYearEndClose, propertyFilter, reportScope, reportTimezone } from './report-scope';

type Kind = CashbookDto['accounts'][number]['kind'];

const CASHBOOK_DEFINITIONS = {
  receipts: 'Money into the drawer, bank or card clearing account (debits on its ledger lines).',
  payments: 'Money out of it (credits), including transfers to another of the hotel’s accounts.',
  closing: 'Opening + receipts − payments.',
  controls:
    'The drawers and banks on each ledger account against that account’s balance; a difference is shown, never adjusted.',
};

const CASH_FLOW_DEFINITIONS = {
  method:
    'Direct method: each movement on a drawer, bank or card clearing account is classified by the other side of its journal.',
  receipts_from_guests: 'Guest payments against bills and cash sales, less refunds.',
  guest_deposits: 'Advance deposits received, less deposits refunded.',
  payments_to_suppliers: 'Supplier bills paid.',
  operating_expenses: 'Expenses paid in cash, bank charges, cash over and short.',
  taxes: 'Tax paid or refunded through tax accounts.',
  other_operating: 'Other current items (interest, payroll, advances).',
  fixed_assets: 'Furniture, equipment and other non-current assets bought or sold.',
  loans: 'Loans received or repaid.',
  owner_equity: 'Owner capital paid in or withdrawn.',
  opening_balances:
    'Cash entered as an opening balance at go-live: a starting position, not a movement of the period.',
  transfers: 'Between the hotel’s own drawers, banks and card clearing; neither in nor out.',
};

const TAX_DEFINITIONS = {
  rows: 'Tax charged on guest bills, from the rate and base kept with each charge when it was posted; voids are taken off on the void date.',
  otherPostings: 'Other postings to the tax account: payments to the tax authority and adjustments.',
  recoverable: 'Purchase tax marked recoverable on expenses (account 1300).',
  note: 'A summary for the hotel’s records, not a tax return.',
};

const REVENUE_DEFINITIONS = {
  revenue:
    'Posted revenue by account and accounting date, including nights accrued by the night audit. Matches the P&L.',
  receipts:
    'Money received from guests by payment method on its business date. Cash received is not revenue.',
};

/**
 * Cashbook, cash flow, tax and revenue summaries (slice 5.2), read from posted journal lines and the source
 * records they carry; nothing is stored.
 */
@Injectable()
export class CashReportsService {
  constructor(private readonly db: Db) {}

  cashbook(auth: AuthContext, q: CashbookQuery): Promise<CashbookDto> {
    const { propertyId } = reportScope(auth, 'report.financial', q.propertyId);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const currency = await ledgerCurrency(tx);
      const m = (v: string | null | undefined) => Money.fromStorage(v ?? '0', currency);
      const s = (v: Money) => v.round().toString();
      const accounts = await tx.execute<{
        id: string;
        property_id: string;
        name: string;
        kind: Kind;
        active: boolean;
        ledger_account_id: string;
        code: string;
        opening: string;
      }>(sql`
        select c.id, c.property_id, c.name, c.kind, c.active, c.ledger_account_id, a.code,
               coalesce((select sum(l.debit - l.credit) from journal_lines l
                         join journal_entries e on e.id = l.journal_entry_id
                         where l.cash_account_id = c.id and e.status <> 'draft'
                           and e.accounting_date < ${q.from}::date), 0)::text as opening
        from cash_accounts c join accounts a on a.id = c.ledger_account_id
        where true ${propertyId ? sql`and c.property_id = ${propertyId}` : sql``}
          ${q.kind ? sql`and c.kind = ${q.kind}` : sql``}
        order by c.kind, c.name`);
      const days = await tx.execute<{ id: string; d: string; dr: string; cr: string }>(sql`
        select l.cash_account_id as id, e.accounting_date::text as d, sum(l.debit)::text as dr, sum(l.credit)::text as cr
        from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        where l.cash_account_id is not null and e.status <> 'draft'
          and e.accounting_date between ${q.from}::date and ${q.to}::date ${propertyFilter(propertyId)}
        group by 1, 2
        order by 2`);
      const byAccount = new Map<string, typeof days.rows>();
      for (const r of days.rows) byAccount.set(r.id, [...(byAccount.get(r.id) ?? []), r]);

      const zero = Money.zero(currency);
      const totals = { opening: zero, receipts: zero, payments: zero, closing: zero };
      const rows = accounts.rows.map((c) => {
        let balance = m(c.opening);
        let receipts = zero;
        let payments = zero;
        const list = (byAccount.get(c.id) ?? []).map((d) => {
          receipts = receipts.add(m(d.dr));
          payments = payments.add(m(d.cr));
          balance = balance.add(m(d.dr)).subtract(m(d.cr));
          return { date: d.d, receipts: s(m(d.dr)), payments: s(m(d.cr)), closing: s(balance) };
        });
        totals.opening = totals.opening.add(m(c.opening));
        totals.receipts = totals.receipts.add(receipts);
        totals.payments = totals.payments.add(payments);
        totals.closing = totals.closing.add(balance);
        return {
          cashAccountId: c.id,
          propertyId: c.property_id,
          name: c.name,
          kind: c.kind,
          active: c.active,
          ledgerAccountCode: c.code,
          opening: s(m(c.opening)),
          receipts: s(receipts),
          payments: s(payments),
          closing: s(balance),
          days: list,
        };
      });

      // Control check: the tagged lines against everything on each ledger account the shown drawers use.
      const ledgerIds = [...new Set(accounts.rows.map((c) => c.ledger_account_id))];
      const controls =
        ledgerIds.length === 0
          ? []
          : (
              await tx.execute<{
                id: string;
                code: string;
                name: string;
                ledger: string;
                tagged: string;
              }>(sql`
            select a.id, a.code, a.name,
                   coalesce(sum(x.debit - x.credit), 0)::text as ledger,
                   coalesce(sum(x.debit - x.credit) filter (where x.cash_account_id is not null), 0)::text as tagged
            from accounts a
            left join (
              select l.account_id, l.debit, l.credit, l.cash_account_id
              from journal_lines l join journal_entries e on e.id = l.journal_entry_id
              where e.status <> 'draft' and e.accounting_date <= ${q.to}::date ${propertyFilter(propertyId)}
            ) x on x.account_id = a.id
            where a.id in (${sql.join(
              ledgerIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})
            group by a.id
            order by a.code`)
            ).rows.map((r) => ({
              accountId: r.id,
              code: r.code,
              name: r.name,
              cashAccountsTotal: s(m(r.tagged)),
              ledgerBalance: s(m(r.ledger)),
              difference: s(m(r.ledger).subtract(m(r.tagged))),
            }));

      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: CASHBOOK_DEFINITIONS,
        from: q.from,
        to: q.to,
        accounts: rows,
        totals: {
          opening: s(totals.opening),
          receipts: s(totals.receipts),
          payments: s(totals.payments),
          closing: s(totals.closing),
        },
        controls,
        reconciled: controls.every((c) => !/[1-9]/.test(c.difference)),
      };
    });
  }

  cashFlow(auth: AuthContext, q: CashFlowQuery): Promise<CashFlowDto> {
    const { propertyId } = reportScope(auth, 'report.financial', q.propertyId);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const currency = await ledgerCurrency(tx);
      const m = (v: string | null | undefined) => Money.fromStorage(v ?? '0', currency);
      const s = (v: Money) => v.round().toString();
      const cash = await tx.execute<{ opening: string; closing: string }>(sql`
        select coalesce(sum(l.debit - l.credit) filter (where e.accounting_date < ${q.from}::date), 0)::text as opening,
               coalesce(sum(l.debit - l.credit), 0)::text as closing
        from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        where l.cash_account_id is not null and e.status <> 'draft'
          and e.accounting_date <= ${q.to}::date ${propertyFilter(propertyId)}`);
      // Journals in the range that move a drawer, bank or card clearing account.
      const moving = sql`
        select e.id from journal_entries e
        where e.status <> 'draft' and e.accounting_date between ${q.from}::date and ${q.to}::date
          ${propertyFilter(propertyId)}
          and exists (select 1 from journal_lines c where c.journal_entry_id = e.id and c.cash_account_id is not null)`;
      // The other side of each such journal, line by line: its credit is cash in, its debit cash out.
      const sides = await tx.execute<{
        account_class: string;
        report_group: string;
        system_role: string | null;
        is_tax: boolean;
        opening: boolean;
        inflow: string;
        outflow: string;
      }>(sql`
        select a.account_class, a.report_group, a.system_role,
               exists (select 1 from tax_codes t where t.payable_account_id = a.id) as is_tax,
               e.source_type = 'opening_balance' as opening,
               coalesce(sum(greatest(l.credit - l.debit, 0)), 0)::text as inflow,
               coalesce(sum(greatest(l.debit - l.credit, 0)), 0)::text as outflow
        from journal_lines l join accounts a on a.id = l.account_id
        join journal_entries e on e.id = l.journal_entry_id
        where l.cash_account_id is null and l.journal_entry_id in (${moving})
        group by a.id, e.source_type = 'opening_balance'`);
      // Within one journal, money that leaves one of the hotel's accounts for another is a transfer.
      const transfers = await tx.execute<{ t: string }>(sql`
        select coalesce(sum(least(x.dr, x.cr)), 0)::text as t
        from (
          select l.journal_entry_id, sum(l.debit) as dr, sum(l.credit) as cr
          from journal_lines l
          where l.cash_account_id is not null and l.journal_entry_id in (${moving})
          group by 1
        ) x`);

      const zero = Money.zero(currency);
      const lines = new Map<CashFlowLine, { inflow: Money; outflow: Money }>();
      for (const r of sides.rows) {
        // Cash entered at go-live is a starting position, whatever account it was balanced against.
        const key = r.opening ? 'opening_balances' : classify(r);
        const cur = lines.get(key) ?? { inflow: zero, outflow: zero };
        lines.set(key, { inflow: cur.inflow.add(m(r.inflow)), outflow: cur.outflow.add(m(r.outflow)) });
      }
      const layout: [CashFlowDto['sections'][number]['key'], CashFlowLine[]][] = [
        [
          'operating',
          [
            'receipts_from_guests',
            'guest_deposits',
            'payments_to_suppliers',
            'operating_expenses',
            'taxes',
            'other_operating',
          ],
        ],
        ['investing', ['fixed_assets']],
        ['financing', ['loans', 'owner_equity', 'opening_balances']],
      ];
      let netChange = zero;
      const sections = layout.map(([key, keys]) => {
        let net = zero;
        const out = keys.map((k) => {
          const v = lines.get(k) ?? { inflow: zero, outflow: zero };
          const n = v.inflow.subtract(v.outflow);
          net = net.add(n);
          return { key: k, inflow: s(v.inflow), outflow: s(v.outflow), net: s(n) };
        });
        netChange = netChange.add(net);
        return { key, lines: out, net: s(net) };
      });
      const opening = m(cash.rows[0]!.opening);
      const closing = m(cash.rows[0]!.closing);

      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: CASH_FLOW_DEFINITIONS,
        from: q.from,
        to: q.to,
        openingCash: s(opening),
        sections,
        netChange: s(netChange),
        closingCash: s(closing),
        transfers: s(m(transfers.rows[0]!.t)),
        reconciles: opening.add(netChange).round().equals(closing.round()),
      };
    });
  }

  taxSummary(auth: AuthContext, q: TaxSummaryQuery): Promise<TaxSummaryDto> {
    const { propertyId } = reportScope(auth, 'report.financial', q.propertyId);
    const onProperty = (col: string) => (propertyId ? sql`and ${sql.raw(col)} = ${propertyId}` : sql``);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const currency = await ledgerCurrency(tx);
      const m = (v: string | null | undefined) => Money.fromStorage(v ?? '0', currency);
      const s = (v: Money) => v.round().toString();
      // A charge counts on the date it was posted; a void takes it off on the void date. Transfers between folios
      // copy the snapshot but post no tax, so only the first charge of a chain counts.
      const rows = await tx.execute<{
        code: string;
        name: string;
        rate: string;
        inclusive: boolean;
        account_code: string;
        base: string;
        tax: string;
      }>(sql`
        select x.code, x.name, x.rate_percent::text as rate, x.inclusive, a.code as account_code,
               sum(x.base)::text as base, sum(x.tax)::text as tax
        from (
          select t.code, t.name, t.rate_percent, t.inclusive, t.payable_account_id, t.base_amount as base, t.tax_amount as tax
          from folio_charge_taxes t
          join folio_charges c on c.id = t.charge_id
          join journal_entries e on e.id = c.journal_entry_id
          where c.transferred_from_id is null and e.status <> 'draft'
            and e.accounting_date between ${q.from}::date and ${q.to}::date ${onProperty('c.property_id')}
          union all
          select t.code, t.name, t.rate_percent, t.inclusive, t.payable_account_id, -t.base_amount, -t.tax_amount
          from folio_charge_taxes t
          join folio_charges c on c.id = t.charge_id
          join journal_entries e on e.id = c.void_journal_entry_id
          where c.status = 'voided' and e.status <> 'draft'
            and e.accounting_date between ${q.from}::date and ${q.to}::date ${onProperty('c.property_id')}
        ) x join accounts a on a.id = x.payable_account_id
        group by x.code, x.name, x.rate_percent, x.inclusive, a.code
        order by x.code, x.rate_percent`);
      const charged = await tx.execute<{ account_id: string; tax: string }>(sql`
        select x.payable_account_id as account_id, sum(x.tax)::text as tax
        from (
          select t.payable_account_id, t.tax_amount as tax
          from folio_charge_taxes t join folio_charges c on c.id = t.charge_id
          join journal_entries e on e.id = c.journal_entry_id
          where c.transferred_from_id is null and e.status <> 'draft'
            and e.accounting_date between ${q.from}::date and ${q.to}::date ${onProperty('c.property_id')}
          union all
          select t.payable_account_id, -t.tax_amount
          from folio_charge_taxes t join folio_charges c on c.id = t.charge_id
          join journal_entries e on e.id = c.void_journal_entry_id
          where c.status = 'voided' and e.status <> 'draft'
            and e.accounting_date between ${q.from}::date and ${q.to}::date ${onProperty('c.property_id')}
        ) x group by 1`);
      const accounts = await tx.execute<{
        id: string;
        code: string;
        name: string;
        movement: string;
        closing: string;
      }>(sql`
        select a.id, a.code, a.name,
               coalesce(sum(x.credit - x.debit) filter (where x.d >= ${q.from}::date), 0)::text as movement,
               coalesce(sum(x.credit - x.debit), 0)::text as closing
        from accounts a
        left join (
          select l.account_id, l.debit, l.credit, e.accounting_date as d
          from journal_lines l join journal_entries e on e.id = l.journal_entry_id
          where e.status <> 'draft' and e.accounting_date <= ${q.to}::date ${propertyFilter(propertyId)}
        ) x on x.account_id = a.id
        where a.id in (select payable_account_id from tax_codes where true ${onProperty('property_id')})
        group by a.id
        order by a.code`);
      const recoverable = await tx.execute<{ r: string }>(sql`
        select coalesce(sum(l.debit - l.credit), 0)::text as r
        from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        join accounts a on a.id = l.account_id
        where a.system_role = 'tax_recoverable' and e.status <> 'draft'
          and e.accounting_date between ${q.from}::date and ${q.to}::date ${propertyFilter(propertyId)}`);

      const chargedBy = new Map(charged.rows.map((r) => [r.account_id, m(r.tax)]));
      const zero = Money.zero(currency);
      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: TAX_DEFINITIONS,
        from: q.from,
        to: q.to,
        rows: rows.rows.map((r) => ({
          code: r.code,
          name: r.name,
          ratePercent: r.rate,
          inclusive: r.inclusive,
          accountCode: r.account_code,
          taxableBase: s(m(r.base)),
          taxAmount: s(m(r.tax)),
        })),
        totalTaxableBase: s(
          Money.sum(
            rows.rows.map((r) => m(r.base)),
            currency,
          ),
        ),
        totalTax: s(
          Money.sum(
            rows.rows.map((r) => m(r.tax)),
            currency,
          ),
        ),
        accounts: accounts.rows.map((a) => {
          const onBills = chargedBy.get(a.id) ?? zero;
          return {
            accountId: a.id,
            code: a.code,
            name: a.name,
            chargedOnBills: s(onBills),
            ledgerMovement: s(m(a.movement)),
            otherPostings: s(m(a.movement).subtract(onBills)),
            closingBalance: s(m(a.closing)),
          };
        }),
        recoverablePurchaseTax: s(m(recoverable.rows[0]!.r)),
      };
    });
  }

  revenue(auth: AuthContext, q: RevenueQuery): Promise<RevenueDto> {
    const { propertyId } = reportScope(auth, 'report.financial', q.propertyId);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const currency = await ledgerCurrency(tx);
      const m = (v: string | null | undefined) => Money.fromStorage(v ?? '0', currency);
      const s = (v: Money) => v.round().toString();
      const lines = await tx.execute<{
        id: string;
        code: string;
        name: string;
        role: string | null;
        d: string;
        amount: string;
      }>(sql`
        select a.id, a.code, a.name, a.system_role as role, e.accounting_date::text as d,
               sum(l.credit - l.debit)::text as amount
        from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        join accounts a on a.id = l.account_id
        where a.account_class = 'revenue' and e.status <> 'draft' and ${notYearEndClose}
          and e.accounting_date between ${q.from}::date and ${q.to}::date ${propertyFilter(propertyId)}
        group by a.id, e.accounting_date
        order by e.accounting_date, a.code`);
      const onProperty = (alias: string) =>
        propertyId ? sql`and ${sql.raw(alias)}.property_id = ${propertyId}` : sql``;
      const receipts = await tx.execute<{
        method: RevenueDto['receipts'][number]['method'];
        kind: string;
        amount: string;
      }>(sql`
        select p.method, p.kind, sum(p.amount)::text as amount
        from payments p
        where p.business_date between ${q.from}::date and ${q.to}::date ${onProperty('p')}
        group by 1, 2
        union all
        select r.method, 'refund', sum(r.amount)::text
        from refunds r
        where r.business_date between ${q.from}::date and ${q.to}::date ${onProperty('r')}
        group by 1`);

      const zero = Money.zero(currency);
      const totals = new Map<string, { code: string; name: string; role: string | null; total: Money }>();
      for (const r of lines.rows) {
        const t = totals.get(r.id) ?? { code: r.code, name: r.name, role: r.role, total: zero };
        totals.set(r.id, { ...t, total: t.total.add(m(r.amount)) });
      }
      // Every revenue account posted to in the range, even if its postings net to zero.
      const categories = [...totals].sort(([, a], [, b]) => a.code.localeCompare(b.code));
      const index = new Map(categories.map(([id], i) => [id, i]));
      const days = new Map<string, Money[]>();
      for (const r of lines.rows) {
        const row = days.get(r.d) ?? categories.map(() => zero);
        row[index.get(r.id)!] = row[index.get(r.id)!]!.add(m(r.amount));
        days.set(r.d, row);
      }
      const methods = ['cash', 'bank_transfer', 'card', 'other'] as const;
      const amount = (method: string, kind: string) =>
        m(receipts.rows.find((r) => r.method === method && r.kind === kind)?.amount);
      const byMethod = methods
        .map((method) => {
          const deposits = amount(method, 'deposit');
          const payments = amount(method, 'payment');
          const refunds = amount(method, 'refund');
          return { method, deposits, payments, refunds, net: deposits.add(payments).subtract(refunds) };
        })
        .filter((r) => !(r.deposits.isZero() && r.payments.isZero() && r.refunds.isZero()));

      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: REVENUE_DEFINITIONS,
        from: q.from,
        to: q.to,
        categories: categories.map(([id, v]) => ({
          accountId: id,
          code: v.code,
          name: v.name,
          systemRole: v.role,
          total: s(v.total),
        })),
        days: [...days].map(([date, amounts]) => ({
          date,
          amounts: amounts.map(s),
          total: s(Money.sum(amounts, currency)),
        })),
        total: s(
          Money.sum(
            [...totals.values()].map((v) => v.total),
            currency,
          ),
        ),
        receipts: byMethod.map((r) => ({
          method: r.method,
          deposits: s(r.deposits),
          payments: s(r.payments),
          refunds: s(r.refunds),
          net: s(r.net),
        })),
        receiptsTotal: s(
          Money.sum(
            byMethod.map((r) => r.net),
            currency,
          ),
        ),
      };
    });
  }
}

/** D13: the cash-flow line for the other side of a cash movement. */
export function classify(a: {
  account_class: string;
  report_group: string;
  system_role: string | null;
  is_tax: boolean;
}): CashFlowLine {
  if (a.is_tax || a.system_role === 'tax_payable' || a.system_role === 'tax_recoverable') return 'taxes';
  if (a.system_role === 'guest_deposits') return 'guest_deposits';
  if (a.system_role === 'accounts_payable') return 'payments_to_suppliers';
  if (a.system_role === 'opening_balance_equity') return 'opening_balances';
  if (a.system_role === 'guest_receivable' || a.system_role === 'unbilled_revenue')
    return 'receipts_from_guests';
  switch (a.account_class) {
    case 'revenue':
      return 'receipts_from_guests';
    case 'cost_of_sales':
    case 'expense':
      return 'operating_expenses';
    case 'equity':
      return 'owner_equity';
    case 'other':
      return 'other_operating';
  }
  if (a.report_group === 'non_current_asset') return 'fixed_assets';
  if (a.report_group === 'non_current_liability') return 'loans';
  return 'other_operating';
}
