/**
 * Phase 3 slice 3.5 — check-out: room nights posted at check-out (D7), deposits applied, settlement before closing
 * (FIN-008), one cleaning task (OPS-003), frozen invoices, and QA scenario A from booking to invoice.
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

async function book(arrival: string, departure: string, roomIds: (string | null)[]) {
  const res = await withKey(desk, '/reservations', {
    guestId,
    source: 'phone',
    rooms: roomIds.map((roomId) => ({ roomTypeId: std, roomId, arrival, departure, adults: 1 })),
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return {
    id: res.body.data.id as string,
    rr: res.body.data.rooms.map((r: { id: string }) => r.id) as string[],
  };
}
async function checkIn(reservationId: string, rrId: string) {
  const res = await withKey(desk, `/reservations/${reservationId}/rooms/${rrId}/check-in`);
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.data.id as string;
}
const businessDate = async () =>
  (await h.admin.query('SELECT business_date::text AS d FROM properties WHERE id = $1', [h.fx.propA1]))
    .rows[0].d;
async function closeDay() {
  const res = await withKey(manager, '/day-close', {
    businessDate: await businessDate(),
    markNoShows: true,
    reason: 'Test day close',
  });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
}
const folios = async (reservationId: string) =>
  (await desk.get(`${base}/reservations/${reservationId}/folios`)).body.data;
async function ledgerBalance(folioId: string): Promise<string> {
  const { rows } = await h.admin.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
     WHERE l.folio_id = $1 AND a.system_role IN ('guest_receivable', 'guest_deposits') AND e.status <> 'draft'`,
    [folioId],
  );
  return rows[0]!.b;
}

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
  for (const r of (await owner.post(`${base}/rooms/bulk`, { from: '501', to: '508', roomTypeId: std })).body
    .data) {
    room[r.roomNumber] = r.id;
  }
  for (const c of (await acc.get(`${base}/charge-categories`)).body.data) cat[c.code] = c.id;
  const pst = await acc.post(`${base}/tax-codes`, {
    code: 'PST',
    name: 'Sales tax',
    firstRate: { effectiveFrom: '2026-10-19', ratePercent: '16' },
  });
  await acc.patch(`${base}/charge-categories/${cat['room']}`, { taxCodeIds: [pst.body.data.id] });
  guestId = (await desk.post('/guests', { fullName: 'Departing Guest' })).body.data.id;
});

afterAll(async () => {
  await h?.close();
});

describe('Scenario A: booking to check-out and invoice', () => {
  let reservation: string;
  let stayId: string;
  let folioId: string;
  const key = randomUUID();
  let invoiceId: string;

  it('takes a deposit, checks in, charges dinner and runs two nights', async () => {
    const b = await book('2026-10-19', '2026-10-21', [room['501']!]);
    reservation = b.id;
    expect(
      (await withKey(desk, '/payments', { reservationId: reservation, amount: '3000', method: 'cash' }))
        .status,
    ).toBe(201);
    stayId = await checkIn(reservation, b.rr[0]!);
    folioId = (await folios(reservation))[0].id;
    await withKey(desk, `/folios/${folioId}/charges`, {
      categoryId: cat['fnb'],
      description: 'Dinner',
      unitPrice: '1000',
    });
    await closeDay();
    await closeDay();
    expect(await businessDate()).toBe('2026-10-21');
    // Nothing posted for the nights yet (D7): only dinner and the deposit.
    expect((await folios(reservation))[0]).toMatchObject({
      balance: '-2000.00',
      pending: { gross: '11600.00' },
    });
  });

  it('previews what check-out will do', async () => {
    const res = await desk.get(`${base}/stays/${stayId}/checkout-preview`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      isLastStay: true,
      nights: [
        { date: '2026-10-19', roomNumber: '501', net: '5000.00', tax: '800.00', gross: '5800.00' },
        { date: '2026-10-20', roomNumber: '501', net: '5000.00', tax: '800.00', gross: '5800.00' },
      ],
      nightsTotal: { gross: '11600.00' },
      folios: [
        {
          folioId,
          currentBalance: '-2000.00',
          nightsToPost: '11600.00',
          depositToApply: '3000.00',
          balanceAfter: '9600.00',
          needs: 'payment',
        },
      ],
    });
    // The preview changed nothing.
    const posted = await h.admin.query('SELECT 1 FROM room_night_charges');
    expect(posted.rowCount).toBe(0);
  });

  it('FIN-008: refuses to check out with an unsettled balance, and changes nothing', async () => {
    const res = await withKey(desk, `/stays/${stayId}/check-out`, {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SETTLEMENT_REQUIRED');
    expect(res.body.error.details[0]).toMatchObject({ path: folioId });
    expect((await h.admin.query('SELECT 1 FROM room_night_charges')).rowCount).toBe(0);
    expect((await h.admin.query('SELECT status FROM stays WHERE id = $1', [stayId])).rows[0].status).toBe(
      'in_house',
    );
  });

  it('checks out with payment: nights posted once, deposit applied, folio settled, invoice issued (OPS-003)', async () => {
    const body = {
      settlements: [{ folioId, action: 'pay', method: 'card', externalReference: 'AUTH 4455' }],
    };
    const res = await withKey(desk, `/stays/${stayId}/check-out`, body, key);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      reservationStatus: 'checked_out',
      nightsPosted: 2,
      folios: [{ folioId, status: 'settled' }],
      invoices: [{ invoiceNumber: 'INV-000001', gross: '12600.00', balanceDue: '0.00' }],
    });
    invoiceId = res.body.data.invoices[0].id;

    // A retry with the same key changes nothing; a new attempt is refused.
    const replay = await withKey(desk, `/stays/${stayId}/check-out`, body, key);
    expect(replay.body.data.invoices[0].id).toBe(invoiceId);
    expect((await withKey(desk, `/stays/${stayId}/check-out`, body)).status).toBe(409);
    expect((await h.admin.query('SELECT 1 FROM room_night_charges')).rowCount).toBe(2);

    const f = (await folios(reservation))[0];
    expect(f).toMatchObject({ status: 'settled', balance: '0.00', depositHeld: '0.00' });
    expect(f.invoices).toEqual([{ id: invoiceId, invoiceNumber: 'INV-000001' }]);
    expect(await ledgerBalance(folioId)).toBe('0.00');

    // OPS-003: the room is dirty with exactly one open cleaning task, and the stay is over.
    const roomRow = await h.admin.query('SELECT housekeeping_state FROM rooms WHERE id = $1', [room['501']]);
    expect(roomRow.rows[0].housekeeping_state).toBe('dirty');
    const tasks = await h.admin.query(
      `SELECT count(*)::int AS n FROM housekeeping_tasks WHERE room_id = $1 AND task_type = 'clean'
       AND status IN ('open', 'in_progress')`,
      [room['501']],
    );
    expect(tasks.rows[0].n).toBe(1);
    expect((await h.admin.query('SELECT status FROM stays WHERE id = $1', [stayId])).rows[0].status).toBe(
      'checked_out',
    );
  });

  it('still shows the stay after check-out (found by the 6.8 route probe: it answered 500)', async () => {
    const res = await desk.get(`${base}/stays/${stayId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: stayId, status: 'checked_out' });
    expect(res.body.data.roomNumber).toBeTruthy();
  });

  it('issues an invoice frozen with its lines, tax summary and hotel details', async () => {
    const res = await desk.get(`${base}/invoices/${invoiceId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      invoiceNumber: 'INV-000001',
      issueDate: '2026-10-21',
      billTo: 'Departing Guest',
      net: '11000.00',
      tax: '1600.00',
      gross: '12600.00',
      paid: '12600.00',
      balanceDue: '0.00',
      taxSummary: [{ code: 'PST', ratePercent: '16', base: '10000.00', amount: '1600.00' }],
    });
    expect(
      res.body.data.lines.map((l: { description: string; gross: string }) => [l.description, l.gross]),
    ).toEqual([
      ['Dinner', '1000.00'],
      ['Room 501, night of 2026-10-19', '5800.00'],
      ['Room 501, night of 2026-10-20', '5800.00'],
    ]);
    await acc.put(`${base}/invoice-profile`, {
      legalName: 'Renamed Hotels Ltd',
      address: null,
      registrationFields: [],
      invoicePrefix: 'NEW-',
      receiptPrefix: 'RCT-',
      footer: null,
    });
    const again = await desk.get(`${base}/invoices/${invoiceId}`);
    expect(again.body.data.hotel.legalName).not.toBe('Renamed Hotels Ltd');
    expect(again.body.data.invoiceNumber).toBe('INV-000001');
  });

  it('keeps the trial balance in balance with revenue only from posted nights', async () => {
    const tb = await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31');
    expect(tb.body.data.balanced).toBe(true);
    const roomRevenue = tb.body.data.rows.find((r: { code: string }) => r.code === '4000');
    expect(roomRevenue.closingCredit).toBe('10000.00');
  });
});

describe('other ways to settle', () => {
  it('writes off a balance on an early departure (folio.adjust only), freeing the later nights', async () => {
    const b = await book('2026-10-21', '2026-10-24', [room['502']!]);
    const stay = await checkIn(b.id, b.rr[0]!);
    await closeDay(); // now 2026-10-22: one night slept
    const folioId = (await folios(b.id))[0].id;
    const settle = { settlements: [{ folioId, action: 'write_off', reason: 'Guest left without paying' }] };
    expect((await withKey(desk, `/stays/${stay}/check-out`, settle)).status).toBe(403);
    const res = await withKey(manager, `/stays/${stay}/check-out`, settle);
    expect(res.status).toBe(200);
    expect(res.body.data.nightsPosted).toBe(1);
    const f = (await folios(b.id))[0];
    expect(f).toMatchObject({ status: 'settled', writtenOff: '5800.00', balance: '0.00' });
    expect(await ledgerBalance(folioId)).toBe('0.00');
    const dep = await h.admin.query('SELECT departure::text AS d FROM reservation_rooms WHERE id = $1', [
      b.rr[0],
    ]);
    expect(dep.rows[0].d).toBe('2026-10-22');
    const invoice = await desk.get(`${base}/invoices/${res.body.data.invoices[0].id}`);
    expect(invoice.body.data).toMatchObject({
      gross: '5800.00',
      paid: '0.00',
      writtenOff: '5800.00',
      balanceDue: '0.00',
    });
  });

  it('refunds a credit at check-out', async () => {
    const walkIn = await withKey(desk, '/walk-ins', {
      guest: { fullName: 'Prepaid Walk In' },
      roomId: room['503'],
      departure: '2026-10-24',
      adults: 1,
    });
    const reservation = walkIn.body.data.reservationId;
    const folioId = (await folios(reservation))[0].id;
    await withKey(desk, '/payments', { folioId, amount: '10000', method: 'cash' });
    await closeDay(); // 2026-10-23: one night slept, guest leaves early
    const res = await withKey(manager, `/stays/${walkIn.body.data.id}/check-out`, {
      settlements: [{ folioId, action: 'refund', method: 'cash', reason: 'Left a day early' }],
    });
    expect(res.status).toBe(200);
    const f = (await folios(reservation))[0];
    expect(f).toMatchObject({ status: 'settled', balance: '0.00', refunded: '4200.00' });
    expect(await ledgerBalance(folioId)).toBe('0.00');
  });

  it('moves a balance to the guest’s account; later payments still land and close it', async () => {
    const b = await book('2026-10-23', '2026-10-24', [room['504']!]);
    const stay = await checkIn(b.id, b.rr[0]!);
    await closeDay(); // 2026-10-24
    const folioId = (await folios(b.id))[0].id;
    const res = await withKey(manager, `/stays/${stay}/check-out`, {
      settlements: [{ folioId, action: 'on_account', reason: 'Company pays monthly' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.invoices[0]).toMatchObject({ balanceDue: '5800.00' });
    expect((await folios(b.id))[0]).toMatchObject({ status: 'on_account', balance: '5800.00' });
    expect(
      (
        await withKey(desk, `/folios/${folioId}/charges`, {
          categoryId: cat['fnb'],
          description: 'Late',
          unitPrice: '1',
        })
      ).status,
    ).toBe(409);
    const pay = await withKey(desk, '/payments', { folioId, amount: '5800', method: 'bank_transfer' });
    expect(pay.status).toBe(201);
    expect(pay.body.data.kind).toBe('payment');
    expect((await folios(b.id))[0]).toMatchObject({ status: 'settled', balance: '0.00' });
  });

  it('settles only when the last guest of a booking leaves', async () => {
    const b = await book('2026-10-24', '2026-10-25', [room['505']!, room['506']!]);
    const first = await checkIn(b.id, b.rr[0]!);
    const second = await checkIn(b.id, b.rr[1]!);
    await closeDay(); // 2026-10-25
    const one = await withKey(desk, `/stays/${first}/check-out`, {});
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ reservationStatus: 'checked_in', nightsPosted: 1, invoices: [] });
    const folioId = (await folios(b.id))[0].id;
    expect((await withKey(desk, `/stays/${second}/check-out`, {})).status).toBe(409);
    const two = await withKey(desk, `/stays/${second}/check-out`, {
      settlements: [{ folioId, action: 'pay', method: 'cash' }],
    });
    expect(two.status).toBe(200);
    expect(two.body.data).toMatchObject({ reservationStatus: 'checked_out', nightsPosted: 1 });
    expect(two.body.data.invoices[0].gross).toBe('11600.00');
  });
});

describe('check-out permissions and isolation', () => {
  it('keeps housekeeping and other tenants out', async () => {
    const b = await book('2026-10-25', '2026-10-26', [room['507']!]);
    const stay = await checkIn(b.id, b.rr[0]!);
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    expect((await hk.get(`${base}/stays/${stay}/checkout-preview`)).status).toBe(403);
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`${base}/stays/${stay}/checkout-preview`)).status).toBe(404);
    const baseB = `/properties/${h.fx.propB1}`;
    const res = await ownerB.agent
      .post(`/api/v1${baseB}/stays/${stay}/check-out`)
      .set('origin', ORIGIN)
      .set('x-csrf-token', ownerB.csrf)
      .set('idempotency-key', randomUUID())
      .send({});
    expect(res.status).toBe(404);
    const invoices = await h.admin.query<{ id: string }>('SELECT id FROM invoices LIMIT 1');
    expect((await ownerB.get(`${baseB}/invoices/${invoices.rows[0]!.id}`)).status).toBe(404);
  });
});
