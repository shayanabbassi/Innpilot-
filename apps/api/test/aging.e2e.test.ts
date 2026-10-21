/**
 * Phase 5 slice 5.3 — receivables (guest ledger) and payables aging with the D14 buckets.
 * Folios are aged from their invoice (check-out) date, bills from their due date; each report ties to its ledger
 * account and shows what is not linked to a folio or bill; an earlier as-of date shows the earlier balance; roles
 * and isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let desk: BrowserClient;
let manager: BrowserClient;
let base: string;
let supplierId: string;
const account: Record<string, string> = {};
const cash: Record<string, string> = {};
const cat: Record<string, string> = {};
const ids = { asmaFolio: '', bilalFolio: '', companyFolio: '', bill1: '', bill2: '' };

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
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  for (const c of (await acc.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;
  for (const c of (await acc.get(`${base}/charge-categories`)).body.data) cat[c.code] = c.id;

  // ------------------------------------------------------------------------------- guests (business date 10-19)
  const std = (
    await owner.post(`${base}/room-types`, {
      code: 'STD',
      name: 'Standard',
      capacityAdults: 2,
      capacityChildren: 0,
      nightlyRate: '6000',
    })
  ).body.data.id;
  const rooms = (await owner.post(`${base}/rooms/bulk`, { from: '601', to: '603', roomTypeId: std })).body
    .data;
  const guest = async (fullName: string) =>
    ((await desk.post('/guests', { fullName })).body.data as { id: string }).id;
  const book = async (guestId: string, arrival: string, departure: string, roomId: string | null) =>
    (await ok(
      withKey(desk, `${base}/reservations`, {
        guestId,
        source: 'phone',
        rooms: [{ roomTypeId: std, roomId, arrival, departure, adults: 1 }],
      }),
    )) as { id: string; rooms: { id: string }[] };
  const folioOf = async (reservationId: string) =>
    (await desk.get(`${base}/reservations/${reservationId}/folios`)).body.data[0].id as string;

  // Asma stays on and has a dinner on her open folio.
  const asma = await book(await guest('Asma Open'), '2026-10-19', '2026-10-22', rooms[0].id);
  await ok(withKey(desk, `${base}/reservations/${asma.id}/rooms/${asma.rooms[0]!.id}/check-in`), 200);
  ids.asmaFolio = await folioOf(asma.id);
  await ok(
    withKey(desk, `${base}/folios/${ids.asmaFolio}/charges`, {
      categoryId: cat['fnb'],
      description: 'Dinner',
      unitPrice: '1000',
    }),
  );
  // Bilal pays a deposit for a later stay: a credit on his folio.
  const bilal = await book(await guest('Bilal Deposit'), '2026-10-25', '2026-10-26', null);
  await ok(withKey(desk, `${base}/payments`, { reservationId: bilal.id, amount: '500', method: 'cash' }));
  ids.bilalFolio = await folioOf(bilal.id);
  // Dana's deposit exactly covers her dinner: receivable 700 and deposit −700 on one folio, balance zero.
  const dana = await book(await guest('Dana Offset'), '2026-10-19', '2026-10-22', rooms[2].id);
  await ok(withKey(desk, `${base}/payments`, { reservationId: dana.id, amount: '700', method: 'cash' }));
  await ok(withKey(desk, `${base}/reservations/${dana.id}/rooms/${dana.rooms[0]!.id}/check-in`), 200);
  await ok(
    withKey(desk, `${base}/folios/${await folioOf(dana.id)}/charges`, {
      categoryId: cat['fnb'],
      description: 'Dinner',
      unitPrice: '700',
    }),
  );
  // Chaudhry Traders' guest stays one night and leaves the bill on account.
  const company = await book(await guest('Company Guest'), '2026-10-19', '2026-10-20', rooms[1].id);
  const stay = await ok(
    withKey(desk, `${base}/reservations/${company.id}/rooms/${company.rooms[0]!.id}/check-in`),
    200,
  );
  ids.companyFolio = await folioOf(company.id);
  await ok(
    withKey(manager, `${base}/day-close`, {
      businessDate: '2026-10-19',
      markNoShows: true,
      reason: 'Aging test',
    }),
    200,
  );
  await ok(
    withKey(manager, `${base}/stays/${stay.id as string}/check-out`, {
      settlements: [{ folioId: ids.companyFolio, action: 'on_account', reason: 'Company pays monthly' }],
    }),
    200,
  );

  // ------------------------------------------------------------------------------- suppliers
  supplierId = (
    (await acc.post('/suppliers', { name: 'Fresh Foods', paymentTermsDays: 0 })).body.data as { id: string }
  ).id;
  const bill = async (expenseDate: string, dueDate: string, amount: string) => {
    const draft = await ok(
      withKey(acc, `${base}/expenses`, {
        kind: 'bill',
        supplierId,
        expenseDate,
        dueDate,
        description: `Bill due ${dueDate}`,
        lines: [{ accountId: account['5000'], amount }],
      }),
    );
    await ok(withKey(acc, `${base}/expenses/${draft.id as string}/submit`), 200);
    await ok(withKey(manager, `${base}/expenses/${draft.id as string}/approve`), 200);
    return draft.id as string;
  };
  ids.bill1 = await bill('2026-10-01', '2026-10-10', '1000');
  ids.bill2 = await bill('2026-10-15', '2026-10-31', '2000');
  await ok(
    withKey(manager, `${base}/expenses/${ids.bill2}/pay`, { amount: '500', cashAccountId: cash['Bank'] }),
  );
  // A supplier balance entered by journal, not linked to a bill.
  const draft = await ok(
    withKey(acc, '/finance/journal-entries/draft', {
      propertyId: h.fx.propA1,
      narration: 'Supplier balance from the old books',
      lines: [
        { accountId: account['5000'], debit: '300' },
        { accountId: account['2000'], credit: '300', supplierId },
      ],
    }),
  );
  await ok(withKey(acc, `/finance/journal-entries/${draft.id as string}/post`), 200);
});

afterAll(async () => {
  await h?.close();
});

type Folio = { folioId: string; bucket: string; days: number; balance: string; state: string };
const folio = (d: { guests: { folios: Folio[] }[] }, id: string) =>
  d.guests.flatMap((g) => g.folios).find((f) => f.folioId === id);
const receivables = (asOf: string) =>
  acc.get(`/reports/receivables-aging?asOf=${asOf}&propertyId=${h.fx.propA1}`);
const payables = (asOf: string) => acc.get(`/reports/payables-aging?asOf=${asOf}&propertyId=${h.fx.propA1}`);

describe('receivables aging (guest ledger)', () => {
  it('lists folios with a balance, open ones current, on-account ones from the invoice date', async () => {
    const res = await receivables('2026-10-20');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.guests.map((g: { guestName: string }) => g.guestName)).toEqual([
      'Asma Open',
      'Bilal Deposit',
      'Company Guest',
    ]);
    expect(folio(d, ids.asmaFolio)).toMatchObject({
      state: 'open',
      bucket: 'current',
      receivable: '1000.00',
      balance: '1000.00',
    });
    expect(folio(d, ids.bilalFolio)).toMatchObject({
      bucket: 'current',
      receivable: '0.00',
      deposits: '-500.00',
      balance: '-500.00',
    });
    expect(folio(d, ids.companyFolio)).toMatchObject({
      state: 'checked_out',
      invoiceDate: '2026-10-20',
      days: 0,
      bucket: 'current',
      balance: '6000.00',
    });
    expect(d.totals).toEqual({
      current: '6500.00',
      d1_30: '0.00',
      d31_60: '0.00',
      d61_90: '0.00',
      over_90: '0.00',
      total: '6500.00',
    });
  });

  it('moves the on-account folio through the buckets as the date moves on', async () => {
    const at = async (asOf: string) => folio((await receivables(asOf)).body.data, ids.companyFolio)!;
    expect(await at('2026-11-19')).toMatchObject({ days: 30, bucket: 'd1_30' });
    expect(await at('2026-11-20')).toMatchObject({ days: 31, bucket: 'd31_60' });
    expect(await at('2027-01-18')).toMatchObject({ days: 90, bucket: 'd61_90' });
    expect(await at('2027-01-19')).toMatchObject({ days: 91, bucket: 'over_90' });
    expect((await receivables('2027-01-19')).body.data.totals).toMatchObject({
      over_90: '6000.00',
      current: '500.00',
    });
  });

  it('ties to the guest receivable and deposit accounts', async () => {
    const d = (await receivables('2026-10-20')).body.data;
    expect(d.ledger).toEqual([
      // Dana's offsetting folio counts in both accounts, so nothing shows as not linked.
      expect.objectContaining({ code: '1200', ledgerBalance: '7700.00', aged: '7700.00', notLinked: '0.00' }),
      expect.objectContaining({
        code: '2100',
        ledgerBalance: '-1200.00',
        aged: '-1200.00',
        notLinked: '0.00',
      }),
    ]);
  });

  it('shows the earlier balance for an earlier date', async () => {
    const d = (await receivables('2026-10-19')).body.data;
    // Before check-out the company folio is still open and holds no room night yet (D7: posted at check-out).
    expect(folio(d, ids.companyFolio)).toBeUndefined();
    expect(d.totals.total).toBe('500.00');
    expect((await receivables('2026-10-18')).body.data.guests).toEqual([]);
  });
});

describe('payables aging', () => {
  it('ages bills by due date, net of payments, and shows payables not linked to a bill', async () => {
    const res = await payables('2026-10-20');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.suppliers).toHaveLength(1);
    const s = d.suppliers[0];
    expect(s).toMatchObject({ supplierName: 'Fresh Foods', notLinked: '300.00', balance: '2800.00' });
    expect(s.bills).toEqual([
      expect.objectContaining({
        voucherId: ids.bill1,
        dueDate: '2026-10-10',
        days: 10,
        bucket: 'd1_30',
        total: '1000.00',
        paid: '0.00',
        outstanding: '1000.00',
      }),
      expect.objectContaining({
        voucherId: ids.bill2,
        dueDate: '2026-10-31',
        days: 0,
        bucket: 'current',
        paid: '500.00',
        outstanding: '1500.00',
      }),
    ]);
    expect(d.totals).toMatchObject({ current: '1500.00', d1_30: '1000.00', total: '2500.00' });
    expect(d.notLinked).toBe('300.00');
    expect(d.ledger).toEqual([
      expect.objectContaining({
        code: '2000',
        ledgerBalance: '2800.00',
        aged: '2500.00',
        notLinked: '300.00',
      }),
    ]);
  });

  it('moves bills through the buckets and shows nothing before they were posted', async () => {
    const d = (await payables('2026-12-15')).body.data;
    expect(
      d.suppliers[0].bills.map((b: { bucket: string; days: number }) => `${b.bucket}:${b.days}`),
    ).toEqual(['d61_90:66', 'd31_60:45']);
    const before = (await payables('2026-10-18')).body.data;
    expect(before.suppliers).toEqual([]);
    expect(before.ledger[0].ledgerBalance).toBe('0.00');
  });
});

describe('permissions and isolation', () => {
  it('refuses roles without report.financial', async () => {
    const cashier = await browser(h).loginActive(h.fx.users.cashierA);
    for (const c of [desk, cashier]) {
      expect(
        (await c.get(`/reports/receivables-aging?asOf=2026-10-20&propertyId=${h.fx.propA1}`)).status,
      ).toBe(403);
      expect((await c.get(`/reports/payables-aging?asOf=2026-10-20&propertyId=${h.fx.propA1}`)).status).toBe(
        403,
      );
    }
  });

  it('limits a property-scoped manager and hides another tenant', async () => {
    const m1 = await browser(h).loginActive(h.fx.users.managerA1);
    expect(
      (await m1.get(`/reports/receivables-aging?asOf=2026-10-20&propertyId=${h.fx.propA1}`)).status,
    ).toBe(200);
    expect((await m1.get(`/reports/payables-aging?asOf=2026-10-20&propertyId=${h.fx.propA2}`)).status).toBe(
      404,
    );
    expect((await m1.get('/reports/payables-aging?asOf=2026-10-20')).status).toBe(403);
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect(
      (await ownerB.get(`/reports/receivables-aging?asOf=2026-10-20&propertyId=${h.fx.propA1}`)).status,
    ).toBe(404);
    expect((await ownerB.get('/reports/receivables-aging?asOf=2026-10-20')).body.data.guests).toEqual([]);
    expect((await ownerB.get('/reports/payables-aging?asOf=2026-10-20')).body.data.suppliers).toEqual([]);
  });

  it('needs a valid date', async () => {
    expect((await acc.get('/reports/receivables-aging?asOf=2026-13-01')).status).toBe(400);
  });
});
