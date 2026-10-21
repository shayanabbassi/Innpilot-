import { Injectable } from '@nestjs/common';
import {
  agingBucket,
  AGING_BUCKETS,
  type AgingBucket,
  type AgingQuery,
  type PayablesAgingDto,
  type ReceivablesAgingDto,
} from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { sql } from 'drizzle-orm';
import type { AuthContext } from '../common/request';
import { Db } from '../db/db.module';
import { daysBetween, ledgerCurrency, propertyFilter, reportScope, reportTimezone } from './report-scope';

const RECEIVABLE_DEFINITIONS = {
  balance:
    'Guest receivable less deposits held on the folio, from the ledger lines tagged with it, on the date.',
  aging:
    'Days since the folio’s invoice (check-out) date. Folios still open, or checked out after the date, are current.',
  notLinked: 'Ledger amounts on the account that are not tagged with a folio.',
};

const PAYABLE_DEFINITIONS = {
  outstanding: 'Bill amount posted to accounts payable less payments, on the date.',
  aging: 'Days past the due date (the bill date when no due date was entered). Not yet due is current.',
  notLinked:
    'Payables of the supplier not linked to a bill, such as opening balances or manual journals. Not aged.',
};

type Totals = Record<AgingBucket | 'total', Money>;

/** Receivables and payables aging (slice 5.3, D14), read from the ledger lines tagged with folios and suppliers. */
@Injectable()
export class AgingService {
  constructor(private readonly db: Db) {}

  receivables(auth: AuthContext, q: AgingQuery): Promise<ReceivablesAgingDto> {
    const { propertyId } = reportScope(auth, 'report.financial', q.propertyId);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const currency = await ledgerCurrency(tx);
      const m = (v: string | null | undefined) => Money.fromStorage(v ?? '0', currency);
      const s = (v: Money) => v.round().toString();
      const tagged = sql`
        select l.folio_id,
               coalesce(sum(l.debit - l.credit) filter (where a.system_role = 'guest_receivable'), 0) as recv,
               coalesce(sum(l.debit - l.credit) filter (where a.system_role = 'guest_deposits'), 0) as dep
        from journal_lines l
        join journal_entries e on e.id = l.journal_entry_id
        join accounts a on a.id = l.account_id
        where l.folio_id is not null and a.system_role in ('guest_receivable', 'guest_deposits')
          and e.status <> 'draft' and e.accounting_date <= ${q.asOf}::date ${propertyFilter(propertyId)}
        group by l.folio_id
        -- Filtered before the joins (P5-16); folios whose receivable and deposits offset stay for the ledger tie.
        having sum(l.debit - l.credit) filter (where a.system_role = 'guest_receivable') <> 0
            or sum(l.debit - l.credit) filter (where a.system_role = 'guest_deposits') <> 0`;
      const rows = await tx.execute<{
        folio_id: string;
        property_id: string;
        reservation_id: string;
        label: string;
        guest_id: string;
        guest_name: string;
        booking_reference: string;
        recv: string;
        dep: string;
        invoice_number: string | null;
        issue_date: string | null;
      }>(sql`
        select f.id as folio_id, f.property_id, f.reservation_id, f.label, f.guest_id, g.full_name as guest_name,
               r.booking_reference, b.recv::text, b.dep::text, inv.invoice_number, inv.issue_date::text
        from (${tagged}) b
        join folios f on f.id = b.folio_id
        join guests g on g.id = f.guest_id
        join reservations r on r.id = f.reservation_id
        left join lateral (
          select i.invoice_number, i.issue_date from invoices i
          where i.folio_id = f.id and i.issue_date <= ${q.asOf}::date
          order by i.issue_date desc, i.created_at desc limit 1
        ) inv on true
        order by g.full_name, r.booking_reference, f.label`);
      const ledger = await tx.execute<{
        id: string;
        code: string;
        name: string;
        role: string;
        balance: string;
      }>(sql`
        select a.id, a.code, a.name, a.system_role as role,
               coalesce((select sum(l.debit - l.credit) from journal_lines l
                         join journal_entries e on e.id = l.journal_entry_id
                         where l.account_id = a.id and e.status <> 'draft'
                           and e.accounting_date <= ${q.asOf}::date ${propertyFilter(propertyId)}), 0)::text as balance
        from accounts a where a.system_role in ('guest_receivable', 'guest_deposits')
        order by a.code`);

      const zero = Money.zero(currency);
      const totals = emptyTotals(zero);
      let recvAged = zero;
      let depAged = zero;
      type Folio = ReceivablesAgingDto['guests'][number]['folios'][number];
      const guests = new Map<
        string,
        { guestId: string; guestName: string; folios: Folio[]; totals: Totals }
      >();
      for (const r of rows.rows) {
        const recv = m(r.recv);
        const dep = m(r.dep);
        const balance = recv.add(dep);
        recvAged = recvAged.add(recv);
        depAged = depAged.add(dep);
        // Counted in the tie above; listed only when something is still owed or held.
        if (balance.isZero()) continue;
        const days = r.issue_date ? daysBetween(r.issue_date, q.asOf) : 0;
        const bucket = agingBucket(days);
        const g = guests.get(r.guest_id) ?? {
          guestId: r.guest_id,
          guestName: r.guest_name,
          folios: [],
          totals: emptyTotals(zero),
        };
        g.folios.push({
          folioId: r.folio_id,
          propertyId: r.property_id,
          reservationId: r.reservation_id,
          bookingReference: r.booking_reference,
          label: r.label,
          state: r.issue_date ? ('checked_out' as const) : ('open' as const),
          invoiceNumber: r.invoice_number,
          invoiceDate: r.issue_date,
          days: Math.max(days, 0),
          bucket,
          receivable: s(recv),
          deposits: s(dep),
          balance: s(balance),
        });
        add(g.totals, bucket, balance);
        add(totals, bucket, balance);
        guests.set(r.guest_id, g);
      }

      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: RECEIVABLE_DEFINITIONS,
        asOf: q.asOf,
        guests: [...guests.values()].map((g) => ({ ...g, totals: str(g.totals) })),
        totals: str(totals),
        ledger: ledger.rows.map((a) => {
          const aged = a.role === 'guest_receivable' ? recvAged : depAged;
          return {
            accountId: a.id,
            code: a.code,
            name: a.name,
            ledgerBalance: s(m(a.balance)),
            aged: s(aged),
            notLinked: s(m(a.balance).subtract(aged)),
          };
        }),
      };
    });
  }

  payables(auth: AuthContext, q: AgingQuery): Promise<PayablesAgingDto> {
    const { propertyId } = reportScope(auth, 'report.financial', q.propertyId);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const currency = await ledgerCurrency(tx);
      const m = (v: string | null | undefined) => Money.fromStorage(v ?? '0', currency);
      const s = (v: Money) => v.round().toString();
      // A bill's payable: its approval journal, a reversal of it (void) and its payments, up to the date.
      const bills = await tx.execute<{
        id: string;
        property_id: string;
        voucher_number: string;
        bill_reference: string | null;
        bill_date: string;
        due_date: string;
        supplier_id: string;
        total: string;
        paid: string;
        outstanding: string;
      }>(sql`
        select v.id, v.property_id, v.voucher_number, v.bill_reference, v.expense_date::text as bill_date,
               coalesce(v.due_date, v.expense_date)::text as due_date, v.supplier_id, v.total_amount::text as total,
               coalesce((select sum(p.amount) from expense_payments p
                         join journal_entries e on e.id = p.journal_entry_id
                         where p.voucher_id = v.id and e.status <> 'draft'
                           and e.accounting_date <= ${q.asOf}::date), 0)::text as paid,
               coalesce((select sum(l.credit - l.debit) from journal_lines l
                         join journal_entries e on e.id = l.journal_entry_id
                         join accounts a on a.id = l.account_id
                         where a.system_role = 'accounts_payable' and e.status <> 'draft'
                           and e.accounting_date <= ${q.asOf}::date
                           and (e.id = v.journal_entry_id or e.reverses_entry_id = v.journal_entry_id
                                or e.id in (select p.journal_entry_id from expense_payments p where p.voucher_id = v.id))
                        ), 0)::text as outstanding
        from expense_vouchers v
        where v.kind = 'bill' and v.journal_entry_id is not null
          ${propertyId ? sql`and v.property_id = ${propertyId}` : sql``}
        order by coalesce(v.due_date, v.expense_date), v.voucher_number`);
      const balances = await tx.execute<{ id: string; name: string; balance: string }>(sql`
        select s.id, s.name, coalesce(sum(l.credit - l.debit), 0)::text as balance
        from suppliers s
        join journal_lines l on l.supplier_id = s.id
        join journal_entries e on e.id = l.journal_entry_id
        join accounts a on a.id = l.account_id
        where a.system_role = 'accounts_payable' and e.status <> 'draft'
          and e.accounting_date <= ${q.asOf}::date ${propertyFilter(propertyId)}
        group by s.id
        order by s.name`);
      const ledger = await tx.execute<{ id: string; code: string; name: string; balance: string }>(sql`
        select a.id, a.code, a.name,
               coalesce((select sum(l.credit - l.debit) from journal_lines l
                         join journal_entries e on e.id = l.journal_entry_id
                         where l.account_id = a.id and e.status <> 'draft'
                           and e.accounting_date <= ${q.asOf}::date ${propertyFilter(propertyId)}), 0)::text as balance
        from accounts a where a.system_role = 'accounts_payable'`);

      const zero = Money.zero(currency);
      const totals = emptyTotals(zero);
      let aged = zero;
      const bySupplier = new Map<
        string,
        { bills: PayablesAgingDto['suppliers'][number]['bills']; totals: Totals }
      >();
      for (const b of bills.rows) {
        const outstanding = m(b.outstanding);
        if (outstanding.round().isZero()) continue;
        const days = daysBetween(b.due_date, q.asOf);
        const bucket = agingBucket(days);
        const sup = bySupplier.get(b.supplier_id) ?? { bills: [], totals: emptyTotals(zero) };
        sup.bills.push({
          voucherId: b.id,
          propertyId: b.property_id,
          voucherNumber: b.voucher_number,
          billReference: b.bill_reference,
          billDate: b.bill_date,
          dueDate: b.due_date,
          days: Math.max(days, 0),
          bucket,
          total: s(m(b.total)),
          paid: s(m(b.paid)),
          outstanding: s(outstanding),
        });
        add(sup.totals, bucket, outstanding);
        add(totals, bucket, outstanding);
        aged = aged.add(outstanding);
        bySupplier.set(b.supplier_id, sup);
      }
      let notLinkedTotal = zero;
      const suppliers = balances.rows
        .map((row) => {
          const sup = bySupplier.get(row.id) ?? { bills: [], totals: emptyTotals(zero) };
          const balance = m(row.balance);
          const notLinked = balance.subtract(sup.totals.total);
          notLinkedTotal = notLinkedTotal.add(notLinked);
          return {
            supplierId: row.id,
            supplierName: row.name,
            bills: sup.bills,
            notLinked: s(notLinked),
            totals: str(sup.totals),
            balance: s(balance),
          };
        })
        .filter((x) => x.bills.length > 0 || /[1-9]/.test(x.balance));
      const ap = ledger.rows[0];

      return {
        propertyId,
        currencyCode: currency,
        timezone: await reportTimezone(tx, propertyId),
        generatedAt: new Date().toISOString(),
        definitions: PAYABLE_DEFINITIONS,
        asOf: q.asOf,
        suppliers,
        totals: str(totals),
        notLinked: s(notLinkedTotal),
        ledger: ap
          ? [
              {
                accountId: ap.id,
                code: ap.code,
                name: ap.name,
                ledgerBalance: s(m(ap.balance)),
                aged: s(aged),
                notLinked: s(m(ap.balance).subtract(aged)),
              },
            ]
          : [],
      };
    });
  }
}

function emptyTotals(zero: Money): Totals {
  return { current: zero, d1_30: zero, d31_60: zero, d61_90: zero, over_90: zero, total: zero };
}

function add(t: Totals, bucket: AgingBucket, amount: Money) {
  t[bucket] = t[bucket].add(amount);
  t.total = t.total.add(amount);
}

function str(t: Totals): Record<AgingBucket | 'total', string> {
  const out = { total: t.total.round().toString() } as Record<AgingBucket | 'total', string>;
  for (const b of AGING_BUCKETS) out[b] = t[b].round().toString();
  return out;
}
