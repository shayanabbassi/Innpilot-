/**
 * Phase 5 slice 5.5 — owner dashboard. Every figure equals the report it links to, for the same property and dates
 * (QA "dashboard totals reconcile with reports"); front desk gets the operational part only, with no financial
 * fields in the response (P5-13); housekeeping, other properties and other tenants are refused.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let owner: BrowserClient;
let acc: BrowserClient;
let desk: BrowserClient;
let base: string;
const account: Record<string, string> = {};
const cash: Record<string, string> = {};
const cat: Record<string, string> = {};

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
  owner = await browser(h).loginActive(h.fx.users.ownerA);
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  desk = await browser(h).loginActive(h.fx.users.deskA);
  const manager = await browser(h).loginActive(h.fx.users.managerA);
  const cashier = await browser(h).loginActive(h.fx.users.cashierA);
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  for (const c of (await acc.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;
  for (const c of (await acc.get(`${base}/charge-categories`)).body.data) cat[c.code] = c.id;

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
  for (const r of (await owner.post(`${base}/rooms/bulk`, { from: '901', to: '903', roomTypeId: std })).body
    .data) {
    room[r.roomNumber] = r.id;
  }
  await ok(
    manager.post(`${base}/maintenance/tickets`, {
      roomId: room['903'],
      category: 'electrical',
      description: 'No power',
      outOfOrder: { from: '2026-10-19', to: '2026-10-22' },
    }),
  );
  await h.admin.query(`UPDATE rooms SET housekeeping_state = 'dirty' WHERE id = $1`, [room['902']]);

  const guestId = ((await desk.post('/guests', { fullName: 'Dashboard Guest' })).body.data as { id: string })
    .id;
  const book = async (roomId: string | null) =>
    (await ok(
      withKey(desk, `${base}/reservations`, {
        guestId,
        source: 'phone',
        rooms: [{ roomTypeId: std, roomId, arrival: '2026-10-19', departure: '2026-10-21', adults: 1 }],
      }),
    )) as { id: string; rooms: { id: string }[] };
  const inHouse = await book(room['901']!);
  await book(null);
  await ok(withKey(desk, `${base}/reservations/${inHouse.id}/rooms/${inHouse.rooms[0]!.id}/check-in`), 200);
  const folioId = (await desk.get(`${base}/reservations/${inHouse.id}/folios`)).body.data[0].id;
  await ok(
    withKey(desk, `${base}/folios/${folioId}/charges`, {
      categoryId: cat['fnb'],
      description: 'Dinner',
      unitPrice: '1000',
    }),
  );
  await ok(withKey(desk, `${base}/payments`, { folioId, amount: '400', method: 'cash' }));
  const expense = await ok(
    withKey(acc, `${base}/expenses`, {
      kind: 'cash',
      payee: 'Plumber',
      expenseDate: '2026-10-19',
      description: 'Tap',
      cashAccountId: cash['Front desk cash'],
      lines: [{ accountId: account['6300'], amount: '250' }],
    }),
  );
  await ok(withKey(acc, `${base}/expenses/${expense.id as string}/submit`), 200);
  await ok(
    withKey(cashier, `${base}/cashier-shifts/open`, {
      cashAccountId: cash['Front desk cash'],
      openingCount: '150',
    }),
  );
});

afterAll(async () => {
  await h?.close();
});

type Kpi = { key: string; value: string; comparison: string | null; href: string; definition: string };
const kpi = (d: { kpis: Kpi[] }, key: string) => d.kpis.find((k) => k.key === key)!;

describe('dashboard figures equal the reports', () => {
  it('shows today’s operations from the occupancy and arrivals reports', async () => {
    const res = await owner.get(`/dashboard?propertyId=${h.fx.propA1}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({
      businessDate: '2026-10-19',
      from: '2026-10-01',
      to: '2026-10-19',
      comparisonFrom: '2026-09-12',
      comparisonTo: '2026-09-30',
      timezone: 'Asia/Karachi',
      financial: true,
    });
    const occ = (
      await owner.get(`/reports/occupancy?from=2026-10-19&to=2026-10-19&propertyId=${h.fx.propA1}`)
    ).body.data.nights[0];
    expect(kpi(d, 'occupancy').value).toBe(occ.occupancy);
    expect(kpi(d, 'rooms_occupied').value).toBe(String(occ.sold));
    expect(kpi(d, 'rooms_available').value).toBe(String(occ.available));
    expect(kpi(d, 'out_of_service').value).toBe('1');
    expect(kpi(d, 'arrivals').value).toBe('2');
    expect(kpi(d, 'in_house').value).toBe('1');
    expect(d.operations.unassignedArrivals).toBe(1);
    expect(d.operations.roomsToClean.map((r: { roomNumber: string }) => r.roomNumber)).toEqual(['902']);
    expect(d.operations.cashier).toMatchObject({ openShifts: 1, awaitingApproval: 0 });
    for (const k of d.kpis as Kpi[]) {
      expect(k.definition.length).toBeGreaterThan(10);
      expect(k.href.startsWith('/')).toBe(true);
    }
  });

  it('takes revenue, profit, expenses, cash and receivables from the financial reports', async () => {
    const d = (await owner.get(`/dashboard?propertyId=${h.fx.propA1}`)).body.data;
    const q = `from=2026-10-01&to=2026-10-19&propertyId=${h.fx.propA1}`;
    const pl = (await owner.get(`/reports/profit-loss?${q}&compare=previous_period`)).body.data;
    const total = (key: string) => pl.sections.find((s: { key: string }) => s.key === key).total;
    const revenue = (await owner.get(`/reports/revenue?${q}`)).body.data;
    const cashbook = (
      await owner.get(`/reports/cashbook?from=2026-10-19&to=2026-10-19&propertyId=${h.fx.propA1}`)
    ).body.data;
    const aging = (await owner.get(`/reports/receivables-aging?asOf=2026-10-19&propertyId=${h.fx.propA1}`))
      .body.data;

    expect(kpi(d, 'total_revenue')).toMatchObject({
      value: total('revenue').amount,
      comparison: total('revenue').comparison,
    });
    expect(kpi(d, 'total_revenue').value).toBe('1000.00');
    expect(kpi(d, 'net_profit').value).toBe(pl.netProfit.amount);
    expect(kpi(d, 'expenses').value).toBe('250.00');
    expect(kpi(d, 'cash_received').value).toBe(revenue.receiptsTotal);
    expect(kpi(d, 'cash_received').value).toBe('400.00');
    expect(kpi(d, 'cash_balance').value).toBe(cashbook.totals.closing);
    expect(kpi(d, 'receivables').value).toBe(aging.totals.total);
    expect(kpi(d, 'receivables').value).toBe('600.00');
    expect(kpi(d, 'room_revenue').value).toBe('0.00');
    // Revenue, cash received, cash balance and profit are different figures (UX §6.3).
    expect(
      new Set(['total_revenue', 'cash_received', 'cash_balance', 'net_profit'].map((k) => kpi(d, k).value))
        .size,
    ).toBe(4);
    expect(d.finance).toMatchObject({
      todayReceipts: cashbook.totals.receipts,
      todayPayments: cashbook.totals.payments,
      pendingExpenseApprovals: 1,
      draftJournals: 0,
    });
    expect(d.finance.unresolvedBalances).toEqual([
      expect.objectContaining({ guestName: 'Dashboard Guest', balance: '600.00', bucket: 'current' }),
    ]);
  });

  it('uses a chosen period and compares it with the one before', async () => {
    const d = (await owner.get(`/dashboard?propertyId=${h.fx.propA1}&from=2026-10-19&to=2026-10-19`)).body
      .data;
    expect(d).toMatchObject({
      from: '2026-10-19',
      to: '2026-10-19',
      comparisonFrom: '2026-10-18',
      comparisonTo: '2026-10-18',
    });
    expect(kpi(d, 'total_revenue')).toMatchObject({ value: '1000.00', comparison: '0.00' });
  });
});

describe('permissions and isolation', () => {
  it('gives front desk the operations only, with no financial fields in the response', async () => {
    const res = await desk.get(`/dashboard?propertyId=${h.fx.propA1}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.financial).toBe(false);
    expect(d.finance).toBeNull();
    expect(d.kpis.map((k: Kpi) => k.key)).toEqual([
      'occupancy',
      'rooms_occupied',
      'rooms_available',
      'out_of_service',
      'arrivals',
      'departures',
      'in_house',
    ]);
    expect(JSON.stringify(d)).not.toMatch(/1000\.00|760\.00/);
  });

  it('refuses housekeeping, another property and another tenant', async () => {
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    expect((await hk.get(`/dashboard?propertyId=${h.fx.propA1}`)).status).toBe(403);
    const m1 = await browser(h).loginActive(h.fx.users.managerA1);
    expect((await m1.get(`/dashboard?propertyId=${h.fx.propA2}`)).status).toBe(404);
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`/dashboard?propertyId=${h.fx.propA1}`)).status).toBe(404);
  });

  it('needs a property and both dates or neither', async () => {
    expect((await owner.get('/dashboard')).status).toBe(400);
    expect((await owner.get(`/dashboard?propertyId=${h.fx.propA1}&from=2026-10-01`)).status).toBe(400);
  });
});
