/**
 * Phase 5 slice 5.6 (P5-16): a 100-room hotel with a year of fictional activity, then the dashboard, every report and
 * two common reads timed through the real API. Run with `pnpm --filter @innpilot/api test:perf`; it never runs with
 * the normal suites. Targets from the QA plan: p95 under 500 ms for the dashboard and common reads.
 *
 * The year is written with SQL in one transaction (about 25,000 room nights through the API would take hours), as
 * posted, balanced journals: the database's own guards still check every entry at commit (balance, open period,
 * cash dimension). Guests are "Perf Guest nnnn": no real data.
 */
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type BrowserClient, type Harness } from '../test/harness';
import { seedHundredRoomYear } from './hundred-rooms';

let h: Harness;
let owner: BrowserClient;
let base: string;
const seeded = { reservations: 0, roomNights: 0, journals: 0, lines: 0, auditEvents: 0 };

beforeAll(async () => {
  h = await startHarness();
  base = `/properties/${h.fx.propA1}`;
  owner = await browser(h).loginActive(h.fx.users.ownerA);
  Object.assign(seeded, await seedHundredRoomYear(h, owner));
}, 600_000);

afterAll(async () => {
  await h?.close();
});

const P = () => `propertyId=${h.fx.propA1}`;
const MONTH = 'from=2026-10-01&to=2026-10-18';
const YEAR = 'from=2025-10-19&to=2026-10-18';

describe('100-room property, one year', () => {
  it('measures p50 and p95 for the dashboard, every report and common reads', async () => {
    const targets: [label: string, path: string, kind: 'common' | 'report'][] = [
      ['Dashboard (month to date)', `/dashboard?${P()}`, 'common'],
      ['Reservations list (30 days)', `${base}/reservations?from=2026-09-19&to=2026-10-19`, 'common'],
      ['Room board', `${base}/room-board`, 'common'],
      ['Trial balance (year)', `/reports/trial-balance?${YEAR}&${P()}`, 'report'],
      [
        'Profit and loss (year, compared)',
        `/reports/profit-loss?${YEAR}&compare=previous_year&${P()}`,
        'report',
      ],
      ['Balance sheet', `/reports/balance-sheet?asOf=2026-10-18&${P()}`, 'report'],
      ['Cashbook (month)', `/reports/cashbook?${MONTH}&${P()}`, 'report'],
      ['Cash flow (year)', `/reports/cash-flow?${YEAR}&${P()}`, 'report'],
      ['Revenue summary (month)', `/reports/revenue?${MONTH}&${P()}`, 'report'],
      ['Tax summary (year)', `/reports/tax-summary?${YEAR}&${P()}`, 'report'],
      ['Guest balances', `/reports/receivables-aging?asOf=2026-10-18&${P()}`, 'report'],
      ['Supplier balances', `/reports/payables-aging?asOf=2026-10-18&${P()}`, 'report'],
      ['Occupancy (month)', `/reports/occupancy?${MONTH}&${P()}`, 'report'],
      ['Occupancy (year)', `/reports/occupancy?${YEAR}&${P()}`, 'report'],
      ['Arrivals and departures (month)', `/reports/arrivals-departures?${MONTH}&${P()}`, 'report'],
      ['Cash closings (month)', `/reports/cashier-closings?${MONTH}&${P()}`, 'report'],
      ['Expenses (month)', `/reports/expenses?${MONTH}&${P()}`, 'report'],
      ['Discrepancies (month)', `/reports/discrepancies?${MONTH}&${P()}`, 'report'],
      ['User activity (month)', `/reports/user-activity?${MONTH}`, 'report'],
      [
        'Export: profit and loss, Excel (year)',
        `/reports/profit-loss/export?format=xlsx&${YEAR}&${P()}`,
        'report',
      ],
      [
        'Export: guest balances, CSV',
        `/reports/receivables-aging/export?format=csv&asOf=2026-10-18&${P()}`,
        'report',
      ],
    ];
    const RUNS = 20;
    const results: string[] = [];
    for (const [label, path, kind] of targets) {
      for (let i = 0; i < 2; i++) await owner.get(path); // warm-up
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        const res = await owner.get(path);
        times.push(performance.now() - t0);
        expect(res.status, `${label}: ${JSON.stringify(res.body).slice(0, 200)}`).toBe(200);
      }
      times.sort((a, b) => a - b);
      const p = (q: number) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)]!.toFixed(0);
      results.push(
        `| ${label} | ${kind} | ${p(0.5)} | ${p(0.95)} | ${times[times.length - 1]!.toFixed(0)} |`,
      );
    }
    // Printed for the performance note; the run fails only if a response is not 200.
    // The table is the output of this run: it goes into the performance note.
    // eslint-disable-next-line no-console
    console.log(
      [
        `Seeded: ${seeded.reservations} stays, ${seeded.roomNights} room nights, ${seeded.journals} journals, ${seeded.lines} lines, ${seeded.auditEvents} audit events`,
        '| Read | Kind | p50 ms | p95 ms | max ms |',
        '| --- | --- | --- | --- | --- |',
        ...results,
      ].join('\n'),
    );
    // The figures are consistent: the trial balance of the seeded year balances.
    expect((await owner.get(`/reports/trial-balance?${YEAR}&${P()}`)).body.data.balanced).toBe(true);
  }, 900_000);
});
