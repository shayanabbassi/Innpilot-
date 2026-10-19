# Phase 2 exit report — hotel operations

Date: 2026-10-20 · Branch: `phase-1-foundation` · Plan: [phase-2-plan.md](phase-2-plan.md)

## Slices delivered

| Slice | Scope                                                                                          | Commit  |
| ----- | ---------------------------------------------------------------------------------------------- | ------- |
| 2.1   | Tenant provisioning CLI (D1), property onboarding wizard                                       | d9ce79c |
| 2.2   | Room types, rooms incl. bulk create, base rates, room board                                    | 85c90b5 |
| 2.3   | Guest profiles, duplicate detection, optional encrypted identity documents with audited reveal | cab01db |
| 2.4   | Reservations, availability, database-enforced double-booking prevention, calendar, history     | 1d53107 |
| 2.5   | Check-in with readiness checks and manager override, walk-ins, room moves, front desk Today    | cb7929f |
| 2.6   | Housekeeping tasks and board, inspection, maintenance, dated out-of-order periods              | 7a3104a |
| 2.7   | Interim business-date close (D3)                                                               | 736a3e4 |

Check-out is deferred to Phase 3 (D4); OPS-003 is a Phase 3 gate.

## Test run (executed 2026-10-20 against local Postgres 16)

`pnpm lint`, `typecheck`, `test`, `build` and `test:integration`: all successful.

- Unit: 125 (money 25, contracts 45, web 18, api 37)
- Database: 163 (db integration 48, API end-to-end 115)

## Exit gate

| Gate item                                                 | Status         | Evidence                                                                                                                                                                                                                 |
| --------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| OPS-001 concurrent bookings                               | Passed         | `reservations.e2e` "OPS-001: concurrent bookings"; exclusion constraint on `reservation_rooms`                                                                                                                           |
| OPS-002 room readiness                                    | Passed         | `stays.e2e` "OPS-002: room readiness" (out-of-order and dirty rooms blocked; manager override needs a reason and is audited)                                                                                             |
| Reservation to check-in (Scenario A steps 1–4)            | Passed         | `reservations.e2e` availability and booking, `stays.e2e` check-in; also run by hand in the browser in slices 2.4–2.5                                                                                                     |
| Interim day close cannot double-advance                   | Passed         | `day-close.e2e`: replay with the same key, stale date returns 409, 5 simultaneous closes produce exactly 1; `day-close.integration`: unique key and one-day check in the database                                        |
| Cross-tenant denial on rooms, guests, reservations, stays | Passed         | Permissions and isolation suites in `rooms`, `guests`, `reservations`, `stays`, `housekeeping` and `day-close` e2e; `isolation.e2e` (SEC-001)                                                                            |
| Identity data not in search results                       | Passed         | `guests.e2e` "finds the guest … without document data"; numbers returned masked to the last 4 characters                                                                                                                 |
| Identity data not in audit records                        | Passed         | `guests.e2e` checks that no audit row for the tenant contains the number, including after a reveal                                                                                                                       |
| Identity data not in application logs                     | Not tested     | By configuration only: request bodies are not logged, and `LOG_REDACT_PATHS` covers `*.number`, `*.numberEnc` and `*.document`. No automated test captures log output.                                                   |
| Primary flows usable at 360 / 768 / 1280 px               | Partly checked | Each slice was checked in the browser pane at its current width (narrow, about 500 px) and the layouts are responsive by design. A recorded pass of every primary flow at exactly 360, 768 and 1280 px has not been run. |

## Known limits carried forward

- The day close is operational only. Room-and-tax posting and the full night audit (OPS-004) arrive with the ledger in Phase 3–4.
- Check-out (OPS-003) is in Phase 3.
- Identity document handling needs a local legal review before a pilot (D2).
