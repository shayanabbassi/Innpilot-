# Phase 5 — performance on a 100-room property (P5-16)

Date: 2026-10-21 · Run: `pnpm --filter @innpilot/api test:perf` (`apps/api/perf/reports.perf.test.ts`)

## Dataset

A fresh database with one 100-room property and a year of fictional activity (2025-10-19 to 2026-10-18, business
date 2026-10-19), written as posted, balanced journals so the database's own guards checked every entry:

- 12,134 two-night stays (about two-thirds occupancy), 24,268 room nights accrued by the night audit (D9)
- 24,391 journal entries and 49,512 lines: nightly accruals, check-out bills, payments (cash and bank),
  daily expenses; one stay in twenty left on account for the aging report
- 29,200 audit events; 3,000 guests named "Perf Guest nnnn"

## Method and environment

Each read was called 2 times to warm up, then 20 times in a row through the real API (session, guard, row-level
security, JSON envelope), timed from the test process. Local development machine: Windows 11, Postgres 16 in
Docker Desktop, API and database on the same machine. Absolute times on production hardware will differ; the run
is for finding slow queries and checking the QA target (p95 under 500 ms for the dashboard and common reads).

## Results (final run)

| Read                                  | Kind   | p50 ms | p95 ms | max ms |
| ------------------------------------- | ------ | ------ | ------ | ------ |
| Dashboard (month to date)             | common | 314    | 382    | 392    |
| Reservations list (30 days)           | common | 24     | 26     | 30     |
| Room board                            | common | 27     | 29     | 29     |
| Trial balance (year)                  | report | 131    | 151    | 157    |
| Profit and loss (year, compared)      | report | 176    | 194    | 200    |
| Balance sheet                         | report | 142    | 151    | 154    |
| Cashbook (month)                      | report | 81     | 93     | 96     |
| Cash flow (year)                      | report | 248    | 298    | 370    |
| Revenue summary (month)               | report | 82     | 92     | 94     |
| Tax summary (year)                    | report | 32     | 36     | 37     |
| Guest balances                        | report | 232    | 298    | 298    |
| Supplier balances                     | report | 31     | 33     | 34     |
| Occupancy (month)                     | report | 173    | 193    | 205    |
| Occupancy (year)                      | report | 224    | 258    | 281    |
| Arrivals and departures (month)       | report | 85     | 173    | 184    |
| Cash closings (month)                 | report | 23     | 25     | 47     |
| Expenses (month)                      | report | 28     | 44     | 50     |
| Discrepancies (month)                 | report | 75     | 84     | 85     |
| User activity (month)                 | report | 27     | 28     | 28     |
| Export: profit and loss, Excel (year) | report | 203    | 239    | 306    |
| Export: guest balances, CSV           | report | 255    | 349    | 367    |

The dashboard and the common reads are under 500 ms at p95; so is every report and export.

## What the measurements changed

| Finding (first run)                                                                                                                       | Change                                                                                                                                     | Effect                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Occupancy took 1.3 s for a month and 1.6 s for a year: room revenue and nights sold were looked up once per night against a year of lines | Revenue and nights sold aggregated once over the range and joined to the nights; index `room_revenue_accruals (property_id, night)` (0021) | Month 1,453 → 193 ms p95; year 1,734 → 258 |
| The dashboard took 1.7 s, mostly the occupancy report, and read the same cashbook twice                                                   | Occupancy fix; financial reads start together with the operational ones; one cashbook read when the period ends today                      | 1,740 → 382 ms p95                         |
| Cashbook: one opening-balance subquery per account and a full scan of every cash ledger line for the ledger check                         | One pass over the tagged lines for opening and closing; the check reads only untagged lines, with a partial index (0021)                   | 200 → 93 ms p95                            |
| Guest balances joined guests and reservations for every folio before leaving out the settled ones                                         | Filtered before the joins (folios whose receivable and deposits offset are kept for the ledger tie, and a test now covers that case)       | about the same (the aggregation dominates) |

Results were the same before and after each change: the report and dashboard end-to-end tests ran after every
step. One run in the middle was slowed by the machine (every read about twice as slow) and was discarded.

## Not covered

- Many users at once: the run is one user, one request at a time. Load under concurrency is part of Phase 6
  (deployment and load test on the 100-room dataset).
- Exports above the 50,000-row limit are refused (EXPORT_TOO_LARGE) rather than measured; background exports come
  with the job runner in Phase 6.
