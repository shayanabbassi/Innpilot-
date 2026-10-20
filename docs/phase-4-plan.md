# Phase 4 — Accounting operations: slice plan

Status: **Decisions recorded 2026-10-20 (D9–D12) — awaiting go-ahead for slice 4.1** · Builds on: Phase 3
(accepted 2026-10-20, c802f54)

Scope: cash and bank accounts with transfers and opening balances, cashier shifts with counted cash and variance,
suppliers and expenses with payables, bank reconciliation, the full night audit (replacing the interim day close),
and month-end and year-end close. Sources: 01 Accounting & Ledger spec §3–8, PRD §6.6–6.7, 03 Data dictionary
§6–7, 04 API spec §9–10, 05 QA scenarios B and E, 06 acceptance matrix (CASH-001, OPS-004).

**Already in place from Phase 3:** posting service, chart of accounts, journals and reversals, monthly periods with
close/reopen, trial balance, cash accounts (drawer, bank, card clearing), payments, refunds, deposits.
**Phase 5:** P&L, balance sheet, cashbook and aging _reports_, dashboards, exports. Phase 4 builds the records and
screens those reports will read, and only the views each slice needs to be usable.

Every slice ships as before: migration, API in the OpenAPI contract, UI with all states, server-side permissions,
audit events, unit + Postgres integration + e2e tests with tenant and role negatives, all checks, browser check,
one commit.

---

## Design decisions (defaults unless you say otherwise)

| #     | Topic               | Decision                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P4-1  | Cash movements      | No second copy of the money: the cashbook is read from journal lines, which gain a **cash account** dimension (as they gained the folio in 3.3). Every payment, refund, expense payment, transfer and variance line on a cash account carries it.                                                                                                                                                                        |
| P4-2  | Transfers           | One journal per transfer (Dr receiving account, Cr sending account, both tagged), so a transfer is never income or expense (PRD §6.6, Scenario B). Card-clearing settlements are transfers to the bank with the card fee posted to bank charges.                                                                                                                                                                         |
| P4-3  | Opening balances    | A one-time opening-balance journal per tenant (accounts and amounts entered by the accountant, difference to a system **Opening balance equity** account), dated the day before go-live. Guest and supplier balances can be opened the same way.                                                                                                                                                                         |
| P4-4  | Cashier shifts      | Shifts are **optional** (D11): cash can be taken or paid out at any time. When a user has a shift open, the cash they take or pay out on that drawer is linked to it, and expected cash = opening count + cash in − cash out of that shift. Cash recorded outside any shift is listed in the night audit summary so it is never invisible. One open shift per user and per drawer.                                       |
| P4-5  | Closing a shift     | The cashier enters the counted cash; variance = counted − expected. Any variance needs an explanation; above a per-property threshold (default Rs 500) it needs approval by `cashier.approve`. Approval posts the variance to **Cash over and short** (6970). A submitted or approved closing is locked; reopening needs a new owner-only permission, a reason, and is audited.                                          |
| P4-6  | Expenses            | Two flows (data dictionary: "distinguish cash-paid expense from credit supplier bill"): **cash expense** — paid now from a cash account (Dr expense, Cr cash); **supplier bill** — approved into accounts payable (Dr expense, Cr 2000), then paid in one or more payments (Dr 2000, Cr cash/bank). States: draft → submitted → approved → paid (bills: partly paid). The approver cannot be the creator.                |
| P4-7  | Expense tax         | Tax on a purchase is entered as an amount. If marked recoverable it posts to **Tax recoverable** (1300), otherwise it is part of the expense. Whether it is recoverable is the hotel's call with its tax adviser; nothing is assumed.                                                                                                                                                                                    |
| P4-8  | Bank reconciliation | Per bank account and statement date: enter the statement balance, tick the ledger lines that appear on the statement; the difference must be zero to finish, or explained (recorded, never silently adjusted). Ticked lines are locked to that reconciliation. Statement import (CSV) comes later.                                                                                                                       |
| P4-9  | Night audit         | Replaces the interim day close (D3) and keeps its once-per-date guarantee (OPS-004). Adds checks for open cashier shifts, no-shows holding deposits (asks refund or fee — closing the Phase 3 known limit), folios left on account, and the room-revenue step of D9; stores a summary (revenue by category, occupancy, arrivals and departures, receipts by method, cashier variances). Override needs a manager reason. |
| P4-10 | Month-end close     | A checklist before closing a month: every business date closed by the night audit, no draft journals, all cashier shifts closed and approved, bank reconciliations done to month end. Blockers vs warnings; warnings need a reason. Reopen stays as in 3.1 (permission, reason, audited).                                                                                                                                |
| P4-11 | Year-end close      | Fiscal year = **calendar year** (D10). Posts the closing entry on 31 December: revenue, cost and expense accounts to **Retained earnings** (3100), so the next year starts with them at zero; the trial balance then shows year-to-date figures. Reversible only by reopening the year (owner, reason, audited).                                                                                                         |
| P4-12 | New permissions     | `cash.transfer` (owner, manager, accountant, cashier; added in 4.1), `cashier.reopen` (owner), `bank.reconcile` (owner, accountant), `supplier.manage` (owner, accountant, manager). Existing `cashier.operate`, `cashier.approve`, `expense.*`, `period.*` are used as named.                                                                                                                                           |

---

## Slices

### 4.1 Cash and bank accounts, transfers, opening balances

- **DB `0014_cash`:** cash-account dimension on journal lines (backfilled for Phase 3 payments and refunds); more cash accounts (petty cash, several banks); system account **Opening balance equity**; opening-balance batch record.
- **API:** manage cash accounts; `GET /cash-accounts/{id}/movements` (running balance from the ledger); `POST /transfers`; `POST /finance/opening-balances` (once, idempotent).
- **Web:** Cash & bank (balances, movements per account, transfer form); opening balances wizard for the accountant.
- **Tests:** transfer is one balanced journal with no revenue or expense lines (Scenario B step 4); movements equal ledger; opening balances balance via the equity account and can be entered only once; isolation.

### 4.2 Cashier shifts and closing — **CASH-001 gate; QA scenario B**

- **DB `0015_cashier`:** `cashier_shifts` (user, drawer, opening count, status), `cash_closings` (expected, counted, variance, explanation, submitted, approved, locked); shift link on cash journal lines; property setting for the variance threshold.
- **API:** `POST /cashier-shifts/open`, `GET /cashier-shifts/current`, `POST …/submit-closing`, `POST …/approve-closing`, `POST …/reopen`; payments, refunds and cash expenses by a user with an open shift are linked to it (shifts are optional, D11; cash outside a shift is reported, not refused).
- **Web:** "My shift" (open with count, live expected cash, close with count and explanation); approvals queue for managers; shift history.
- **Tests:** expected = opening + receipts − payouts (cash only; card and bank excluded); variance needs a reason, above the threshold needs approval, approval posts over/short once; closing locked after submit; reopen owner-only with reason and audit; one open shift per user and drawer under concurrency.

### 4.3 Suppliers, expenses and payables

- **DB `0016_expenses`:** `suppliers`, `expense_vouchers` (+ lines with expense account, amount, tax, recoverable flag), `expense_payments`; voucher numbers per property; attachment reference (D12).
- **API:** suppliers CRUD; `GET/POST /expenses`, `PATCH` (draft only), `submit`, `approve`, `pay` (cash expense or bill payment, partial allowed), `void` (before payment, reversal after posting).
- **Web:** expense entry (phone-friendly for petty cash), approvals, supplier list with what is owed, pay bill.
- **Tests:** cash expense posts Dr expense / Cr cash in one step; bill posts to payables on approval and payments clear it; partial payments never exceed the bill; creator cannot approve; recoverable tax to 1300; edits refused once submitted; idempotent pay.

### 4.4 Bank reconciliation and card settlements

- **DB `0017_reconciliation`:** `bank_reconciliations`, `reconciliation_items` (journal line, unique — a line is reconciled once).
- **API:** start, tick or untick lines, finish (difference zero or explained); card settlement (clearing → bank with fee).
- **Web:** reconciliation screen (unreconciled lines, statement balance, running difference), history.
- **Tests:** a line cannot be in two reconciliations; finishing with a difference needs an explanation; the reconciled balance equals the ledger; card fees go to bank charges; isolation.

### 4.5 Night audit — **OPS-004 gate**

- **DB `0018_night_audit`:** extends the close record with the audit summary and check results; nightly room-revenue accrual (D9) keyed by stay room and night: Dr **Unbilled guest revenue** (new system asset account), Cr room revenue, net of tax. At check-out the room-night posting then clears the unbilled amount instead of crediting revenue again, and tax is charged on the guest's bill as now. Room revenue lands in the night it was earned; tax at billing (accountant to confirm).
- **API:** preview and run (replaces `/day-close`, which stays as an alias for one release); per-check override with reason.
- **Web:** the Day close screen becomes Night audit (checks, summary, run); history with the stored summaries.
- **Tests:** running twice for a date posts nothing twice and advances once (OPS-004); open shifts block unless overridden; no-shows with deposits need a decision; summary totals equal the ledger for that date.

### 4.6 Month-end and year-end close

- **DB `0019_close`:** fiscal year setting (D10), year-end close record.
- **API:** month-end checklist and close; year-end preview and close; year reopen (owner, reason).
- **Web:** Periods screen gains the checklist; year-end close with the closing entry preview.
- **Tests:** blockers stop the close, warnings need a reason; the year-end entry zeroes P&L accounts into retained earnings and the trial balance still balances; posting into a closed year is refused; reopen audited.

---

## Phase 4 exit gate (executed, not assumed)

CASH-001; OPS-004; QA scenario B end to end (open shift → cash payment → cash expense → transfer → expected cash →
count → explained and approved variance); transfers never touch revenue or expense; expense to payment with
source-linked journals; reconciliation leaves no unexplained difference; month-end checklist and year-end close keep
the trial balance balanced; closed periods and locked closings refuse changes; reopen paths need permission, reason
and audit; isolation on every new endpoint; shift close and expense entry usable at 360/768/1280 px.

## Owner decisions (2026-10-20)

| #   | Question                                    | Decision                                                                                              |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| D9  | Room revenue in the ledger before check-out | **Nightly accrual** at the night audit (unbilled revenue); folios still post nights at check-out (D7) |
| D10 | Fiscal year                                 | **January–December** (calendar year)                                                                  |
| D11 | Cash without an open cashier shift          | **Allowed**: shifts are optional; cash outside a shift shows in the night audit summary               |
| D12 | Expense receipts and bills (attachments)    | **Reference only** for now; scanned files come with file storage in Phase 6                           |

Also for your accountant: the variance threshold, the opening balances, and whether purchase tax is recoverable.

## Order

4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6. 4.2 and 4.5 are the largest. Work continues on branch `phase-1-foundation`.

## Notes from the build

- **4.1:** new cash accounts post to the system ledger account for their kind (1000, 1100, 1150) unless another
  asset account is chosen; several drawers or banks can share one ledger account and are told apart by the cash
  dimension. A cash ledger line must name its drawer or bank when the property has more than one on that ledger
  account. Permission `cash.transfer` added (owner, manager, accountant, cashier).
- **4.2 (P4-4 refined):** cash is linked to the shift **open on the drawer**, whoever records it, not only to the
  cash the shift's own cashier records. The drawer physically holds all of it, so this is what makes expected cash
  match the count; with one open shift per drawer there is never a doubt which shift it belongs to. Cash recorded
  while no shift is open on the drawer stays outside any shift (D11).
- **4.2:** a variance within the threshold is accepted at once and posted on submit; above it, the closing waits for
  someone other than the submitter with `cashier.approve`, and the variance is posted on approval. Reopening
  (owner, `cashier.reopen`, reason) reverses any posted variance and opens the shift again; the reopened closing
  stays as history. The threshold is a property setting (default Rs 500), changed with `property.manage`.
- **4.2:** the opening count is compared with the drawer's ledger balance; a difference is shown on the shift, not
  posted. The night audit (4.5) will list it with cash recorded outside any shift.
