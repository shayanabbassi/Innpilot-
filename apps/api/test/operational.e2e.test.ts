/**
 * Phase 5 slice 5.4 — operational reports: occupancy with ADR and RevPAR (P5-12), arrivals and departures, cashier
 * closings (01 §6 cashier variance), expenses, discrepancies and user activity. Every figure comes from records made
 * through the real modules; then roles (a cashier sees only their own closings) and isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let desk: BrowserClient;
let manager: BrowserClient;
let cashier: BrowserClient;
let base: string;
const account: Record<string, string> = {};
const cash: Record<string, string> = {};
const ids = { a: '', b: '', c: '', d: '', shift: '', voided: '' };

const withKey = (c: BrowserClient, path: string, body: object = {}) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', randomUUID())
    .send(body);
async function ok(res: Promise<{ status: number; body: { data: Record<string, unknown> } }>, status = 201) {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

beforeAll(async () => {
  h = await startHarness();
  base = `/properties/${h.fx.propA1}`;
  const owner = await browser(h).loginActive(h.fx.users.ownerA);
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  desk = await browser(h).loginActive(h.fx.users.deskA);
  manager = await browser(h).loginActive(h.fx.users.managerA);
  cashier = await browser(h).loginActive(h.fx.users.cashierA);
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  for (const c of (await acc.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;

  // Four rooms, one out of order on the nights of 19 and 20 October.
  const std = (
    await owner.post(`${base}/room-types`, {
      code: 'STD',
      name: 'Standard',
      capacityAdults: 2,
      capacityChildren: 0,
      nightlyRate: '6000',
    })
  ).body.data.id;
  const room: Record<string, string> = {};
  for (const r of (await owner.post(`${base}/rooms/bulk`, { from: '801', to: '804', roomTypeId: std })).body
    .data) {
    room[r.roomNumber] = r.id;
  }
  await ok(
    manager.post(`${base}/maintenance/tickets`, {
      roomId: room['804'],
      category: 'plumbing',
      description: 'Leaking pipe',
      outOfOrder: { from: '2026-10-19', to: '2026-10-21' },
    }),
  );

  const guestId = ((await desk.post('/guests', { fullName: 'Ops Guest' })).body.data as { id: string }).id;
  const book = async (arrival: string, departure: string, roomId: string | null) =>
    (await ok(
      withKey(desk, `${base}/reservations`, {
        guestId,
        source: 'phone',
        rooms: [{ roomTypeId: std, roomId, arrival, departure, adults: 1 }],
      }),
    )) as { id: string; rooms: { id: string }[] };
  const a = await book('2026-10-19', '2026-10-21', room['801']!);
  const b = await book('2026-10-19', '2026-10-20', room['802']!);
  const c = await book('2026-10-20', '2026-10-22', null);
  const d = await book('2026-10-20', '2026-10-21', null);
  Object.assign(ids, { a: a.id, b: b.id, c: c.id, d: d.id });
  await ok(withKey(desk, `${base}/reservations/${d.id}/cancel`, { reason: 'Plans changed' }), 200);
  await ok(withKey(desk, `${base}/reservations/${a.id}/rooms/${a.rooms[0]!.id}/check-in`), 200);
  await ok(withKey(desk, `${base}/reservations/${b.id}/rooms/${b.rooms[0]!.id}/check-in`), 200);

  // Cash before any shift (outside a shift), then a shift opened with a count above the book balance.
  await ok(withKey(desk, `${base}/payments`, { reservationId: c.id, amount: '500', method: 'cash' }));
  ids.shift = (
    (await ok(
      withKey(cashier, `${base}/cashier-shifts/open`, {
        cashAccountId: cash['Front desk cash'],
        openingCount: '600',
      }),
    )) as {
      id: string;
    }
  ).id;
  // Expected 600; counted 590.
  await ok(
    withKey(cashier, `${base}/cashier-shifts/${ids.shift}/submit-closing`, {
      countedAmount: '590',
      explanation: 'Coins short',
    }),
    200,
  );

  // Expenses: a cash expense, an approved bill, and a voided bill.
  const supplierId = ((await acc.post('/suppliers', { name: 'Fresh Foods' })).body.data as { id: string }).id;
  const cashExpense = await ok(
    withKey(acc, `${base}/expenses`, {
      kind: 'cash',
      payee: 'Electrician',
      expenseDate: '2026-10-19',
      description: 'Corridor lights',
      cashAccountId: cash['Front desk cash'],
      lines: [{ accountId: account['6300'], amount: '300' }],
    }),
  );
  await ok(withKey(acc, `${base}/expenses/${cashExpense.id as string}/submit`), 200);
  const bill = async (amount: string) => {
    const draft = await ok(
      withKey(acc, `${base}/expenses`, {
        kind: 'bill',
        supplierId,
        expenseDate: '2026-10-19',
        description: 'Kitchen supplies',
        lines: [{ accountId: account['5000'], amount, taxAmount: '100', taxRecoverable: true }],
      }),
    );
    await ok(withKey(acc, `${base}/expenses/${draft.id as string}/submit`), 200);
    await ok(withKey(manager, `${base}/expenses/${draft.id as string}/approve`), 200);
    return draft.id as string;
  };
  await bill('1000');
  ids.voided = await bill('700');
  await ok(withKey(acc, `${base}/expenses/${ids.voided}/void`, { reason: 'Entered twice' }), 200);

  // The night audit for 19 October accrues the two occupied rooms (D9).
  await ok(
    withKey(manager, `${base}/day-close`, {
      businessDate: '2026-10-19',
      markNoShows: true,
      reason: 'Ops test',
    }),
    200,
  );
});

afterAll(async () => {
  await h?.close();
});

const get = (c: BrowserClient, path: string, range = 'from=2026-10-19&to=2026-10-21') =>
  c.get(`/reports/${path}?${range}&propertyId=${h.fx.propA1}`);

describe('occupancy, ADR and RevPAR', () => {
  it('counts actual nights from the audit and later nights from bookings', async () => {
    const res = await get(acc, 'occupancy');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.nights).toEqual([
      {
        night: '2026-10-19',
        basis: 'actual',
        rooms: 4,
        outOfService: 1,
        available: 3,
        sold: 2,
        occupancy: '66.7',
        roomRevenue: '12000.00',
        adr: '6000.00',
        revpar: '4000.00',
      },
      expect.objectContaining({
        night: '2026-10-20',
        basis: 'on_the_books',
        available: 3,
        sold: 2,
        adr: null,
      }),
      expect.objectContaining({
        night: '2026-10-21',
        basis: 'on_the_books',
        available: 4,
        sold: 1,
        occupancy: '25.0',
      }),
    ]);
    expect(d.totals).toEqual({
      available: 3,
      sold: 2,
      occupancy: '66.7',
      roomRevenue: '12000.00',
      adr: '6000.00',
      revpar: '4000.00',
    });
  });

  it('uses the same room revenue as the P&L', async () => {
    const pl = (await get(acc, 'profit-loss', 'from=2026-10-19&to=2026-10-19')).body.data;
    const room = pl.sections[0].rows.find((r: { code: string }) => r.code === '4000');
    expect(room.amount).toBe('12000.00');
  });

  it('is open to front desk (operational) but not to housekeeping', async () => {
    expect((await get(desk, 'occupancy')).status).toBe(200);
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    expect((await get(hk, 'occupancy')).status).toBe(403);
  });
});

describe('arrivals and departures', () => {
  it('lists bookings by date with their status, cancelled ones left out', async () => {
    const d = (await get(desk, 'arrivals-departures', 'from=2026-10-19&to=2026-10-20')).body.data;
    expect(
      d.arrivals.map((x: { reservationId: string; status: string }) => [x.reservationId, x.status]).sort(),
    ).toEqual(
      [
        [ids.a, 'checked_in'],
        [ids.b, 'checked_in'],
        [ids.c, 'confirmed'],
      ].sort(),
    );
    expect(d.arrivals.find((x: { reservationId: string }) => x.reservationId === ids.a)).toMatchObject({
      guestName: 'Ops Guest',
      roomNumber: '801',
      nights: 2,
    });
    expect(d.departures.map((x: { reservationId: string }) => x.reservationId)).toEqual([ids.b]);
  });
});

describe('cashier closings', () => {
  it('shows every closing with its variance and approval to supervisors', async () => {
    const d = (await get(acc, 'cashier-closings')).body.data;
    expect(d.allCashiers).toBe(true);
    expect(d.closings).toEqual([
      expect.objectContaining({
        shiftId: ids.shift,
        businessDate: '2026-10-19',
        cashierName: 'cashier@a.test',
        cashAccountName: 'Front desk cash',
        expected: '600.00',
        counted: '590.00',
        variance: '-10.00',
        explanation: 'Coins short',
      }),
    ]);
    expect(d.totals).toMatchObject({ closings: 1, shortages: '10.00', overages: '0.00', net: '-10.00' });
  });

  it('shows a cashier only their own closings', async () => {
    const own = (await get(cashier, 'cashier-closings')).body.data;
    expect(own.allCashiers).toBe(false);
    expect(own.closings).toHaveLength(1);
    const deskView = (await get(desk, 'cashier-closings')).body.data;
    expect(deskView).toMatchObject({ allCashiers: false, closings: [] });
  });
});

describe('expenses', () => {
  it('reports posted expenses by account and payee, voids left out', async () => {
    const d = (await get(acc, 'expenses')).body.data;
    expect(d.byAccount.map((r: { code: string; total: string }) => `${r.code}:${r.total}`)).toEqual([
      '5000:1000.00',
      '6300:300.00',
    ]);
    expect(d.byPayee).toEqual([
      { supplierId: null, name: 'Electrician', cash: '300.00', bills: '0.00', total: '300.00', vouchers: 1 },
      expect.objectContaining({ name: 'Fresh Foods', bills: '1100.00', total: '1100.00', vouchers: 1 }),
    ]);
    expect(d.total).toBe('1300.00');
    expect(d.recoverableTax).toBe('100.00');
    expect((await get(desk, 'expenses')).status).toBe(403);
  });
});

describe('discrepancies', () => {
  it('lists the variance, the opening difference and cash taken outside a shift', async () => {
    const d = (await get(manager, 'discrepancies')).body.data;
    expect(d.variances).toEqual([expect.objectContaining({ shiftId: ids.shift, variance: '-10.00' })]);
    expect(d.openingDifferences).toEqual([
      expect.objectContaining({
        shiftId: ids.shift,
        openingCount: '600.00',
        bookBalance: '500.00',
        difference: '100.00',
      }),
    ]);
    expect(
      d.cashOutsideShifts.map((x: { amountIn: string; amountOut: string }) => `${x.amountIn}/${x.amountOut}`),
    ).toEqual(['500.00/0.00', '0.00/300.00']);
    expect(Array.isArray(d.auditOverrides)).toBe(true);
    expect((await get(cashier, 'discrepancies')).status).toBe(403);
  });
});

describe('user activity', () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });

  it('summarises the audit log per user for hotel dates, tenant-wide auditors only', async () => {
    const res = await acc.get(`/reports/user-activity?from=${today}&to=${today}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    const accountant = d.users.find((u: { name: string }) => u.name === 'accountant@a.test');
    expect(accountant.signIns).toBeGreaterThanOrEqual(1);
    expect(accountant.topActions.length).toBeGreaterThan(0);
    expect(d.totalEvents).toBeGreaterThan(0);
    expect((await acc.get('/reports/user-activity?from=2020-01-01&to=2020-01-31')).body.data.users).toEqual(
      [],
    );
    const m1 = await browser(h).loginActive(h.fx.users.managerA1);
    expect((await m1.get(`/reports/user-activity?from=${today}&to=${today}`)).status).toBe(403);
    expect((await desk.get(`/reports/user-activity?from=${today}&to=${today}`)).status).toBe(403);
    // Another tenant sees only its own people.
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    const b = (await ownerB.get(`/reports/user-activity?from=${today}&to=${today}`)).body.data;
    expect(b.users.every((u: { name: string }) => u.name.endsWith('@b.test') || u.name === 'System')).toBe(
      true,
    );
  });
});

describe('timezone of hotel dates', () => {
  it('counts activity by the property’s day (Asia/Karachi, UTC+5), not the UTC day', async () => {
    // 00:01 and 23:59 on 20 October in Karachi belong to that day; 00:01 on the 21st does not.
    for (const [at, action] of [
      ['2026-10-19T19:01:00Z', 'probe.early_morning'],
      ['2026-10-20T18:59:00Z', 'probe.late_evening'],
      ['2026-10-20T19:01:00Z', 'probe.next_day'],
    ]) {
      await h.admin.query(
        `INSERT INTO audit_events (tenant_id, actor_type, action, entity_type, occurred_at)
         VALUES ($1, 'system', $2, 'probe', $3)`,
        [h.fx.tenantA, action, at],
      );
    }
    const d = (await acc.get('/reports/user-activity?from=2026-10-20&to=2026-10-20')).body.data;
    const system = d.users.find((u: { userId: string | null }) => u.userId === null);
    expect(system.topActions.map((a: { action: string }) => a.action).sort()).toEqual([
      'probe.early_morning',
      'probe.late_evening',
    ]);
    const next = (await acc.get('/reports/user-activity?from=2026-10-21&to=2026-10-21')).body.data;
    expect(
      next.users
        .flatMap((u: { topActions: { action: string }[] }) => u.topActions)
        .some((a: { action: string }) => a.action === 'probe.next_day'),
    ).toBe(true);
  });
});

describe('isolation and limits', () => {
  it('refuses another tenant and ranges over a year', async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    for (const p of ['occupancy', 'arrivals-departures', 'cashier-closings', 'expenses', 'discrepancies']) {
      expect((await get(ownerB, p)).status).toBe(404);
    }
    expect((await get(acc, 'occupancy', 'from=2026-01-01&to=2027-06-01')).status).toBe(400);
  });
});
