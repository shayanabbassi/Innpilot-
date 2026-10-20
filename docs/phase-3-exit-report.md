# Phase 3 exit report — ledger, taxes, folios, payments and check-out

Date: 2026-10-20 · Branch: `phase-1-foundation` · Plan: [phase-3-plan.md](phase-3-plan.md)

## Slices delivered

| Slice | Scope                                                                                        | Commits           |
| ----- | -------------------------------------------------------------------------------------------- | ----------------- |
| 3.1   | Ledger core: chart of accounts, periods, balanced and immutable journals, reversals, TB      | e099e23           |
| 3.2   | Tax codes with effective-dated rates, charge categories, invoice profile                     | 5aa5958           |
| 3.3   | Folios: charges with tax snapshots, allowances, voids, transfers, pending room nights (D7)   | 9d91487           |
| 3.4   | Payments, deposits, refunds, receipts; deposit handling on cancel and no-show                | bc8269b           |
| 3.5   | Check-out: room nights, deposit application, settlement, invoices; web check-out and invoice | c6493da, 021d8de  |
| —     | Log-capture fix merged (Nest Logger lines now reach the e2e log test)                        | 15a3611 / 44d5fa6 |

Owner decisions applied: D5 paisa rounding, D6 tax-exclusive by default, D7 room nights posted at check-out, D8
printable invoices (server PDF later).

## Test run (executed 2026-10-20 on 021d8de, local Postgres 16)

`pnpm lint`, `typecheck`, `test`, `build` and `test:integration`: all successful.

- Unit: 144 (money 25, contracts 53, web 22, api 44)
- Database: 252 (db integration 74, API end-to-end 178)

## Exit gate

| Gate item                                                | Status | Evidence                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FIN-001 unbalanced journal rejected, no partial entry    | Passed | `ledger.integration` (rejected at commit by the database, nothing left behind); `ledger.e2e` FIN-001 (422 JOURNAL_UNBALANCED, draft unchanged, no journal number used)                                                                  |
| FIN-002 balanced journal posted once, audited            | Passed | `ledger.e2e` FIN-002 (numbered, replay returns the same entry, second post 409, one `journal.posted` audit event)                                                                                                                       |
| FIN-003 payment retry never duplicates money or journals | Passed | `payments.e2e` FIN-003 (10 simultaneous requests with one key: one payment, one journal, gapless receipt numbers); same pattern for journal posting in `ledger.e2e` and for check-out in `checkout.e2e`                                 |
| FIN-004 posted lines cannot be edited; reversal works    | Passed | `ledger.integration` (updates and deletes refused by triggers); `ledger.e2e` FIN-004 (409 on edit/delete, equal and opposite reversal linked both ways, second reversal refused)                                                        |
| FIN-005 closed period blocks posting until reopened      | Passed | `ledger.integration` (trigger refuses a closed or non-covering period); `ledger.e2e` FIN-005 (409 PERIOD_CLOSED, reopen needs a reason, audited)                                                                                        |
| FIN-006 trial balance balances and is reproducible       | Passed | `ledger.e2e` FIN-006 (all accounts, debits = credits, same result twice, opening balances roll forward); trial balance re-checked as balanced in `folios`, `payments` and `checkout` e2e                                                |
| FIN-007 deposit before stay is a liability, not revenue  | Passed | `payments.e2e` FIN-007 (Dr cash / Cr 2100 guest deposits with the folio, room revenue untouched, applied to the bill only at check-out in `checkout.e2e`)                                                                               |
| FIN-008 check-out cannot silently close a balance        | Passed | `checkout.e2e` (409 SETTLEMENT_REQUIRED with nothing changed; settlement by payment, credit refund, write-off or move to account, each tested)                                                                                          |
| TAX-001 later rate changes leave posted documents alone  | Passed | `tax.e2e` TAX-001 (rates are history, edits refused by the database); `folios.e2e` (a charge keeps 16% after a 17% rate starts); `checkout.e2e` (issued invoice unchanged after the invoice profile changes)                            |
| OPS-003 check-out: room dirty, one cleaning task         | Passed | `checkout.e2e` (room dirty, exactly one open cleaning task, retry with the same key changes nothing, each night posted once — also enforced by a unique key in `checkout.integration`)                                                  |
| QA scenario A: reservation to check-out                  | Passed | `checkout.e2e` scenario A: deposit → check-in → dinner → two day closes → preview → refused without settlement → paid check-out → invoice with nights, tax summary and hotel details. Also run by hand in the browser (pay and refund). |
| QA scenario C: refund and correction                     | Passed | `payments.e2e` Scenario C (partial refund linked to the payment, over-refund 422 REFUND_EXCEEDS_REMAINDER, original kept) and the database guard in `payments.integration`                                                              |
| Folio reconciliation recipe                              | Passed | `folios.e2e`, `payments.e2e`, `checkout.e2e`: after charges, allowance, void, transfer, deposit, payment, refund, write-off and check-out, each folio's balance equals its guest receivable + guest deposit lines in the ledger         |
| Cross-tenant denial: folio, payment, invoice, journal    | Passed | Isolation tests in `ledger`, `tax`, `folios`, `payments` and `checkout` e2e (404 for another tenant's records, refusing their accounts and tax codes); RLS checks in `ledger.integration`                                               |
| Tax and period changes audited (AUD-001 part)            | Passed | `tax.e2e` (tax code, rate added and removed audited; registration numbers kept out of the audit log); `ledger.e2e` (period reopen audited with its reason)                                                                              |
| Check-out and payment usable at 360 / 768 / 1280 px      | Passed | Browser run 2026-10-20 (production build): check-out page, reservation with folio panel, payment dialog, invoice and receipt at 360, 768 and 1280 px with no page overflow; dialogs fit. Pay and refund check-outs completed at 360 px. |

## Not covered or carried forward

- The **on-account** check-out and later payment are covered by the API e2e test only; that screen was not
  exercised by hand in the browser.
- The 1280 px sweep of the other finance and settings pages was cut short because the browser pane was in use; those
  pages were checked at 360 px when they were built, and the trial balance at 1280 px in slice 3.1.
- Known limits listed at the end of the plan: the day close's automatic no-show keeps any deposit held (staff can
  then keep it as a fee); a credit created after a deposit was applied cannot yet be refunded from that deposit.
- Phase 4 (from the plan): cashier sessions and variance (CASH-001), expenses and payables, reconciliation, the full
  night audit (OPS-004), year-end close. Phase 5: financial statements and aging reports.
- Before pilot: the chart of accounts template, tax set-up, deposit and write-off policy, and invoice fields need
  review by a local accountant or tax adviser. Invoices are labelled as not certified tax invoices.
