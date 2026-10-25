# Accounting review

Status: slice 6.8 (2026-10-22), Prompt C. For the hotel's accountant: every money flow in InnPilot, the journal it
posts, and the automated tests that prove it. **This is an engineering trace, not accounting advice.** The
questions at the end need a qualified accountant's answer, and their sign-off is a Phase 6 exit gate.

## How the ledger works

- **One posting path.** Every journal goes through one service (`PostingService`). A journal is a draft until
  posted; posting checks it balances, the period is open, and every line on a cash or bank account names that
  account. The database checks again at commit: an unbalanced or incomplete journal cannot be stored, whatever
  the code does.
- **Posted means permanent.** Posted journals and their lines cannot be edited or deleted (database triggers). A
  mistake is corrected by a reversal: an equal and opposite journal, linked to the original.
- **Amounts** are exact decimals (paisa), never floating point; rounding is to whole paisa (D5).
- **Numbering** of journals, receipts, refunds and invoices is gapless and unique, even under concurrent use
  (proved by the load test, docs/phase-6-load-test.md).
- **Reports** read posted lines only; drafts never count.
- **Tags** tie the subsidiary records to the ledger: receivable and deposit lines carry their folio, cash lines their
  cash or bank account, payable lines their supplier. The restore drill and load test check those ties hold.

Chart of accounts (default for every hotel; the accountant may rename or add accounts but not change the system
roles): 1000 Cash on hand, 1100 Bank accounts, 1150 Card and payment clearing, 1200 Guest receivables, 1210 Unbilled
guest revenue, 1300 Tax recoverable, 2000 Accounts payable, 2100 Guest deposits, 2200 Taxes payable, 3100 Retained
earnings, 3200 Current-year earnings, opening balance equity, 4000 Room revenue and other revenue accounts, 4500
Cancellation and no-show fees, 6900 Bank charges, 6960 Guest balances written off, 6970 Cash over and short, 7900
Rounding differences, plus the usual cost and expense accounts.

## Flows and their journals

| Flow                                        | Journal (Dr / Cr)                                                                                                                                              | Proven by                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Night audit: room night accrued** (D9)    | Dr 1210 Unbilled guest revenue / Cr room revenue (net, per occupied night)                                                                                     | night-audit.e2e (OPS-004)                                   |
| **Room nights billed at check-out** (D7)    | Dr 1200 Guest receivables (gross, folio) / Cr 1210 (the accrued net) / Cr room revenue (only any difference since the accrual) / Cr 2200 Taxes payable per tax | checkout.e2e (OPS-003), checkout.integration, folios.e2e    |
| **Folio charge** (food, laundry, …)         | Dr 1200 (gross, folio) / Cr the category's revenue account (net) / Cr 2200 per tax code                                                                        | folios.e2e (TAX-001), tax.e2e                               |
| **Allowance** (discount, correction)        | The reverse of a charge: Dr revenue and Dr 2200 / Cr 1200 (folio); a reason is required                                                                        | folios.e2e                                                  |
| **Void of a charge**                        | A reversal of the charge's journal                                                                                                                             | folios.e2e, ledger.e2e (FIN-004)                            |
| **Transfer between folios**                 | Dr 1200 (receiving folio) / Cr 1200 (giving folio)                                                                                                             | folios.e2e                                                  |
| **Tax**                                     | Calculated per charge from the rates in force on the service date, kept with the charge as a snapshot: later rate changes never alter it                       | tax.e2e (TAX-001)                                           |
| **Deposit before check-in**                 | Dr cash or bank (the drawer or account) / Cr 2100 Guest deposits (folio): a liability, not revenue                                                             | payments.e2e (FIN-007)                                      |
| **Payment during or at the end of a stay**  | Dr cash, bank or 1150 clearing (card) / Cr 1200 (folio)                                                                                                        | payments.e2e, checkout.e2e                                  |
| **Deposit applied to the bill**             | Dr 2100 (folio) / Cr 1200 (folio)                                                                                                                              | payments.e2e, checkout.e2e                                  |
| **Deposit kept** (cancellation, no-show)    | A cancellation charge (Dr 1200 / Cr 4500) then the deposit applied (Dr 2100 / Cr 1200)                                                                         | payments.e2e                                                |
| **Refund**                                  | Dr 2100 or 1200 (folio, as the original payment) / Cr cash or bank; never more than was received less already refunded                                         | payments.e2e, checkout.e2e                                  |
| **Write-off at check-out**                  | Dr 6960 Guest balances written off / Cr 1200 (folio); needs permission and a reason                                                                            | checkout.e2e (FIN-008)                                      |
| **Cash closing variance** (cashier shift)   | Short: Dr 6970 Cash over and short / Cr the drawer. Over: Dr the drawer / Cr 6970                                                                              | cashier.e2e, cashier.integration (CASH-001), scenario-b.e2e |
| **Transfer between cash and bank accounts** | Dr receiving account / Cr giving account (both tagged)                                                                                                         | cash.e2e                                                    |
| **Opening balances** (set-up, D20)          | The entered balances, with any difference to opening balance equity; folio-linked accounts (1200, 2100) are refused                                            | cash.e2e                                                    |
| **Card settlement**                         | Dr bank (net) / Dr 6900 Bank charges (fee) / Cr 1150 clearing (gross)                                                                                          | reconciliation.e2e                                          |
| **Cash expense** ("save and pay")           | Dr cost or expense accounts (net; tax added to cost unless recoverable) / Dr 1300 Tax recoverable (recoverable tax) / Cr the drawer or bank                    | expenses.e2e, scenario-b.e2e                                |
| **Supplier bill approved**                  | Dr cost or expense (and 1300) / Cr 2000 Accounts payable (supplier)                                                                                            | expenses.e2e                                                |
| **Supplier bill paid** (in full or part)    | Dr 2000 (supplier) / Cr bank or cash; never more than is owed                                                                                                  | expenses.e2e                                                |
| **Void of an expense or bill**              | A reversal of what was posted; refused once a bill has payments                                                                                                | expenses.e2e                                                |
| **Manual journal**                          | As entered, by those with the journal permission; drafts until posted                                                                                          | ledger.e2e (FIN-001, FIN-002, FIN-005, FIN-006)             |
| **Reversal**                                | Equal and opposite of the original, same tags, original marked reversed                                                                                        | ledger.e2e, ledger.integration (FIN-004)                    |
| **Month end** (close)                       | No journal: a checklist (unposted drafts, open shifts, unreconciled accounts, …) then the period is locked; posting into it is refused                         | close.e2e, close.integration                                |
| **Year end** (calendar year, D10)           | Every revenue, cost and expense balance closed: Dr or Cr each account / Cr or Dr 3100 Retained earnings with the year's result                                 | close.e2e                                                   |

## Checks that hold across all flows

- **Trial balance balances** for every tenant, and every posted journal equals its lines: checked by the database at
  every commit, by the restore drill on every backup, and after the load test.
- **Folio balance = its ledger lines** (receivable plus deposits tagged with the folio): the folio screen, the guest
  balances report and the restore drill all rely on it; proven on 12,545 folios after the load test.
- **Cash and bank balances = their ledger accounts**, line by line by account.
- **Supplier balances = accounts payable**, by supplier (aging.e2e).
- **Reports tie to the ledger**: profit and loss and balance sheet (reports.e2e), cash flow and cashbook
  (cash-reports.e2e), receivables and payables aging (aging.e2e), dashboard figures from the same report queries
  (dashboard.e2e).

## Questions for the accountant

1. **Revenue recognition (D7, D9):** room revenue is recognised nightly at the night audit (Dr 1210 Unbilled / Cr
   revenue), and the guest is billed at check-out. Is this right for the hotel's reporting, and should 1210 appear
   as a receivable on the balance sheet (it does now)?
2. **Tax-exclusive rates (D6):** room and service prices are entered before tax; tax is added per charge from the
   configured rates. Which taxes, rates and registrations apply to this hotel (federal and provincial), and from
   which dates? Tax rates are configuration, never code: who enters them, and who checks them?
3. **Recoverable tax on purchases:** which purchase taxes can the hotel reclaim (posted to 1300), and which become
   part of cost?
4. **Deposits:** held as a liability (2100) until applied or refunded; kept deposits become 4500 Cancellation and
   no-show fees. Correct, and is tax due on kept deposits?
5. **Write-offs:** posted to 6960 as an expense. Should any be treated differently (e.g. disputed amounts, bad debt
   rules)?
6. **Card fees:** recorded when the bank settles, as 6900 Bank charges. Acceptable, or should fees be accrued?
7. **Cash over and short:** one account (6970) for both. Acceptable?
8. **Rounding:** whole paisa per line, with differences to 7900. Any rule for invoices (e.g. to the rupee)?
9. **Year end:** calendar year (D10). Confirm, or name the fiscal year.
10. **Record retention:** how long must journals, invoices, receipts, guest records and the audit log be kept (the
    backups currently keep 35 daily and 12 monthly copies)?
11. **Invoices:** do the printed invoice's fields meet the hotel's obligations (tax registration numbers, layout,
    e-invoicing or authority integration if required)? InnPilot does not integrate with any tax authority, and must
    not be described as doing so (05 §6).
12. **Opening balances (D20):** the onboarding wizard enters opening balances with any difference to opening
    balance equity. Will you review the opening trial balance before the hotel goes live?

## Sign-off

| Item                                             | Accountant | Date | Notes |
| ------------------------------------------------ | ---------- | ---- | ----- |
| Flows and journals above reviewed                |            |      |       |
| Chart of accounts and tax configuration reviewed |            |      |       |
| Questions 1 to 12 answered                       |            |      |       |
| Opening balances reconciled for the pilot hotel  |            |      |       |
