# Phase 4 exit report — accounting operations

Date: 2026-10-21 · Branch: `phase-1-foundation` · Plan: [phase-4-plan.md](phase-4-plan.md)

## Slices delivered

| Slice | Scope                                                                                         | Commit  |
| ----- | --------------------------------------------------------------------------------------------- | ------- |
| 4.1   | Cash and bank accounts, movements from the ledger, transfers, opening balances                | 605a774 |
| 4.2   | Cashier shifts and cash closings with variance, explanation and approval (CASH-001)           | d83c2c2 |
| 4.3   | Suppliers, cash expenses, supplier bills, payables and payments                               | 3c10f3a |
| 4.4   | Bank reconciliation and card settlements                                                      | 7c73879 |
| 4.5   | Night audit replacing the interim day close (OPS-004), nightly room revenue accrual (D9)      | 8480f42 |
| 4.6   | Month-end checklist and year-end close to retained earnings, with reopen                      | 163b787 |
| —     | Exit gate: Scenario B end to end with the real expense module (`scenario-b.e2e`), this report | this    |

Owner decisions applied: D9 nightly accrual (unbilled revenue, cleared at check-out), D10 calendar year, D11
cashier shifts optional, D12 attachments as a reference only. Refinements made during the build are listed under
"Notes from the build" in the plan (cash linked to the shift open on the drawer; a cash expense is posted when paid
and reviewed afterwards; the existing night-audit checks still need a reason to override).

## Test run (executed 2026-10-21 on 163b787 plus `scenario-b.e2e`, local Postgres 16)

`prettier --check`, `pnpm lint`, `typecheck`, `test`, `build` and `test:integration`: all successful.

- Unit: 154 (money 25, contracts 63, web 22, api 44)
- Database: 352 (db integration 103, API end-to-end 249)

## Exit gate

| Gate item                                                                                                          | Status | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CASH-001: close a cashier session with a variance — variance calculated, reason required, approval policy enforced | Passed | `cashier.e2e`: expected = opening + cash in − cash out (card money excluded); 400 without an explanation; above the threshold the closing waits for approval, within it is accepted and posted at once; the submitter cannot approve (403); approval posts the shortage to 6970; the threshold is a property setting only property managers change. Database rules in `cashier.integration` (variance = counted − expected, explanation for any variance, maker-checker, one live closing per shift).      |
| OPS-004: the night audit runs once per date                                                                        | Passed | `night-audit.e2e`: a replay with the same key returns the same audit, a second run for the date is refused (409), five simultaneous runs let exactly one through, each night is accrued once (unique key, also in `day-close.integration`), and the date advances by one day. The `/day-close` alias and its earlier tests (`day-close.e2e`, 7) still pass.                                                                                                                                                |
| QA scenario B end to end                                                                                           | Passed | `scenario-b.e2e` (new for this gate; every step done by the cashier role): shift opened with the opening count → cash payment → cash-paid expense through the expense module → transfer to the bank → expected cash 12,700 equal to the drawer in the ledger → count 12,100 → explanation required → approval by the accountant only → variance posted to 6970, drawer equals the count, the expense reviewed by someone else, trial balance balanced. `cashier.e2e` covers the same flow with more cases. |
| Transfers never touch revenue or expense                                                                           | Passed | `cash.e2e` (one journal, both lines asset accounts, each tagged with its drawer or bank); `cashier.e2e` and `scenario-b.e2e` (only asset classes on the transfer journal); card settlements in `reconciliation.e2e` post only the fee to bank charges.                                                                                                                                                                                                                                                     |
| Expense to payment with source-linked journals                                                                     | Passed | `expenses.e2e`: a cash expense posts Dr expense / Cr cash in one step; a bill posts to accounts payable with its supplier on approval (never by its creator); recoverable tax to 1300; payments in parts clear payables, never above the bill (422), one per key under concurrency; voids reverse what was posted. Every journal carries its source type and id. Database rules in `expenses.integration` (payables lines name their supplier, payments never exceed the bill, locked after submit).       |
| Reconciliation leaves no unexplained difference                                                                    | Passed | `reconciliation.e2e`: finishing with a difference needs an explanation, which is stored and nothing is posted; the cleared balance plus the open item equals the bank ledger; a line can be reconciled once; statements only move forward; completed reconciliations are locked. Database rules in `reconciliation.integration`.                                                                                                                                                                           |
| Month-end checklist and year-end close keep the trial balance balanced                                             | Passed | `close.e2e`: blockers (night audits not run to month end, drafts, open shifts, closings waiting for approval) stop a close; warnings need a reason kept with the month; the year-end entries bring revenue, cost and expense accounts to zero into retained earnings (46,000, then 45,000 after a reopen and a late bill) and the trial balance balances after each close.                                                                                                                                 |
| Closed periods and locked closings refuse changes                                                                  | Passed | Posting into a closed month (`ledger.e2e` FIN-005, now on a clean September) and into a closed year (`close.e2e`) returns 409 PERIOD_CLOSED; a month of a closed year cannot be reopened on its own; a submitted cash closing returns 409 CASH_CLOSING_ALREADY_SUBMITTED and is locked by the database (`cashier.integration`); completed reconciliations, submitted expenses and year-end records are locked by triggers (`reconciliation`, `expenses`, `close` integration).                             |
| Reopen paths need permission, reason and audit                                                                     | Passed | Cash closing reopen: owner only (`cashier.reopen`), reason, variance reversed (`cashier.e2e`). Year reopen: owner only (`fiscal_year.reopen`), reason, closing entries reversed on 31 December (`close.e2e`). Period reopen: permission and reason (`ledger.e2e`). Each writes an audit event, checked in the tests.                                                                                                                                                                                       |
| Isolation on every new endpoint                                                                                    | Passed | Each Phase 4 e2e file ends with tenant B being refused (404) on cash accounts, transfers, shifts, expenses, suppliers, reconciliations, card settlements, night audit history and year-end (empty for tenant B); row-level security on every new table is asserted in the integration tests; role negatives (403) for front desk, housekeeping and cashier where they lack the permission.                                                                                                                 |
| Shift close and expense entry usable at 360 / 768 / 1280 px                                                        | Passed | Browser run 2026-10-21 (production build, test manager): My shift with an open shift and a 300 shortage typed (live difference and required reason shown), and New expense as a supplier bill with two lines, measured at 360, 768 and 1280 px: no page overflow, no control outside the viewport. At 1280 the shift screen uses two columns. Screens were also checked by hand at 375 px when each slice was built.                                                                                       |

## Not covered or carried forward

- **Viewport method.** The browser pane was being resized while the 768 and 1280 px checks ran, which kept clearing
  the emulated size. The final measurements set the size and measured in one step, by script (page width and the
  position of every control), not by screenshot.
- **Year-end test shortcut.** `close.e2e` moves the business dates into 2027 with SQL instead of running about 75
  night audits; the night audit itself is covered by `night-audit.e2e`.
- **Accountant to confirm.** D9 accrues room revenue net of tax and charges the tax on the guest's bill; the cash
  variance threshold (default Rs 500); opening balances; whether purchase tax is recoverable; the chart of accounts.
- **Known limits.** A supplier bill with payments cannot be voided (no supplier-payment reversal yet). The opening
  count difference on a shift is shown and listed, not posted. The fiscal year is fixed to the calendar year (D10),
  so no setting was added. Statement import for reconciliation (CSV) is not built. Attachments are references (D12).
- **From Phase 3, still open.** The on-account check-out screen is covered by the API test only.
- **Environment.** Docker Desktop stopped on its own several times during the phase and was restarted; no data was
  lost and every test above was re-run after it was back.
- **Phase 5** (from the plan): profit and loss, balance sheet, cashbook and aging reports, dashboards and exports,
  reading the records built here.
