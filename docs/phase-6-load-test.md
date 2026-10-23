# Load test

Status: slice 6.7 (2026-10-22). P6-10 and QA §5: "p95 common API reads under 500 ms excluding heavy reports;
booking and payment writes remain consistent under concurrent load", plus the QA concurrency cases (simultaneous
room booking, duplicate payment retries, competing document numbering).

## How it runs

`pnpm --filter @innpilot/api test:perf load` (needs Docker for k6, and the local database and storage):

1. Seeds the 100-room year (`apps/api/perf/hundred-rooms.ts`: 12,134 reservations, 24,268 room nights, 24,391
   journals, 29,200 audit events), adds 20 front desk and 8 cashier users, and signs everyone in for real.
2. Serves the API and runs `apps/api/load/hotel.k6.js` with k6 (Docker):
   - **front desk**, 20 people, one action a second: today's arrivals and departures, the room board,
     availability, booking and guest searches, folios; one action in eight books a stay and takes a deposit, the
     deposit request sent twice with one idempotency key, as a retry after a dropped connection would;
   - **cashier**, 8 people, every 2 seconds: payments, folios, cash accounts;
   - **reporting**, 4 people, every 3 seconds: dashboard, profit and loss, cashbook, occupancy, guest balances;
   - **last-room burst** at 60 s: 30 people book the hotel's last free room for the same nights at once;
   - **payment retry burst** at 90 s: 20 copies of one deposit request, same idempotency key, at once.
3. Checks the database afterwards and writes `apps/api/load/out/results.md`.

The API runs in the test process with production code and the restricted database role, one Node process and a
pool of 10 database connections (the defaults). Two settings differ from production: plain http, and rate limits
off (all load comes from one address, which production would rightly throttle). The sessions written for k6 are
cleared from disk when the run ends.

## Results, 2026-10-22, local (laptop, Docker Desktop)

184 s of load, 4,933 requests (27 per second), no unexpected responses, every k6 check passed.

| Requests                                   | p50    | p95    | p99    | max    | Target    |
| ------------------------------------------ | ------ | ------ | ------ | ------ | --------- |
| Common reads                               | 95 ms  | 232 ms | 294 ms | 494 ms | p95 0.5 s |
| Bookings and payments                      | 124 ms | 340 ms | 458 ms | 717 ms | p95 1 s   |
| Dashboard and reports (heavy, informative) | 293 ms | 635 ms | 713 ms | 905 ms | p95 3 s   |

| Consistency after the run                       | Result                                                    |
| ----------------------------------------------- | --------------------------------------------------------- |
| No room type sold beyond its rooms on any night | ok (120 nights checked, every room type)                  |
| Last room: 30 bookings at the same moment       | 1 confirmed, 29 refused as full                           |
| One deposit retried 20 times with one key       | 1 payment, 1 journal                                      |
| Every deposit sent twice (411 bookings)         | 411 payments for 411 keys: no duplicate money             |
| Receipt numbers under concurrency               | 411 receipts, RCT-000001 to RCT-000411, no gap, no repeat |
| Trial balance                                   | balanced, 24,802 posted journals                          |
| Folio balances against their ledger lines       | 12,545 folios, none differ                                |
| Cash and bank accounts against their ledger     | ok                                                        |

## What it means, and limits

- At several times the staff a 100-room hotel has on shift, common reads stay well under half the target, and the
  database guards hold under real concurrency: no double booking, no duplicate payment, no repeated receipt number.
- Found while building: the 100-room seed wrote journal numbers directly without moving the journal counter, so
  the first deposit posted afterwards collided with journal 1 (the seed is fixed; the application's own posting
  always takes numbers from the counter).
- One API process on a laptop is a floor, not a ceiling: production runs behind the proxy, possibly on several
  instances (the job queue and sessions already allow that), with a managed database sized by the provider.
- **Still to do (yours, with D17):** the same run against staging with production settings and real network
  latency, from a load generator outside the provider's network, with rate limits raised for its address only.
  Record the result here.
