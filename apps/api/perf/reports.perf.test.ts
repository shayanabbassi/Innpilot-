/**
 * Phase 5 slice 5.6 (P5-16): a 100-room hotel with a year of fictional activity, then the dashboard, every report and
 * two common reads timed through the real API. Run with `pnpm --filter @innpilot/api test:perf`; it never runs with
 * the normal suites. Targets from the QA plan: p95 under 500 ms for the dashboard and common reads.
 *
 * The year is written with SQL in one transaction (about 25,000 room nights through the API would take hours), as
 * posted, balanced journals: the database's own guards still check every entry at commit (balance, open period,
 * cash dimension). Guests are "Perf Guest nnnn": no real data.
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type BrowserClient, type Harness } from '../test/harness';

let h: Harness;
let owner: BrowserClient;
let base: string;
const seeded = { reservations: 0, roomNights: 0, journals: 0, lines: 0, auditEvents: 0 };

const DAY = 86_400_000;
const START = Date.parse('2025-10-19T00:00:00Z');
const NIGHTS = 365; // 2025-10-19 … 2026-10-18; the business date is 2026-10-19.
const date = (d: number) => new Date(START + d * DAY).toISOString().slice(0, 10);
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const reference = (n: number) => {
  let s = '';
  for (let i = 0, v = n; i < 7; i++, v = Math.floor(v / ALPHABET.length))
    s = ALPHABET[v % ALPHABET.length] + s;
  return `P${s}`;
};

/** Inserts rows column-wise through unnest, in chunks. */
async function bulk(table: string, columns: [name: string, type: string][], rows: unknown[][]) {
  for (let i = 0; i < rows.length; i += 5000) {
    const chunk = rows.slice(i, i + 5000);
    const params = columns.map((_, c) => chunk.map((r) => r[c]));
    await h.admin.query(
      `INSERT INTO ${table} (${columns.map(([n]) => n).join(', ')})
       SELECT * FROM unnest(${columns.map(([, t], c) => `$${c + 1}::${t}[]`).join(', ')})`,
      params,
    );
  }
}

beforeAll(async () => {
  h = await startHarness();
  base = `/properties/${h.fx.propA1}`;
  owner = await browser(h).loginActive(h.fx.users.ownerA);
  const tenant = h.fx.tenantA;
  const property = h.fx.propA1;
  const userId = h.fx.users.ownerA.id;

  const std = (
    await owner.post(`${base}/room-types`, {
      code: 'STD',
      name: 'Standard',
      capacityAdults: 2,
      capacityChildren: 0,
      nightlyRate: '8000',
    })
  ).body.data.id as string;
  const rooms: string[] = [];
  for (const [from, to] of [
    ['101', '150'],
    ['201', '250'],
  ]) {
    const res = await owner.post(`${base}/rooms/bulk`, { from, to, roomTypeId: std });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    rooms.push(...(res.body.data as { id: string }[]).map((r) => r.id));
  }
  expect(rooms).toHaveLength(100);
  const account: Record<string, string> = {};
  for (const a of (await owner.get('/finance/accounts')).body.data) account[a.code] = a.id;
  const cash: Record<string, string> = {};
  for (const c of (await owner.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;

  await h.admin.query('BEGIN');
  // Monthly periods for the year.
  for (let m = 0; m <= 12; m++) {
    const start = new Date(Date.UTC(2025, 9 + m, 1));
    const end = new Date(Date.UTC(2025, 10 + m, 0));
    await h.admin.query(
      `INSERT INTO fiscal_periods (tenant_id, start_date, end_date) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, start_date) DO NOTHING`,
      [tenant, start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)],
    );
  }
  const periods = (
    await h.admin.query<{ id: string; m: string }>(
      `SELECT id, to_char(start_date, 'YYYY-MM') AS m FROM fiscal_periods WHERE tenant_id = $1`,
      [tenant],
    )
  ).rows;
  const period = (d: string) => periods.find((p) => p.m === d.slice(0, 7))!.id;

  // Guests.
  const guests = Array.from({ length: 3000 }, (_, i) => [
    randomUUID(),
    tenant,
    `Perf Guest ${String(i + 1).padStart(4, '0')}`,
  ]);
  await bulk(
    'guests',
    [
      ['id', 'uuid'],
      ['tenant_id', 'uuid'],
      ['full_name', 'text'],
    ],
    guests,
  );

  // Two-night stays with a night between them in every room: about two thirds occupancy.
  const reservations: unknown[][] = [];
  const reservationRooms: unknown[][] = [];
  const folios: unknown[][] = [];
  const nightsOf: { rr: string; night: number }[] = [];
  const stays: { folio: string; departure: number; onAccount: boolean; bank: boolean }[] = [];
  let n = 0;
  for (let r = 0; r < rooms.length; r++) {
    for (let d = r % 3; d + 2 <= NIGHTS; d += 3) {
      const id = randomUUID();
      const rr = randomUUID();
      const folio = randomUUID();
      const guest = guests[n % guests.length]![0];
      reservations.push([id, tenant, property, reference(n), guest, 'phone', 'checked_out']);
      reservationRooms.push([
        rr,
        tenant,
        property,
        id,
        std,
        rooms[r],
        date(d),
        date(d + 2),
        1,
        '8000',
        'PKR',
      ]);
      // One stay in twenty is left on account (unpaid) so the receivables report has something to age.
      const onAccount = n % 20 === 0;
      folios.push([
        folio,
        tenant,
        property,
        id,
        guest,
        true,
        onAccount ? 'on_account' : 'settled',
        'PKR',
        new Date(START + (d + 2) * DAY),
      ]);
      nightsOf.push({ rr, night: d }, { rr, night: d + 1 });
      stays.push({ folio, departure: d + 2, onAccount, bank: n % 2 === 0 });
      n++;
    }
  }
  await bulk(
    'reservations',
    [
      ['id', 'uuid'],
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['booking_reference', 'text'],
      ['guest_id', 'uuid'],
      ['source', 'text'],
      ['status', 'text'],
    ],
    reservations,
  );
  await bulk(
    'reservation_rooms',
    [
      ['id', 'uuid'],
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['reservation_id', 'uuid'],
      ['room_type_id', 'uuid'],
      ['room_id', 'uuid'],
      ['arrival', 'date'],
      ['departure', 'date'],
      ['adults', 'int'],
      ['nightly_rate', 'numeric'],
      ['currency_code', 'text'],
    ],
    reservationRooms,
  );
  await bulk(
    'folios',
    [
      ['id', 'uuid'],
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['reservation_id', 'uuid'],
      ['guest_id', 'uuid'],
      ['is_primary', 'boolean'],
      ['status', 'text'],
      ['currency_code', 'text'],
      ['settled_at', 'timestamptz'],
    ],
    folios,
  );

  // Journals: the nightly accrual (D9), the check-out bill and its payment, and daily expenses.
  const entries: unknown[][] = [];
  const lines: unknown[][] = [];
  let number = 1;
  const entry = (
    d: number,
    narration: string,
    ls: [account: string, debit: string, credit: string, folio?: string, cashAccount?: string][],
  ) => {
    const id = randomUUID();
    const total = ls.reduce((s, l) => s + Number(l[1]), 0).toFixed(2);
    entries.push([
      id,
      tenant,
      property,
      number++,
      'draft',
      date(d),
      period(date(d)),
      'PKR',
      'perf_seed',
      narration,
      total,
      total,
      userId,
      userId,
      new Date(START + d * DAY),
    ]);
    ls.forEach(([a, dr, cr, folio, cashAccount], i) =>
      lines.push([tenant, id, i + 1, account[a], dr, cr, folio ?? null, cashAccount ?? null]),
    );
    return id;
  };
  const accruals: unknown[][] = [];
  for (let d = 0; d < NIGHTS; d++) {
    const tonight = nightsOf.filter((x) => x.night === d);
    if (tonight.length === 0) continue;
    const amount = (tonight.length * 8000).toFixed(2);
    const id = entry(d, `Night audit accrual ${date(d)}`, [
      ['1210', amount, '0'],
      ['4000', '0', amount],
    ]);
    for (const x of tonight)
      accruals.push([tenant, property, x.rr, date(x.night), date(x.night), '8000', account['4000'], id]);
    // Daily running costs paid from the drawer.
    entry(d, `Daily costs ${date(d)}`, [
      ['6100', '3500.00', '0'],
      ['6200', '1800.00', '0'],
      ['6400', '2200.00', '0'],
      ['1000', '0', '7500.00', undefined, cash['Front desk cash']],
    ]);
  }
  for (const s of stays) {
    entry(s.departure, 'Check-out: room nights billed', [
      ['1200', '16000.00', '0', s.folio],
      ['1210', '0', '16000.00'],
    ]);
    if (!s.onAccount) {
      entry(s.departure, 'Payment at check-out', [
        s.bank
          ? ['1100', '16000.00', '0', undefined, cash['Bank']]
          : ['1000', '16000.00', '0', undefined, cash['Front desk cash']],
        ['1200', '0', '16000.00', s.folio],
      ]);
    }
  }
  await bulk(
    'journal_entries',
    [
      ['id', 'uuid'],
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['journal_number', 'bigint'],
      ['status', 'text'],
      ['accounting_date', 'date'],
      ['period_id', 'uuid'],
      ['currency_code', 'text'],
      ['source_type', 'text'],
      ['narration', 'text'],
      ['total_debit', 'numeric'],
      ['total_credit', 'numeric'],
      ['created_by', 'uuid'],
      ['posted_by', 'uuid'],
      ['posted_at', 'timestamptz'],
    ],
    entries,
  );
  await bulk(
    'journal_lines',
    [
      ['tenant_id', 'uuid'],
      ['journal_entry_id', 'uuid'],
      ['line_no', 'smallint'],
      ['account_id', 'uuid'],
      ['debit', 'numeric'],
      ['credit', 'numeric'],
      ['folio_id', 'uuid'],
      ['cash_account_id', 'uuid'],
    ],
    lines,
  );
  // Like the posting service: lines go onto drafts, then the entries are posted (each period checked open).
  await h.admin.query(
    `UPDATE journal_entries SET status = 'posted' WHERE tenant_id = $1 AND source_type = 'perf_seed'`,
    [tenant],
  );
  await bulk(
    'room_revenue_accruals',
    [
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['reservation_room_id', 'uuid'],
      ['night', 'date'],
      ['business_date', 'date'],
      ['net_amount', 'numeric'],
      ['revenue_account_id', 'uuid'],
      ['journal_entry_id', 'uuid'],
    ],
    accruals,
  );
  // A year of audit log: staff activity every day.
  const audit: unknown[][] = [];
  for (let d = 0; d < NIGHTS; d++) {
    for (let i = 0; i < 80; i++) {
      audit.push([
        tenant,
        property,
        'user',
        userId,
        i % 10 === 0 ? 'auth.login' : 'folio.charge_posted',
        'folio',
        new Date(START + d * DAY + i * 600_000),
      ]);
    }
  }
  await bulk(
    'audit_events',
    [
      ['tenant_id', 'uuid'],
      ['property_id', 'uuid'],
      ['actor_type', 'text'],
      ['actor_user_id', 'uuid'],
      ['action', 'text'],
      ['entity_type', 'text'],
      ['occurred_at', 'timestamptz'],
    ],
    audit,
  );
  await h.admin.query('COMMIT'); // The deferred balance checks run here.
  await h.admin.query('ANALYZE');
  Object.assign(seeded, {
    reservations: reservations.length,
    roomNights: accruals.length,
    journals: entries.length,
    lines: lines.length,
    auditEvents: audit.length,
  });
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
