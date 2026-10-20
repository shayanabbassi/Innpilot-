# Phase 3 — Ledger core, folios, payments and check-out: slice plan

Status: **Decisions recorded 2026-10-20 (D5–D8) — awaiting go-ahead for slice 3.1** · Builds on: Phase 2 (accepted 2026-10-20, eca0185)

Scope: the double-entry ledger core (moved here from Phase 4 at the Phase 0 approval), then tax setup, guest folios,
payments/deposits/refunds, and check-out with settlement and invoices (deferred here from Phase 2 by D4).
Sources: 01 Accounting & Ledger spec, 03 Data dictionary §5–6, 02 Migration plan (003/004), 04 API spec §7–8,
03 Workflows §4–6, 06 Acceptance matrix, 05 QA scenarios A and C.

**Not in Phase 3** (Phase 4): cashier sessions and variance (CASH-001), expenses/vendors/payables, bank
reconciliation, full night audit checks, period-end close workflow beyond open/close/reopen. **Phase 5:** P&L,
balance sheet, cashbook, aging and tax summary reports (Phase 3 ships only the trial balance it needs to prove the
ledger).

Every slice ships the same way as Phase 2: migration, API in the OpenAPI contract, UI with loading, empty, error,
denied and conflict states, server-side permissions, audit events, unit + Postgres integration + e2e tests including
tenant and role negatives, all checks green, browser check, one commit.

---

## Design decisions (defaults unless you say otherwise)

| #     | Topic                        | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3-1  | One posting path             | Every money event goes through one `PostingService` that builds journal lines from server-side rules. Clients never choose debit/credit lines, except manual journals (`journal.post`). Source record and its journal are written in **one transaction**; if either fails, neither exists.                                                                                                                                                                                                |
| P3-2  | Balance enforced twice       | The service rejects unbalanced entries (FIN-001, `JOURNAL_UNBALANCED`), and the database does too: a deferred constraint trigger checks Σdebit = Σcredit and ≥ 2 lines at commit. Line `CHECK (debit ≥ 0 AND credit ≥ 0 AND NOT (debit > 0 AND credit > 0))`.                                                                                                                                                                                                                             |
| P3-3  | Immutability                 | Posted entries and lines cannot be updated or deleted (trigger, as for audit). Corrections are reversals: an equal and opposite entry referencing the original (FIN-004). Drafts (manual journals only) can be edited until posted.                                                                                                                                                                                                                                                       |
| P3-4  | No double posting            | Unique `(source_type, source_id, purpose)` on journal entries, plus `Idempotency-Key` on every money route (FIN-003). A retry returns the original result.                                                                                                                                                                                                                                                                                                                                |
| P3-5  | Dates                        | `accounting_date` = the property's **business date** at posting, separate from `created_at`. Monthly fiscal periods per tenant, created on demand. Posting into a closed period → `409 PERIOD_CLOSED` (FIN-005); reopening needs `period.reopen` plus a reason and is audited.                                                                                                                                                                                                            |
| P3-6  | Chart of accounts            | Tenant-wide chart seeded from the spec's starter template (codes 1000–7999) when a tenant is created, and backfilled for existing tenants. **System accounts** (guest receivable, guest deposits, room revenue, cash on hand, bank, card clearing, tax payable, write-off, rounding…) are mapped by role, cannot be deleted or deactivated, and can be renamed. Hotels can add their own accounts. The template needs review by a Pakistan-based accountant before pilot.                 |
| P3-7  | Money precision              | Stored as NUMERIC(19,4); **every posted amount is rounded to the currency's minor unit** (paisa for PKR, D5), half-up, and the DB checks that scale. Rounding differences on a document go to a system rounding account so entries always balance exactly.                                                                                                                                                                                                                                |
| P3-8  | Tax                          | Per-property **tax codes** with effective-dated rates (percent), inclusive/exclusive flag and payable account. **Charge categories** (room, F&B, laundry, transport, other…) map to a revenue account and default tax codes. No rates are shipped; a blank tax setup is valid. Each charge stores a **tax snapshot** (code, rate, base, amount), so later edits never change posted documents (TAX-001). Changes to tax setup are audited.                                                |
| P3-9  | Folios                       | One folio per reservation by default, created on first need (deposit or check-in); extra folios for split billing. Sign convention: **balance = charges + tax − allowances − payments + refunds**, positive = guest owes. Folio states: `open` → `settled` / `on_account`. Every item has a source record, status and journal link.                                                                                                                                                       |
| P3-10 | Room revenue (D7)            | **All room-nights are posted at check-out** (owner decision D7), each keyed by (stay room, night) so a retry or second check-out can never charge twice. During the stay the folio shows the nights so far as **pending room charges** (calculated with the booked rate and current tax, clearly marked unposted) so the balance due is visible. Revenue therefore lands on the check-out date: a stay across month-end is recognised in the check-out month (noted for your accountant). |
| P3-11 | Corrections on folios        | A charge is never deleted. **Void** posts a reversal; **allowance/discount** posts a reduction with a reason; **transfer** moves an item to another open folio keeping both links. All need `folio.adjust`.                                                                                                                                                                                                                                                                               |
| P3-12 | Payments                     | Methods: cash, bank transfer, card (manual, terminal reference only; no card data stored), other. Each method maps to a cash/bank/clearing account. Received **before check-in**: Dr cash/bank, Cr **guest deposits** (liability, FIN-007). **During stay**: Cr guest receivable. Deposits are applied to the receivable at check-out (Dr deposits, Cr receivable), only up to the deposit balance. Over-payment is held as a credit until refunded.                                      |
| P3-13 | Refunds                      | Linked to the original payment; total ≤ remaining refundable (`REFUND_EXCEEDS_REMAINDER`); `payment.refund` plus a reason; original records kept (Scenario C).                                                                                                                                                                                                                                                                                                                            |
| P3-14 | Check-out (OPS-003, FIN-008) | Allowed only when the folio balance is zero after: taking payment, refunding a credit, **write-off** (`folio.adjust`, reason; Dr write-off expense, Cr receivable) or **transfer to account** (balance stays in the guest receivable, folio state `on_account`, later payments allowed). Check-out ends the stay, marks the room dirty and creates the cleaning task exactly once.                                                                                                        |
| P3-15 | Cancellations with deposit   | Cancelling or no-showing a reservation with a deposit needs a choice: refund, or keep it as a cancellation/no-show fee (posted as revenue, `folio.adjust`, reason).                                                                                                                                                                                                                                                                                                                       |
| P3-16 | Document numbers             | Invoices and receipts get **gapless** numbers per property and series from a locked counter row, safe under concurrency (QA concurrency case). Prefix and starting number are configurable. Journal numbers: per tenant, unique.                                                                                                                                                                                                                                                          |
| P3-17 | Invoices (D8)                | Issued at check-out from the folio, frozen at issue (lines, tax snapshot, legal details). Invoice profile per property: legal name, registration fields as label/value pairs (none hardcoded), address, footer. Not a certified tax invoice; local review needed (D2-style note).                                                                                                                                                                                                         |
| P3-18 | Cash accounts                | Phase 3 creates cash drawer, bank and card-clearing accounts per property, mapped to COA accounts. **Cashier sessions are Phase 4**; until then cash payments post to the drawer account without a session, and Phase 4 adds the "open session required" rule.                                                                                                                                                                                                                            |

---

## Slices

### 3.1 Ledger core — **FIN-001, FIN-002, FIN-004, FIN-005, FIN-006 gates**

- **DB `0009_ledger`:** `accounts` (code, name, class, normal balance, parent, active, system role), `fiscal_periods`, `journal_entries`, `journal_lines`, `document_sequences`; balance and immutability triggers; template seeding function used by `tenant:create` and a backfill for existing tenants.
- **API:** `GET/POST/PATCH /finance/accounts`; `GET /finance/journal-entries`, `POST …/draft`, `POST …/{id}/post`, `POST …/{id}/reverse`; `GET /finance/ledger?accountId&from&to`; `GET /finance/trial-balance?from&to`; `GET/POST /finance/periods/{id}/close|reopen`.
- **Web:** Accounts (chart), Journals (list, detail, manual entry form with live balance), Trial balance, Periods.
- **Tests:** unbalanced rejected by service **and** by the DB when inserted directly; posted entry cannot be edited or deleted; reversal is equal and opposite and links back; closed period blocks posting until reopen with reason (audited); trial balance debits = credits and reproducible; idempotent post; system accounts protected; accountant/owner allowed, front desk 403; cross-tenant 404.

### 3.2 Tax codes, charge categories and invoice profile — **TAX-001 gate**

- **DB `0010_tax`:** `tax_codes`, `tax_rates` (effective_from, percent, inclusive), `charge_categories` (revenue account, default tax codes), `invoice_profiles`.
- **API:** CRUD under `/properties/{id}/tax-codes`, `/charge-categories`, `/invoice-profile` (`tax.configure`); a preview endpoint that calculates tax for an amount and date.
- **Web:** Settings → Taxes & charges, Invoice details.
- **Tests:** rate chosen by service date; inclusive and exclusive maths with rounding; editing a rate after a charge leaves the charge's snapshot unchanged (TAX-001); blank setup gives zero tax; audit of every change (AUD-001 part).

### 3.3 Folios and charges

- **DB `0011_folios`:** `folios`, `folio_charges` (category, service date, qty, unit price, net, tax, gross, source, status, journal link), `folio_charge_taxes` (snapshot), `room_night_charges` (unique per stay room and night, filled at check-out).
- **API:** `GET /folios/{id}`, `GET /reservations/{id}/folios`, `POST /folios` (extra folio), `POST /folios/{id}/charges`, `POST /folio-charges/{id}/void`, `POST /folios/{id}/adjustments`, `POST /folio-charges/{id}/transfer`.
- **Pending room charges:** the folio API returns nights stayed so far as unposted lines with their calculated tax; nothing is posted until check-out (D7). The day close is unchanged.
- **Web:** folio panel on the reservation and Front desk (balance, items with source and status, add charge, void, discount, transfer).
- **Tests:** folio balance formula; each charge posts Dr receivable / Cr revenue + tax payable and balances; void reverses and never deletes; pending room charges shown but never posted before check-out; transfers keep both links; closed folio rejects charges (`FOLIO_CLOSED`); front desk can charge but not adjust; isolation.

### 3.4 Payments, deposits and refunds — **FIN-003, FIN-007 gates; QA scenario C**

- **DB `0012_payments`:** `cash_accounts`, `payments` (method, amount, received business date, account, external reference, status, idempotency key), `payment_allocations`, `refunds`; allocation ≤ payment amount.
- **API:** `POST /payments`, `GET /payments/{id}`, `GET /payments?from&to`, `POST /payments/{id}/refunds`, `GET /refunds/{id}`; receipt numbering.
- **Web:** take payment (from folio, reservation and check-in), deposit on a reservation, refund dialog, printable receipt.
- **Tests:** 10 parallel retries with one key → one payment and one journal (FIN-003); deposit posts to the liability, not revenue (FIN-007); refund above remainder rejected; partial refund links to original; cancellation with deposit requires refund or fee; card details never accepted; isolation and roles.

### 3.5 Check-out, settlement and invoices — **FIN-008, OPS-003 gates; QA scenario A complete**

- **DB `0013_checkout`:** `invoices`, `invoice_lines` (frozen copy), folio settlement fields; stays/reservations reach `checked_out`.
- **API:** `GET /stays/{id}/checkout-preview` (posted charges, room-nights to post with tax, deposits to apply, balance), `POST /stays/{id}/check-out` posts the room-nights and settles in one transaction, with a settlement choice (pay, refund credit, write-off, transfer to account); `GET /folios/{id}/invoices`, `GET /invoices/{id}`, printable invoice.
- **Web:** check-out flow from Front desk "Due out" (preview → settle → invoice), works at 360 px; Front desk gains check-out; day close stops flagging stays that were checked out.
- **Tests:** unpaid balance blocks check-out unless settled, written off or transferred (FIN-008); check-out ends the stay, room becomes dirty, one cleaning task (OPS-003), and a retry changes nothing; every night of the stay posted exactly once with its tax snapshot, including after a room move (each segment at its own rate); deposits applied only up to the deposit balance; invoice numbers unique and gapless under 20 concurrent check-outs; invoice frozen after a later tax change.

---

## Phase 3 exit gate (executed, not assumed)

FIN-001 to FIN-008, TAX-001, OPS-003; QA scenario A run from reservation to check-out and scenario C (refund and
correction); **folio reconciliation recipe**: for a stay with room charges, an extra service, tax, a partial
deposit, a payment and a partial refund, the folio balance, the journal lines and the trial balance all agree;
cross-tenant attempts on folio, payment, invoice and journal endpoints are denied; tax and period changes audited;
check-out and payment usable at 360/768/1280 px.

## Owner decisions (2026-10-20)

| #   | Question                                   | Decision                                                                                            |
| --- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| D5  | Rounding of posted amounts                 | **Paisa (2 decimals)**, half-up; rounding differences to a rounding account                         |
| D6  | New room rates: tax-inclusive or exclusive | **Exclusive** (tax added on top), changeable per tax code                                           |
| D7  | When room revenue is posted                | **All nights at check-out** (P3-10); pending room charges shown during the stay                     |
| D8  | Invoice output in Phase 3                  | **Printable invoice page** (print / save as PDF from the browser); server-generated PDF files later |

Also for your accountant (not blocking the build): the chart-of-accounts template, deposit and revenue-recognition
policy, write-off policy, and which taxes apply to which charges.

## Order

3.1 → 3.2 → 3.3 → 3.4 → 3.5. 3.1 and 3.5 are the largest. Work continues on branch `phase-1-foundation`.

## Notes from the build

- **3.3:** room-night pending charges count from the actual check-in date of each booked-room segment, at that
  segment's agreed rate; moves split segments at the business date.
- **3.4:** a payment belongs to one folio; a split payment is recorded as several payments, each with its own
  receipt. Applying a deposit to the bill is its own append-only record (`deposit_applications`, Dr guest deposits /
  Cr guest receivable), used at check-out and when a deposit is kept as a fee. The folio reconciliation is: folio
  balance = the folio's guest receivable + guest deposit lines in the ledger. A folio can take at most its balance plus
  the room nights still to post; refunds are limited by the payment's remainder and by the guest's credit.
- **Known limits carried into 3.5:** (1) the day close's automatic no-show marking leaves any deposit held (as if
  "refund" was chosen); staff can keep it as a fee afterwards with _forfeit deposit_. (2) A credit created by voiding
  a fee after its deposit was applied cannot yet be refunded, because refunds draw only on unapplied money;
  check-out settlement (3.5) handles refunds of a folio credit.
