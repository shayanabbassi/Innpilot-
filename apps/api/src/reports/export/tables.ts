import type {
  BalanceSheetDto,
  CashbookDto,
  CashFlowDto,
  CashierClosingsDto,
  DiscrepanciesDto,
  ExpensesReportDto,
  MovementsDto,
  OccupancyDto,
  PayablesAgingDto,
  ProfitLossDto,
  ReceivablesAgingDto,
  RevenueDto,
  TaxSummaryDto,
  TrialBalanceDto,
  UserActivityDto,
} from '@innpilot/contracts';
import { col, type Cell, type Sheet } from './table';

/**
 * Each report as tables, column for column with its screen. Labels are English like the rest of the API's
 * documents; amounts stay decimal strings.
 */

const PL_LABEL: Record<string, string> = {
  revenue: 'Revenue',
  cost_of_sales: 'Cost of sales',
  operating_expense: 'Operating expenses',
  other: 'Other income and expense',
};
const BS_LABEL: Record<string, string> = {
  current_asset: 'Current assets',
  non_current_asset: 'Non-current assets',
  current_liability: 'Current liabilities',
  non_current_liability: 'Non-current liabilities',
  equity: 'Equity',
};
const CF_LABEL: Record<string, string> = {
  operating: 'Operating activities',
  investing: 'Investing activities',
  financing: 'Financing activities',
  receipts_from_guests: 'Receipts from guests',
  guest_deposits: 'Guest deposits',
  payments_to_suppliers: 'Payments to suppliers',
  operating_expenses: 'Expenses paid',
  taxes: 'Taxes',
  other_operating: 'Other operating items',
  fixed_assets: 'Furniture and equipment',
  loans: 'Loans',
  owner_equity: 'Owner capital and drawings',
  opening_balances: 'Opening balances at go-live',
};
const BUCKET_LABEL: Record<string, string> = {
  current: 'Current',
  d1_30: '1-30 days',
  d31_60: '31-60 days',
  d61_90: '61-90 days',
  over_90: 'Over 90 days',
};

export function trialBalance(d: TrialBalanceDto): Sheet[] {
  const amounts = ['Opening debit', 'Opening credit', 'Debit', 'Credit', 'Closing debit', 'Closing credit'];
  return [
    {
      name: 'Trial balance',
      columns: [col('Code'), col('Account'), col('Class'), ...amounts.map((a) => col(a, 'money'))],
      rows: [
        ...d.rows.map((r): Cell[] => [
          r.code,
          r.name,
          r.accountClass,
          r.openingDebit,
          r.openingCredit,
          r.debit,
          r.credit,
          r.closingDebit,
          r.closingCredit,
        ]),
        [
          null,
          'Total',
          null,
          d.totals.openingDebit,
          d.totals.openingCredit,
          d.totals.debit,
          d.totals.credit,
          d.totals.closingDebit,
          d.totals.closingCredit,
        ],
      ],
    },
  ];
}

export function profitLoss(d: ProfitLossDto): Sheet[] {
  const cmp = d.compare !== 'none';
  const rows: Cell[][] = [];
  const line = (
    section: string,
    code: string | null,
    name: string,
    f: { amount: string; comparison: string | null },
  ) => rows.push([section, code, name, f.amount, ...(cmp ? [f.comparison] : [])]);
  for (const s of d.sections) {
    for (const r of s.rows) line(PL_LABEL[s.key]!, r.code, r.name, r);
    line(PL_LABEL[s.key]!, null, `Total ${PL_LABEL[s.key]!.toLowerCase()}`, s.total);
    if (s.key === 'cost_of_sales') line('', null, 'Gross profit', d.grossProfit);
    if (s.key === 'operating_expense') line('', null, 'Operating profit', d.operatingProfit);
  }
  line('', null, 'Net profit (loss)', d.netProfit);
  return [
    {
      name: 'Profit and loss',
      columns: [
        col('Section'),
        col('Code'),
        col('Account'),
        col(`${d.from} to ${d.to}`, 'money'),
        ...(cmp ? [col(`${d.comparisonFrom} to ${d.comparisonTo}`, 'money')] : []),
      ],
      rows,
    },
  ];
}

export function balanceSheet(d: BalanceSheetDto): Sheet[] {
  const rows: Cell[][] = [];
  for (const s of d.sections) {
    for (const r of s.rows) rows.push([BS_LABEL[s.key]!, r.code, r.name, r.amount]);
    if (s.key === 'equity') {
      rows.push(['Equity', null, `Result for ${d.asOf.slice(0, 4)} to date`, d.currentYearResult]);
      rows.push(['Equity', null, 'Result of earlier years not yet closed', d.earlierYearsResult]);
      rows.push(['Equity', null, 'Total equity', d.totalEquity]);
    } else {
      rows.push([BS_LABEL[s.key]!, null, `Total ${BS_LABEL[s.key]!.toLowerCase()}`, s.total]);
    }
    if (s.key === 'non_current_asset') rows.push(['', null, 'Total assets', d.totalAssets]);
    if (s.key === 'non_current_liability') rows.push(['', null, 'Total liabilities', d.totalLiabilities]);
  }
  rows.push(['', null, 'Total liabilities and equity', d.totalLiabilitiesAndEquity]);
  rows.push(['', null, 'Difference', d.difference]);
  return [
    {
      name: 'Balance sheet',
      columns: [col('Section'), col('Code'), col('Account'), col(`As of ${d.asOf}`, 'money')],
      rows,
    },
  ];
}

export function cashbook(d: CashbookDto): Sheet[] {
  return [
    {
      name: 'Accounts',
      columns: [
        col('Account'),
        col('Kind'),
        col('Ledger account'),
        col('Opening', 'money'),
        col('Receipts', 'money'),
        col('Payments', 'money'),
        col('Closing', 'money'),
      ],
      rows: [
        ...d.accounts.map((a): Cell[] => [
          a.name,
          a.kind,
          a.ledgerAccountCode,
          a.opening,
          a.receipts,
          a.payments,
          a.closing,
        ]),
        ['Total', null, null, d.totals.opening, d.totals.receipts, d.totals.payments, d.totals.closing],
      ],
    },
    {
      name: 'By day',
      columns: [
        col('Account'),
        col('Date', 'date'),
        col('Receipts', 'money'),
        col('Payments', 'money'),
        col('Closing', 'money'),
      ],
      rows: d.accounts.flatMap((a) =>
        a.days.map((x): Cell[] => [a.name, x.date, x.receipts, x.payments, x.closing]),
      ),
    },
    {
      name: 'Check against the ledger',
      columns: [
        col('Code'),
        col('Ledger account'),
        col('Drawers and banks', 'money'),
        col('Ledger balance', 'money'),
        col('Difference', 'money'),
      ],
      rows: d.controls.map((c): Cell[] => [
        c.code,
        c.name,
        c.cashAccountsTotal,
        c.ledgerBalance,
        c.difference,
      ]),
    },
  ];
}

export function cashFlow(d: CashFlowDto): Sheet[] {
  const rows: Cell[][] = [['', 'Cash at the start', null, null, d.openingCash]];
  for (const s of d.sections) {
    for (const l of s.lines) rows.push([CF_LABEL[s.key]!, CF_LABEL[l.key]!, l.inflow, l.outflow, l.net]);
    rows.push([CF_LABEL[s.key]!, `Net cash from ${CF_LABEL[s.key]!.toLowerCase()}`, null, null, s.net]);
  }
  rows.push(['', 'Net change in cash', null, null, d.netChange]);
  rows.push(['', 'Cash at the end', null, null, d.closingCash]);
  rows.push(['', 'Moved between the hotel’s own accounts (not in or out)', null, null, d.transfers]);
  return [
    {
      name: 'Cash flow',
      columns: [col('Section'), col('Line'), col('In', 'money'), col('Out', 'money'), col('Net', 'money')],
      rows,
    },
  ];
}

export function taxSummary(d: TaxSummaryDto): Sheet[] {
  return [
    {
      name: 'Tax on guest bills',
      columns: [
        col('Code'),
        col('Name'),
        col('Rate %', 'decimal'),
        col('Included in price'),
        col('Account'),
        col('Taxable amount', 'money'),
        col('Tax', 'money'),
      ],
      rows: [
        ...d.rows.map((r): Cell[] => [
          r.code,
          r.name,
          r.ratePercent,
          r.inclusive ? 'yes' : 'no',
          r.accountCode,
          r.taxableBase,
          r.taxAmount,
        ]),
        ['Total', null, null, null, null, d.totalTaxableBase, d.totalTax],
      ],
    },
    {
      name: 'Tax accounts',
      columns: [
        col('Code'),
        col('Account'),
        col('Charged on bills', 'money'),
        col('Payments and adjustments', 'money'),
        col('Movement', 'money'),
        col('Balance at the end', 'money'),
      ],
      rows: [
        ...d.accounts.map((a): Cell[] => [
          a.code,
          a.name,
          a.chargedOnBills,
          a.otherPostings,
          a.ledgerMovement,
          a.closingBalance,
        ]),
        ['', 'Recoverable purchase tax (1300)', null, null, d.recoverablePurchaseTax, null],
      ],
    },
  ];
}

export function revenue(d: RevenueDto): Sheet[] {
  return [
    {
      name: 'Revenue by day',
      columns: [
        col('Date', 'date'),
        ...d.categories.map((c) => col(`${c.code} ${c.name}`, 'money')),
        col('Total', 'money'),
      ],
      rows: [
        ...d.days.map((x): Cell[] => [x.date, ...x.amounts, x.total]),
        ['Total', ...d.categories.map((c) => c.total), d.total],
      ],
    },
    {
      name: 'Money received',
      columns: [
        col('Method'),
        col('Deposits', 'money'),
        col('Payments', 'money'),
        col('Refunds', 'money'),
        col('Net', 'money'),
      ],
      rows: [
        ...d.receipts.map((r): Cell[] => [r.method, r.deposits, r.payments, r.refunds, r.net]),
        ['Total', null, null, null, d.receiptsTotal],
      ],
    },
  ];
}

const tieSheet = (rows: ReceivablesAgingDto['ledger']): Sheet => ({
  name: 'Check against the ledger',
  columns: [
    col('Code'),
    col('Account'),
    col('Ledger balance', 'money'),
    col('In this report', 'money'),
    col('Not linked', 'money'),
  ],
  rows: rows.map((r): Cell[] => [r.code, r.name, r.ledgerBalance, r.aged, r.notLinked]),
});

export function receivablesAging(d: ReceivablesAgingDto): Sheet[] {
  return [
    {
      name: 'Guest balances',
      columns: [
        col('Guest'),
        col('Booking'),
        col('Folio'),
        col('State'),
        col('Invoice'),
        col('Invoice date', 'date'),
        col('Days', 'int'),
        col('Age'),
        col('Receivable', 'money'),
        col('Deposits', 'money'),
        col('Balance', 'money'),
      ],
      rows: [
        ...d.guests.flatMap((g) =>
          g.folios.map((f): Cell[] => [
            g.guestName,
            f.bookingReference,
            f.label,
            f.state === 'open' ? 'Open' : 'Checked out',
            f.invoiceNumber,
            f.invoiceDate,
            f.days,
            BUCKET_LABEL[f.bucket]!,
            f.receivable,
            f.deposits,
            f.balance,
          ]),
        ),
        ...Object.entries(BUCKET_LABEL).map(([k, label]): Cell[] => [
          `Total ${label.toLowerCase()}`,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          d.totals[k as keyof typeof d.totals],
        ]),
        ['Total', null, null, null, null, null, null, null, null, null, d.totals.total],
      ],
    },
    tieSheet(d.ledger),
  ];
}

export function payablesAging(d: PayablesAgingDto): Sheet[] {
  return [
    {
      name: 'Supplier bills',
      columns: [
        col('Supplier'),
        col('Voucher'),
        col('Bill reference'),
        col('Bill date', 'date'),
        col('Due date', 'date'),
        col('Days overdue', 'int'),
        col('Age'),
        col('Bill total', 'money'),
        col('Paid', 'money'),
        col('Outstanding', 'money'),
      ],
      rows: [
        ...d.suppliers.flatMap((s) => [
          ...s.bills.map((b): Cell[] => [
            s.supplierName,
            b.voucherNumber,
            b.billReference,
            b.billDate,
            b.dueDate,
            b.days,
            BUCKET_LABEL[b.bucket]!,
            b.total,
            b.paid,
            b.outstanding,
          ]),
          ...(/[1-9]/.test(s.notLinked)
            ? [
                [
                  s.supplierName,
                  null,
                  'Not linked to a bill',
                  null,
                  null,
                  null,
                  null,
                  null,
                  null,
                  s.notLinked,
                ] as Cell[],
              ]
            : []),
        ]),
        ...Object.entries(BUCKET_LABEL).map(([k, label]): Cell[] => [
          `Total ${label.toLowerCase()}`,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          d.totals[k as keyof typeof d.totals],
        ]),
        ['Not linked to a bill', null, null, null, null, null, null, null, null, d.notLinked],
      ],
    },
    tieSheet(d.ledger),
  ];
}

export function occupancy(d: OccupancyDto): Sheet[] {
  return [
    {
      name: 'Occupancy',
      columns: [
        col('Night', 'date'),
        col('Basis'),
        col('Rooms', 'int'),
        col('Out of order', 'int'),
        col('Available', 'int'),
        col('Sold', 'int'),
        col('Occupancy %', 'decimal'),
        col('Room revenue', 'money'),
        col('ADR', 'money'),
        col('RevPAR', 'money'),
      ],
      rows: [
        ...d.nights.map((n): Cell[] => [
          n.night,
          n.basis === 'actual' ? 'Actual' : 'On the books',
          n.rooms,
          n.outOfService,
          n.available,
          n.sold,
          n.occupancy,
          n.basis === 'actual' ? n.roomRevenue : null,
          n.adr,
          n.revpar,
        ]),
        [
          'Actual nights',
          null,
          null,
          null,
          d.totals.available,
          d.totals.sold,
          d.totals.occupancy,
          d.totals.roomRevenue,
          d.totals.adr,
          d.totals.revpar,
        ],
      ],
    },
  ];
}

export function movements(d: MovementsDto): Sheet[] {
  const columns = [
    col('Date', 'date'),
    col('Booking'),
    col('Guest'),
    col('Room'),
    col('Room type'),
    col('Nights', 'int'),
    col('Adults', 'int'),
    col('Status'),
  ];
  const rows = (list: MovementsDto['arrivals'], date: 'arrival' | 'departure') =>
    list.map((m): Cell[] => [
      m[date],
      m.bookingReference,
      m.guestName,
      m.roomNumber,
      m.roomType,
      m.nights,
      m.adults,
      m.status,
    ]);
  return [
    { name: 'Arrivals', columns, rows: rows(d.arrivals, 'arrival') },
    { name: 'Departures', columns, rows: rows(d.departures, 'departure') },
  ];
}

export function cashierClosings(d: CashierClosingsDto): Sheet[] {
  return [
    {
      name: 'Cash closings',
      columns: [
        col('Date', 'date'),
        col('Cashier'),
        col('Drawer'),
        col('Expected', 'money'),
        col('Counted', 'money'),
        col('Variance', 'money'),
        col('Explanation'),
        col('Status'),
        col('Approved by'),
        col('Reopen reason'),
      ],
      rows: d.closings.map((c): Cell[] => [
        c.businessDate,
        c.cashierName,
        c.cashAccountName,
        c.expected,
        c.counted,
        c.variance,
        c.explanation,
        c.status,
        c.approvedByName,
        c.reopenReason,
      ]),
    },
  ];
}

export function expenses(d: ExpensesReportDto): Sheet[] {
  return [
    {
      name: 'By account',
      columns: [
        col('Code'),
        col('Account'),
        col('Amount', 'money'),
        col('Tax in cost', 'money'),
        col('Total', 'money'),
      ],
      rows: [
        ...d.byAccount.map((a): Cell[] => [a.code, a.name, a.amount, a.tax, a.total]),
        ['', 'Total', null, null, d.total],
        ['', 'Recoverable purchase tax (not in cost)', null, null, d.recoverableTax],
      ],
    },
    {
      name: 'By supplier or payee',
      columns: [
        col('Supplier or payee'),
        col('Cash', 'money'),
        col('Bills', 'money'),
        col('Total', 'money'),
        col('Vouchers', 'int'),
      ],
      rows: d.byPayee.map((p): Cell[] => [p.name, p.cash, p.bills, p.total, p.vouchers]),
    },
  ];
}

export function discrepancies(d: DiscrepanciesDto): Sheet[] {
  return [
    {
      name: 'Cash variances',
      columns: [
        col('Date', 'date'),
        col('Cashier'),
        col('Drawer'),
        col('Variance', 'money'),
        col('Explanation'),
        col('Status'),
      ],
      rows: d.variances.map((v): Cell[] => [
        v.businessDate,
        v.cashierName,
        v.cashAccountName,
        v.variance,
        v.explanation,
        v.status,
      ]),
    },
    {
      name: 'Opening count differences',
      columns: [
        col('Date', 'date'),
        col('Cashier'),
        col('Drawer'),
        col('Counted', 'money'),
        col('Ledger', 'money'),
        col('Difference', 'money'),
      ],
      rows: d.openingDifferences.map((o): Cell[] => [
        o.businessDate,
        o.cashierName,
        o.cashAccountName,
        o.openingCount,
        o.bookBalance,
        o.difference,
      ]),
    },
    {
      name: 'Cash outside a shift',
      columns: [
        col('Date', 'date'),
        col('Journal', 'int'),
        col('Narration'),
        col('Drawer'),
        col('In', 'money'),
        col('Out', 'money'),
      ],
      rows: d.cashOutsideShifts.map((c): Cell[] => [
        c.accountingDate,
        c.journalNumber,
        c.narration,
        c.cashAccountName,
        c.amountIn,
        c.amountOut,
      ]),
    },
    {
      name: 'Night audit overrides',
      columns: [col('Date', 'date'), col('Reason'), col('Open items', 'int'), col('Closed by')],
      rows: d.auditOverrides.map((o): Cell[] => [o.businessDate, o.reason, o.issues, o.closedByName]),
    },
  ];
}

export function userActivity(d: UserActivityDto): Sheet[] {
  return [
    {
      name: 'User activity',
      columns: [
        col('User'),
        col('Events', 'int'),
        col('Sign-ins', 'int'),
        col('Failed sign-ins', 'int'),
        col('First (UTC)'),
        col('Last (UTC)'),
        col('Most frequent actions'),
      ],
      rows: d.users.map((u): Cell[] => [
        u.name,
        u.events,
        u.signIns,
        u.failedSignIns,
        u.firstAt,
        u.lastAt,
        u.topActions.map((a) => `${a.action} (${a.count})`).join('; '),
      ]),
    },
  ];
}
