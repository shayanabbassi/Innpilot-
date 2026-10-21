# Phase 5 — Reporting: slice plan

Status: **Plan agreed 2026-10-21 (D13–D16), awaiting go-ahead for 5.1** · Builds on: Phase 4 (accepted 2026-10-21, 854edb5)

Scope: financial statements, cashbook and bank ledger, cash flow, tax and revenue summaries, receivables and
payables aging, operational reports, the owner dashboard and authorized exports. Sources: 01 Accounting & Ledger
spec §6 and §8, PRD §6.9 and §7, 01 UX spec §6.3 and §6.13, 04 Frontend spec §1–3, 04 API spec §3 and §11,
05 QA scenario E and the reports checklist, 06 acceptance matrix (FIN-006, SEC-002 "front desk calls financial
report endpoint", the financial statements recipe), 08 backlog (core reports, exports). Phase 0 also placed user
administration, the audit log viewer and the platform admin here; the platform admin stays in this phase as 5.7 (D16).

**Already in place:** the trial balance (opening, debit, credit, closing per account), the general ledger view,
cash movements per cash account, the night audit summary per date, shift history, the expense list, the audit log
viewer and staff administration. Permissions `report.operational`, `report.financial` and `export.run` exist in
the role table but nothing checks them yet.

Every slice ships as before: migration where needed, API in the OpenAPI contract, UI with loading, empty, error
and permission-denied states, server-side permissions, unit + Postgres integration + e2e tests with tenant and role
negatives, all checks, browser check, one commit.

---

## Design decisions (defaults unless you say otherwise)

| #     | Topic                 | Decision                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P5-1  | One source of numbers | Every financial figure is read from **posted** journal lines through one report query module; drafts are never included. The dashboard calls the same functions as the reports, so its totals match them by construction (PRD §7, QA "dashboard totals reconcile with reports"). Reports store nothing: the same filters on the same ledger give the same totals.             |
| P5-2  | Dates and timezone    | Financial reports filter on the **accounting date** of the journal; operational reports on the **business date**. Both are hotel dates, so no timezone conversion applies to them; timestamps (audit, exports) are shown in the property timezone (Asia/Karachi by default). Every report response states its currency, timezone, filters, generated-at time and definitions. |
| P5-3  | Property filter       | Reports run for one property; the owner and accountant can also choose **all properties** (every journal entry already carries its property). Users limited to one property see only that one; the server applies the scope, never the screen.                                                                                                                                |
| P5-4  | Report groups         | Accounts gain a **report group** (current asset, fixed asset, current liability, long-term liability, equity, revenue, cost of sales, operating expense, other income/expense) seeded for the default chart and editable by the accountant. It places each account on the balance sheet and in the cash-flow sections; changing it is audited and changes no posted amount.   |
| P5-5  | Profit and loss       | Revenue − cost of sales = gross profit; − operating expenses = operating profit; ± other income and expense = net profit, for a date range. Optional comparison column (previous period of equal length, or same period last year). Year-end closing entries are left out of the P&L, so a range that includes 31 December still shows that year's result.                    |
| P5-6  | Balance sheet         | As of a date: assets = liabilities + equity, with a check line. Equity shows retained earnings plus the **current-year result** computed from the P&L accounts (and the result of any earlier year not yet closed, shown separately), so it balances whether or not a year-end close has run (01 §6).                                                                         |
| P5-7  | Cash flow             | **Direct method** (D13): every line on a cash, bank or card-clearing account is classified by the other side of its journal — receipts from guests, deposits, payments to suppliers, expenses, tax, owner and loans (financing), fixed assets (investing). Transfers between cash accounts net to zero and are shown apart, never as income or expense (Scenario E).          |
| P5-8  | Cashbook              | Per cash account: opening + receipts − payments = closing, day by day, with drill-down to the journal and source document. The sum of the drawers and banks on a ledger account is checked against that account's balance and any difference is shown, never adjusted (01 §8).                                                                                                |
| P5-9  | Receivables           | Guest ledger: open folios (in house) and folios left on account at check-out, with the balance read from the ledger (folio dimension). Aging from the check-out date into buckets (D14). Grouped by guest; grouping by company needs company billing accounts, which are not built — listed as a known limit, not faked.                                                      |
| P5-10 | Payables              | Supplier balances from the ledger (supplier dimension), aged by **due date** (bill date when there is none), with drill-down to each bill and its payments.                                                                                                                                                                                                                   |
| P5-11 | Tax summary           | By tax code and date range: taxable base and tax amount from the tax snapshots on posted folio charges, tied to the tax payable account; recoverable purchase tax from expenses on 1300. Labelled "not a legal filing" (01 §6).                                                                                                                                               |
| P5-12 | Operational metrics   | Rooms available = rooms − out-of-service rooms for each night; rooms sold = occupied room nights; occupancy = sold ÷ available; **ADR** = room revenue ÷ rooms sold; **RevPAR** = room revenue ÷ rooms available. Room revenue is the posted 4000 ledger amount for the nights (which includes the nightly accrual, D9), so it matches the P&L. Definitions shown on screen.  |
| P5-13 | Dashboard             | Role-aware: front desk sees operational cards and panels only; financial cards need `report.financial` and are left out of the response otherwise, not just hidden. Each card has a definition, date range and drill-down to its report. Revenue (posted), cash received, cash balance and profit are separate cards with separate definitions (UX §6.3).                     |
| P5-14 | Exports               | Same endpoint and query as the on-screen report, plus `export.run`; formats per D15. Each export is audited (who, report, filters, row count) and never contains more than the screen would show that user. Files are produced on request and not stored. Background jobs for large files come with the job runner in Phase 6; until then a row limit returns a clear error.  |
| P5-15 | Permissions           | `report.operational` (occupancy, arrivals and departures, housekeeping, cashier closing for one's own shifts) and `report.financial` (statements, cashbook, aging, tax, revenue) are now enforced on every report endpoint; `export.run` on every export. Front desk calling a financial report gets 403 whatever the screen shows (SEC-002).                                 |
| P5-16 | Performance           | A seed script for a 100-room property with a year of fictional activity. Targets from the QA plan: p95 under 500 ms for the dashboard and common reads; statements measured and reported. Indexes added only where the measurements need them.                                                                                                                                |

---

## Slices

### 5.1 Report foundation and financial statements

- **DB `0020_reports`:** `accounts.report_group` (seeded for the default chart, P5-4); indexes for ledger reads by account and accounting date.
- **API:** report query module (posted lines only, property scope, date filters); `GET /reports/profit-loss`, `GET /reports/balance-sheet`, `GET /reports/trial-balance` (the existing one, now permission-checked and with the property filter); `report.financial` enforced.
- **Web:** Reports hub (one filter bar: property, date range, comparison, export menu placeholder); P&L and balance sheet with drill-down to the ledger; report group in the chart of accounts.
- **Tests:** the financial statements recipe (06 §3): opening balances and transactions → TB balances, net profit equals the change in equity, assets = liabilities + equity before and after a year-end close; the same filters twice give the same totals; drafts excluded; reversals net out; front desk 403; isolation.

### 5.2 Cashbook, bank ledger, cash flow, tax and revenue summaries

- **API:** `GET /reports/cashbook` (per cash account, daily), `GET /reports/cash-flow` (direct method, P5-7), `GET /reports/tax-summary`, `GET /reports/revenue` (daily revenue summary by category, and receipts by payment method).
- **Web:** Cashbook with the control-account check; cash flow; tax summary; revenue summary.
- **Tests:** QA scenario E (room revenue, payment, deposit, expense, refund and transfer: revenue never equals cash received, transfers in neither revenue nor expense, every total equals its source journals); cashbook opening + receipts − payments = closing and equals the ledger account; cash flow net change equals the change in cash; tax summary equals the tax payable movement; isolation and role negatives.

### 5.3 Receivables and payables aging

- **API:** `GET /reports/guest-balances` (guest ledger and receivables aging, as of a date), `GET /reports/payables-aging` (as of a date); drill-down endpoints reuse the folio and expense records.
- **Web:** Receivables aging and payables aging with bucket totals and drill-down to the folio, bill and payments.
- **Tests:** bucket boundaries; aging total equals the guest receivable (1200) and accounts payable (2000) balances as of the date; part-paid bills and on-account folios; as-of dates before a payment show the earlier balance; isolation.

### 5.4 Operational reports

- **API:** `GET /reports/occupancy` (occupancy, ADR, RevPAR by night and totals), arrivals and departures, `GET /reports/cashier-closing` (expected vs counted per session, variance, reason, approver), expenses by account and supplier, discrepancies (cash outside shifts, opening count differences, overridden night-audit checks), `GET /reports/audit` (user activity with filters, building on the existing audit viewer).
- **Web:** one page per report under Reports, same filter bar and definitions.
- **Tests:** occupancy with out-of-service rooms; ADR and RevPAR use the same room revenue as the P&L; cashier report equals the closings; a cashier sees only their own sessions; isolation.

### 5.5 Owner dashboard

- **API:** `GET /dashboard` (04 API §3): today's operational figures and the chosen period's financial figures, each with definition and drill-down reference; financial parts only with `report.financial`.
- **Web:** the overview page becomes the dashboard: occupancy, rooms occupied/available/out of service, arrivals, departures, in house, room revenue, total revenue, cash by account, expenses, receivables, profit, cashier close status, pending expense approvals, rooms needing cleaning, reservations without a room, unresolved balances. Comparison with the previous period. No placeholder numbers.
- **Tests:** every dashboard figure equals the matching report for the same filters; front desk receives no financial fields; isolation.

### 5.6 Exports and performance

- **API:** export for every report in the formats of D15, through the same query with `export.run`; audit event per export; row limit with a clear error.
- **Web:** export menu on every report; printable layout for statements.
- **Perf:** 100-room seed script (fictional data only); measured p95 for dashboard and reports, indexes if needed.
- **Tests:** an export matches the on-screen totals; without `export.run` or the report permission → 403; another tenant's filters → nothing; the export is audited; file names carry property and dates; no ID numbers or other sensitive guest fields in exports unless the report itself shows them.

### 5.7 Platform admin (D16)

- **DB `0021_platform`:** platform operators (separate identity table, not tenant users, ADR-0001), tenant status (active, suspended) and room-band plan, operator access grants (tenant, reason, expiry), platform audit events. No billing provider.
- **API:** separate login path for operators with MFA required; `GET /platform/tenants` (04 API §12), change status or plan with a reason; time-bound support access to one tenant, reason-coded and audited (threat model). A suspended tenant's users cannot sign in or call the API.
- **Web:** operator console apart from the hotel app: tenant list, tenant detail with status, plan, usage (rooms, users) and the access log.
- **Tests:** a tenant user can never reach a platform endpoint and an operator token never works on tenant endpoints; suspension blocks sign-in and existing sessions; support access expires and every use is audited; operators see tenant metadata only unless access was granted.

---

## Phase 5 exit gate (executed, not assumed)

FIN-006 (trial balance for a selected period balances; opening + movement = closing); the financial statements
recipe (assets = liabilities + equity, net profit flows into equity, reproducible with identical filters); QA
scenario E end to end; dashboard totals equal the reports; date and timezone filters correct; drafts excluded;
SEC-002 for reports (front desk → 403 on financial reports whatever the UI shows); exports enforce the same
authorization, are audited and cannot cross tenants; isolation on every new endpoint; performance measured on the
100-room dataset; dashboard and reports usable at 360/768/1280 px; platform admin kept apart from tenant access (5.7 tests). Playbook gate: the permission and financial
acceptance matrix passes.

## Owner decisions (2026-10-21)

| #   | Question                                | Decision                                                                                             |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| D13 | Cash-flow method                        | **Direct method** (receipts and payments by type), read from the cash lines                          |
| D14 | Aging buckets                           | **Current, 1–30, 31–60, 61–90, over 90 days**                                                        |
| D15 | Export formats                          | **CSV and Excel** files from the server; PDF via the printable report page (server PDF later, as D8) |
| D16 | Platform admin (Phase 0 placed it here) | **Stays in Phase 5** as slice 5.7, after exports (overrode moving it to Phase 6)                     |

Also for your accountant: the report group of each account (P5-4) and the P&L layout.

## Order

5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6 → 5.7. The dashboard comes after the reports it reuses. Work continues on
branch `phase-1-foundation`.
