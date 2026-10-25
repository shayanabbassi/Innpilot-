/**
 * Phase 4 slice 4.5 — the night audit. OPS-004 (running twice for a date posts nothing twice and advances once);
 * D9 (each night's room revenue accrued once, cleared at check-out, never counted twice); open cashier shifts need an
 * override; no-shows holding deposits need a refund-or-keep decision; the stored summary equals the ledger for the
 * date; the old /day-close path still works; roles and isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let desk: BrowserClient;
let manager: BrowserClient;
let base: string;
let std: string;
let guestId: string;
const room: Record<string, string> = {};
const cat: Record<string, string> = {};

const withKey = (c: BrowserClient, path: string, body: object = {}, key: string = randomUUID()) =>
  c.agent
    .post(`/api/v1${base}${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', key)
    .send(body);
const businessDate = async () =>
  (await h.admin.query('SELECT business_date::text AS d FROM properties WHERE id = $1', [h.fx.propA1]))
    .rows[0].d;
async function book(arrival: string, departure: string, roomId: string | null) {
  const res = await withKey(desk, '/reservations', {
    guestId,
    source: 'phone',
    rooms: [{ roomTypeId: std, roomId, arrival, departure, adults: 1 }],
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { id: res.body.data.id as string, rr: res.body.data.rooms[0].id as string };
}
async function ledger(code: string): Promise<string> {
  const { rows } = await h.admin.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.tenant_id = $1 AND a.code = $2 AND e.status <> 'draft'`,
    [h.fx.tenantA, code],
  );
  return rows[0]!.b;
}
const accrualCount = async () =>
  (await h.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM room_revenue_accruals`)).rows[0]!.n;

beforeAll(async () => {
  h = await startHarness();
  const owner = await browser(h).loginActive(h.fx.users.ownerA);
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  desk = await browser(h).loginActive(h.fx.users.deskA);
  manager = await browser(h).loginActive(h.fx.users.managerA);
  base = `/properties/${h.fx.propA1}`;
  std = (
    await owner.post(`${base}/room-types`, {
      code: 'STD',
      name: 'Standard',
      capacityAdults: 2,
      capacityChildren: 0,
      nightlyRate: '5000',
    })
  ).body.data.id;
  for (const r of (await owner.post(`${base}/rooms/bulk`, { from: '601', to: '604', roomTypeId: std })).body
    .data)
    room[r.roomNumber] = r.id;
  for (const c of (await acc.get(`${base}/charge-categories`)).body.data) cat[c.code] = c.id;
  const pst = await acc.post(`${base}/tax-codes`, {
    code: 'PST',
    name: 'Sales tax',
    firstRate: { effectiveFrom: '2026-10-19', ratePercent: '16' },
  });
  await acc.patch(`${base}/charge-categories/${cat['room']}`, { taxCodeIds: [pst.body.data.id] });
  guestId = (await desk.post('/guests', { fullName: 'Audit Guest' })).body.data.id;
});

afterAll(async () => {
  await h?.close();
});

describe('night audit', () => {
  let stay: string;
  let folioId: string;
  let walkUp: { id: string; rr: string };
  let fee: { id: string; rr: string };
  const runKey = randomUUID();

  it('previews the checks, the nights to accrue and no-shows holding deposits', async () => {
    const guest = await book('2026-10-19', '2026-10-21', room['601']!);
    const res = await withKey(desk, `/reservations/${guest.id}/rooms/${guest.rr}/check-in`);
    stay = res.body.data.id;
    folioId = (await desk.get(`${base}/reservations/${guest.id}/folios`)).body.data[0].id;
    await withKey(desk, '/payments', { folioId, amount: '2000', method: 'cash' });
    // Two arrivals that will not come, each with a deposit.
    walkUp = await book('2026-10-19', '2026-10-20', null);
    fee = await book('2026-10-19', '2026-10-20', null);
    await withKey(desk, '/payments', { reservationId: walkUp.id, amount: '1000', method: 'cash' });
    await withKey(desk, '/payments', {
      reservationId: fee.id,
      amount: '1500',
      method: 'card',
      externalReference: 'A1',
    });

    const preview = await manager.get(`${base}/night-audit/preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.data.accruals).toEqual({ nights: 1, net: '5000.00' });
    expect(preview.body.data.noShowDeposits.map((d: { held: string }) => d.held).sort()).toEqual([
      '1000.00',
      '1500.00',
    ]);
    expect(preview.body.data.summary.receipts).toEqual([
      { method: 'card', amount: '1500.00' },
      { method: 'cash', amount: '3000.00' },
    ]);
    // The old path still answers.
    expect((await manager.get(`${base}/day-close/preview`)).status).toBe(200);
  });

  it('needs a decision for every deposit, and an override reason for an open shift', async () => {
    const shift = await withKey(desk, '/cashier-shifts/open', {
      cashAccountId: (await acc.get(`${base}/cash-accounts`)).body.data[0].id,
      openingCount: '3000',
    });
    expect(shift.status).toBe(201);
    const issues = (await manager.get(`${base}/night-audit/preview`)).body.data.issues.map(
      (i: { check: string }) => i.check,
    );
    expect(issues).toContain('open_shifts');

    const undecided = await withKey(manager, '/night-audit', {
      businessDate: '2026-10-19',
      markNoShows: true,
      deposits: { [walkUp.id]: 'refund' },
    });
    expect(undecided.status).toBe(409);
    expect(undecided.body.error.code).toBe('DEPOSIT_HANDLING_REQUIRED');
    expect(undecided.body.error.details[0].path).toBe(`deposits.${fee.id}`);
    // Nothing happened: the bookings are still due.
    expect((await desk.get(`${base}/reservations/${fee.id}`)).body.data.status).not.toBe('no_show');

    const noReason = await withKey(manager, '/night-audit', {
      businessDate: '2026-10-19',
      markNoShows: true,
      deposits: { [walkUp.id]: 'refund', [fee.id]: 'forfeit' },
    });
    expect(noReason.status).toBe(409);
    expect(noReason.body.error.details.map((d: { path: string }) => d.path)).toContain('open_shifts');
    expect(await accrualCount()).toBe(0);
  });

  it('runs once (OPS-004): no-shows decided, the night accrued, the summary stored, the date advanced', async () => {
    const body = {
      businessDate: '2026-10-19',
      markNoShows: true,
      deposits: { [walkUp.id]: 'refund', [fee.id]: 'forfeit' },
      reason: 'Night cashier counts the drawer at 07:00',
    };
    const res = await withKey(manager, '/night-audit', body, runKey);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      kind: 'night_audit',
      businessDate: '2026-10-19',
      noShowsMarked: 2,
    });
    expect(res.body.data.unresolved.map((i: { check: string }) => i.check)).toEqual(['open_shifts']);
    expect(await businessDate()).toBe('2026-10-20');

    // D9: Dr Unbilled guest revenue / Cr room revenue, net of tax, dated the night it was earned.
    const { rows } = await h.admin.query<{ code: string; debit: string; credit: string; date: string }>(
      `SELECT a.code, l.debit::numeric(19,2)::text AS debit, l.credit::numeric(19,2)::text AS credit,
              e.accounting_date::text AS date
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
       WHERE e.source_type = 'night_audit' ORDER BY l.line_no`,
    );
    expect(rows).toEqual([
      { code: '1210', debit: '5000.00', credit: '0.00', date: '2026-10-19' },
      { code: '4000', debit: '0.00', credit: '5000.00', date: '2026-10-19' },
    ]);
    // The kept deposit is a fee; the other waits to be refunded.
    expect((await desk.get(`${base}/reservations/${fee.id}`)).body.data.status).toBe('no_show');
    expect(await ledger('4500')).toBe('-1500.00');

    const summary = res.body.data.summary;
    expect(summary).toMatchObject({
      accrued: { nights: 1, net: '5000.00' },
      revenueTotal: '6500.00',
      occupancy: { occupied: 1, sellable: 4, percent: '25.0' },
      arrivals: 1,
      inHouse: 1,
      depositsToRefund: { count: 1, amount: '1000.00' },
    });
    // The stored revenue equals the ledger for the date.
    const { rows: rev } = await h.admin.query<{ total: string }>(
      `SELECT sum(l.credit - l.debit)::numeric(19,2)::text AS total
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
       WHERE e.accounting_date = '2026-10-19' AND a.account_class = 'revenue' AND a.tenant_id = $1
         AND e.status <> 'draft'`,
      [h.fx.tenantA],
    );
    expect(rev[0]!.total).toBe(summary.revenueTotal);

    // A retry with the same key is the same audit; another run for the date is refused; nothing posts twice.
    const replay = await withKey(manager, '/night-audit', body, runKey);
    expect(replay.status).toBe(200);
    expect(replay.body.data.id).toBe(res.body.data.id);
    expect((await withKey(manager, '/night-audit', body)).status).toBe(409);
    expect(await accrualCount()).toBe(1);
    expect(await businessDate()).toBe('2026-10-20');
  });

  it('lets exactly one of several simultaneous runs through', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        withKey(manager, '/night-audit', { businessDate: '2026-10-20', reason: 'Concurrent run test' }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await accrualCount()).toBe(2);
    expect(await ledger('1210')).toBe('10000.00');
    expect(await ledger('4000')).toBe('-10000.00');
  });

  it('bills the accrued nights at check-out without counting them twice (D9)', async () => {
    const res = await withKey(desk, `/stays/${stay}/check-out`, {
      settlements: [{ folioId, action: 'pay', method: 'card', externalReference: 'AUTH 7' }],
    });
    expect(res.status).toBe(200);
    // Room revenue stays at the two nights earned; the unbilled amount is cleared; tax charged on the bill.
    expect(await ledger('4000')).toBe('-10000.00');
    expect(await ledger('1210')).toBe('0.00');
    expect(await ledger('2200')).toBe('-1600.00');
    const { rows } = await h.admin.query<{ b: string }>(
      `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
       WHERE l.folio_id = $1 AND a.system_role IN ('guest_receivable', 'guest_deposits') AND e.status <> 'draft'`,
      [folioId],
    );
    expect(rows[0]!.b).toBe('0.00');
    expect((await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31')).body.data.balanced).toBe(
      true,
    );
  });

  it('keeps the history with summaries, for managers only, within the tenant', async () => {
    const history = (await manager.get(`${base}/night-audit/history`)).body.data;
    expect(history.map((x: { businessDate: string }) => x.businessDate)).toEqual([
      '2026-10-20',
      '2026-10-19',
    ]);
    expect(history[0].summary.accrued.nights).toBe(1);
    expect((await desk.get(`${base}/night-audit/preview`)).status).toBe(403);
    expect((await withKey(desk, '/night-audit', { businessDate: await businessDate() })).status).toBe(403);
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`${base}/night-audit/history`)).status).toBe(404);
  });
});
