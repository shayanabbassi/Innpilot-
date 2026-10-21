/**
 * Phase 5 slice 5.2 — cashbook, cash flow (direct, D13), tax summary and daily revenue summary.
 * QA scenario E: room revenue, guest payment, deposit, expense, refund and transfer are recorded through the real
 * modules; revenue is never confused with cash received, transfers affect neither revenue nor expense, and every
 * report total equals its source journals. Then roles and isolation.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let desk: BrowserClient;
let manager: BrowserClient;
let base: string;
const account: Record<string, string> = {};
const cash: Record<string, string> = {};
const cat: Record<string, string> = {};

const withKey = (c: BrowserClient, path: string, body: object = {}) =>
  c.agent
    .post(`/api/v1${base}${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', randomUUID())
    .send(body);
async function ok(res: Promise<{ status: number; body: { data: Record<string, unknown> } }>, status = 201) {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}
const OCT = 'from=2026-10-01&to=2026-10-31';

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

  // Opening cash at go-live.
  await ok(
    withKey(acc, '/opening-balances', {
      asOf: '2026-10-18',
      lines: [
        { accountId: account['1000'], debit: '10000' },
        { accountId: account['3000'], credit: '10000' },
      ],
    }),
  );
  const pst = await acc.post(`${base}/tax-codes`, {
    code: 'PST',
    name: 'Sales tax',
    firstRate: { effectiveFrom: '2026-10-19', ratePercent: '16' },
  });
  if (pst.status !== 201) throw new Error(JSON.stringify(pst.body));
  await acc.patch(`${base}/charge-categories/${cat['fnb']}`, { taxCodeIds: [pst.body.data.id] });
  const std = (
    await owner.post(`${base}/room-types`, {
      code: 'STD',
      name: 'Standard',
      capacityAdults: 2,
      capacityChildren: 0,
      nightlyRate: '6000',
    })
  ).body.data.id;
  const rooms = (await owner.post(`${base}/rooms/bulk`, { from: '501', to: '502', roomTypeId: std })).body
    .data;
  const guestId = (await desk.post('/guests', { fullName: 'Scenario E Guest' })).body.data.id;
  const book = (arrival: string, departure: string, roomId: string | null) =>
    ok(
      withKey(desk, '/reservations', {
        guestId,
        source: 'phone',
        rooms: [{ roomTypeId: std, roomId, arrival, departure, adults: 1 }],
      }),
    );

  // 1. A deposit for a future stay: cash in, a liability, not revenue.
  const future = await book('2026-10-21', '2026-10-23', null);
  await ok(withKey(desk, '/payments', { reservationId: future.id, amount: '5000', method: 'cash' }));

  // 2. An in-house guest: a dinner with 16% tax (revenue), a minibar charge voided, a bank payment, a refund.
  const stay = (await book('2026-10-19', '2026-10-20', rooms[0].id)) as {
    id: string;
    rooms: { id: string }[];
  };
  await ok(withKey(desk, `/reservations/${stay.id}/rooms/${stay.rooms[0]!.id}/check-in`), 200);
  const folioId = (await desk.get(`${base}/reservations/${stay.id}/folios`)).body.data[0].id;
  await ok(
    withKey(desk, `/folios/${folioId}/charges`, {
      categoryId: cat['fnb'],
      description: 'Dinner',
      unitPrice: '1000',
    }),
  );
  const minibar = (await ok(
    withKey(desk, `/folios/${folioId}/charges`, {
      categoryId: cat['fnb'],
      description: 'Minibar',
      unitPrice: '500',
    }),
  )) as { charges: { id: string; description: string }[] };
  const minibarId = minibar.charges.find((c) => c.description === 'Minibar')!.id;
  await ok(withKey(manager, `/folio-charges/${minibarId}/void`, { reason: 'Not taken' }), 200);
  const payment = await ok(withKey(desk, '/payments', { folioId, amount: '2000', method: 'bank_transfer' }));
  await ok(
    withKey(manager, `/payments/${payment.id as string}/refunds`, { amount: '340', reason: 'Overpaid' }),
  );

  // 3. A cash expense paid from the drawer.
  const expense = await ok(
    withKey(acc, '/expenses', {
      kind: 'cash',
      payee: 'Electrician',
      expenseDate: '2026-10-19',
      description: 'Corridor lights',
      cashAccountId: cash['Front desk cash'],
      lines: [{ accountId: account['6300'], amount: '300' }],
    }),
  );
  await ok(withKey(acc, `/expenses/${expense.id as string}/submit`), 200);

  // 4. Cash banked: a transfer.
  await ok(
    withKey(acc, '/transfers', {
      fromCashAccountId: cash['Front desk cash'],
      toCashAccountId: cash['Bank'],
      amount: '2000',
      reference: 'Deposit slip 1',
    }),
  );
});

afterAll(async () => {
  await h?.close();
});

const q = (path: string, extra = '') => acc.get(`/reports/${path}?${OCT}&propertyId=${h.fx.propA1}${extra}`);

describe('QA scenario E: reporting reconciliation', () => {
  it('reports revenue from the ledger, apart from cash received', async () => {
    const res = await q('revenue');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.categories.map((c: { code: string; total: string }) => `${c.code}:${c.total}`)).toEqual([
      '4100:1000.00',
    ]);
    expect(d.days).toEqual([{ date: '2026-10-19', amounts: ['1000.00'], total: '1000.00' }]);
    expect(d.total).toBe('1000.00');
    expect(d.receipts).toEqual([
      { method: 'cash', deposits: '5000.00', payments: '0.00', refunds: '0.00', net: '5000.00' },
      { method: 'bank_transfer', deposits: '0.00', payments: '2000.00', refunds: '340.00', net: '1660.00' },
    ]);
    expect(d.receiptsTotal).toBe('6660.00');
    // The same revenue as the P&L, where only the expense appears as a cost: the transfer is in neither.
    const pl = (await q('profit-loss')).body.data;
    expect(pl.sections.find((s: { key: string }) => s.key === 'revenue').total.amount).toBe(d.total);
    expect(pl.sections.find((s: { key: string }) => s.key === 'operating_expense').total.amount).toBe(
      '300.00',
    );
  });

  it('keeps the cashbook per drawer and bank, equal to the ledger', async () => {
    const d = (await q('cashbook')).body.data;
    const row = (name: string) => d.accounts.find((a: { name: string }) => a.name === name);
    expect(row('Front desk cash')).toMatchObject({
      opening: '0.00',
      receipts: '15000.00',
      payments: '2300.00',
      closing: '12700.00',
      ledgerAccountCode: '1000',
    });
    expect(row('Front desk cash').days).toEqual([
      { date: '2026-10-18', receipts: '10000.00', payments: '0.00', closing: '10000.00' },
      { date: '2026-10-19', receipts: '5000.00', payments: '2300.00', closing: '12700.00' },
    ]);
    expect(row('Bank')).toMatchObject({ receipts: '4000.00', payments: '340.00', closing: '3660.00' });
    expect(d.totals).toEqual({
      opening: '0.00',
      receipts: '19000.00',
      payments: '2640.00',
      closing: '16360.00',
    });
    expect(d.reconciled).toBe(true);
    expect(d.controls.find((c: { code: string }) => c.code === '1000')).toMatchObject({
      cashAccountsTotal: '12700.00',
      ledgerBalance: '12700.00',
      difference: '0.00',
    });
    // Opening balance for a later range, and the bank filter.
    const later = (
      await acc.get(`/reports/cashbook?from=2026-10-19&to=2026-10-19&propertyId=${h.fx.propA1}&kind=bank`)
    ).body.data;
    expect(later.accounts.map((a: { name: string }) => a.name)).toEqual(['Bank']);
    expect(row('Front desk cash').opening).toBe('0.00');
    expect(
      (
        await acc.get(`/reports/cashbook?from=2026-10-19&to=2026-10-31&propertyId=${h.fx.propA1}`)
      ).body.data.accounts.find((a: { name: string }) => a.name === 'Front desk cash').opening,
    ).toBe('10000.00');
  });

  it('classifies cash flow by the other side of each journal; transfers are neither in nor out', async () => {
    const d = (await q('cash-flow')).body.data;
    const line = (key: string) =>
      d.sections
        .flatMap((s: { lines: { key: string }[] }) => s.lines)
        .find((l: { key: string }) => l.key === key);
    expect(line('guest_deposits')).toEqual({
      key: 'guest_deposits',
      inflow: '5000.00',
      outflow: '0.00',
      net: '5000.00',
    });
    expect(line('receipts_from_guests')).toEqual({
      key: 'receipts_from_guests',
      inflow: '2000.00',
      outflow: '340.00',
      net: '1660.00',
    });
    expect(line('operating_expenses').net).toBe('-300.00');
    expect(line('opening_balances').net).toBe('10000.00');
    expect(line('owner_equity').net).toBe('0.00');
    expect(d).toMatchObject({
      openingCash: '0.00',
      netChange: '16360.00',
      closingCash: '16360.00',
      transfers: '2000.00',
      reconciles: true,
    });
    expect(d.sections.map((s: { key: string; net: string }) => `${s.key}:${s.net}`)).toEqual([
      'operating:6360.00',
      'investing:0.00',
      'financing:10000.00',
    ]);
    // The closing cash of the cash flow is the closing total of the cashbook.
    expect((await q('cashbook')).body.data.totals.closing).toBe(d.closingCash);
  });

  it('summarises tax on bills by code, voids taken off, tied to the tax account', async () => {
    const d = (await q('tax-summary')).body.data;
    expect(d.rows).toEqual([
      {
        code: 'PST',
        name: 'Sales tax',
        ratePercent: '16.0000',
        inclusive: false,
        accountCode: '2200',
        taxableBase: '1000.00',
        taxAmount: '160.00',
      },
    ]);
    expect(d.accounts).toEqual([
      expect.objectContaining({
        code: '2200',
        chargedOnBills: '160.00',
        ledgerMovement: '160.00',
        otherPostings: '0.00',
        closingBalance: '160.00',
      }),
    ]);
    expect(d.recoverablePurchaseTax).toBe('0.00');
    expect(d.definitions.note).toMatch(/not a tax return/);
  });

  it('refuses an end date before the start date', async () => {
    for (const path of ['cashbook', 'cash-flow', 'tax-summary', 'revenue']) {
      expect((await acc.get(`/reports/${path}?from=2026-10-31&to=2026-10-01`)).status).toBe(400);
    }
  });
});

describe('permissions and isolation', () => {
  const paths = () => ['cashbook', 'cash-flow', 'tax-summary', 'revenue'].map((p) => `/reports/${p}?${OCT}`);

  it('refuses front desk, cashier and housekeeping', async () => {
    const cashier = await browser(h).loginActive(h.fx.users.cashierA);
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    for (const c of [desk, cashier, hk]) {
      for (const p of paths()) expect((await c.get(`${p}&propertyId=${h.fx.propA1}`)).status).toBe(403);
    }
  });

  it('limits a property-scoped manager to their property', async () => {
    const m1 = await browser(h).loginActive(h.fx.users.managerA1);
    for (const p of paths()) {
      expect((await m1.get(`${p}&propertyId=${h.fx.propA1}`)).status).toBe(200);
      expect((await m1.get(`${p}&propertyId=${h.fx.propA2}`)).status).toBe(404);
      expect((await m1.get(p)).status).toBe(403);
    }
  });

  it('shows another tenant nothing', async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    for (const p of paths()) expect((await ownerB.get(`${p}&propertyId=${h.fx.propA1}`)).status).toBe(404);
    const own = (await ownerB.get(`/reports/cashbook?${OCT}`)).body.data;
    expect(own.totals.closing).toBe('0.00');
    expect((await ownerB.get(`/reports/revenue?${OCT}`)).body.data.receipts).toEqual([]);
    expect((await ownerB.get(`/reports/tax-summary?${OCT}`)).body.data.rows).toEqual([]);
  });
});
