/**
 * Phase 3 slice 3.4 — payments, deposits and refunds: FIN-007 (deposit is a liability), FIN-003 (retries never
 * duplicate money), Scenario C (refunds link to the payment and never exceed it), deposits on cancellation, and the
 * folio reconciliation (folio balance = its guest receivable + guest deposit lines in the ledger).
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

async function book(arrival: string, departure: string, roomId: string | null = null) {
  const res = await withKey(desk, '/reservations', {
    guestId,
    source: 'phone',
    rooms: [{ roomTypeId: std, roomId, arrival, departure, adults: 1 }],
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { id: res.body.data.id as string, rrId: res.body.data.rooms[0].id as string };
}
const folios = async (reservationId: string) =>
  (await desk.get(`${base}/reservations/${reservationId}/folios`)).body.data;

/** Folio reconciliation: guest receivable and guest deposit lines tagged with the folio sum to its balance. */
async function ledgerBalance(folioId: string): Promise<string> {
  const { rows } = await h.admin.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
     JOIN accounts a ON a.id = l.account_id
     WHERE l.folio_id = $1 AND a.system_role IN ('guest_receivable', 'guest_deposits') AND e.status <> 'draft'`,
    [folioId],
  );
  return rows[0]!.b;
}
async function accountBalance(code: string): Promise<string> {
  const { rows } = await h.admin.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
     WHERE a.tenant_id = $1 AND a.code = $2 AND e.status <> 'draft'`,
    [h.fx.tenantA, code],
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
  for (const r of (await owner.post(`${base}/rooms/bulk`, { from: '401', to: '404', roomTypeId: std })).body
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
  guestId = (await desk.post('/guests', { fullName: 'Paying Guest' })).body.data.id;
});

afterAll(async () => {
  await h?.close();
});

describe('deposits before check-in (FIN-007)', () => {
  let reservation: string;
  let folioId: string;
  let depositId: string;

  it('holds a deposit as a liability, not revenue, and opens the folio for it', async () => {
    reservation = (await book('2026-10-20', '2026-10-22')).id;
    const res = await withKey(desk, '/payments', {
      reservationId: reservation,
      amount: '5000',
      method: 'cash',
    });
    expect(res.status).toBe(201);
    depositId = res.body.data.id;
    folioId = res.body.data.folioId;
    expect(res.body.data).toMatchObject({
      kind: 'deposit',
      receiptNumber: 'RCT-000001',
      method: 'cash',
      cashAccountName: 'Front desk cash',
      amount: '5000.00',
      refundable: '5000.00',
    });
    const lines = await h.admin.query<{
      code: string;
      debit: string;
      credit: string;
      folio_id: string | null;
    }>(
      `SELECT a.code, l.debit::numeric(19,2)::text AS debit, l.credit::numeric(19,2)::text AS credit, l.folio_id
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.line_no`,
      [res.body.data.journalEntryId],
    );
    expect(lines.rows).toEqual([
      { code: '1000', debit: '5000.00', credit: '0.00', folio_id: null },
      { code: '2100', debit: '0.00', credit: '5000.00', folio_id: folioId },
    ]);
    expect(await accountBalance('4000')).toBe('0.00');
    const [folio] = await folios(reservation);
    expect(folio).toMatchObject({ balance: '-5000.00', received: '5000.00', depositHeld: '5000.00' });
    expect(await ledgerBalance(folioId)).toBe('-5000.00');
    expect((await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31')).body.data.balanced).toBe(
      true,
    );
  });

  it('refuses more than the stay can cost, and card numbers as references', async () => {
    // Two nights × 5,800 = 11,600; 5,000 is already held, so 6,600 is the most.
    const over = await withKey(desk, '/payments', { folioId, amount: '6600.01', method: 'cash' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    const card = await withKey(desk, '/payments', {
      folioId,
      amount: '100',
      method: 'card',
      externalReference: '4111 1111 1111 1111',
    });
    expect(card.status).toBe(400);
  });

  it('FIN-003: records one payment and one journal for many simultaneous retries', async () => {
    const key = randomUUID();
    const body = { folioId, amount: '1000', method: 'card', externalReference: 'AUTH 123456' };
    const results = await Promise.all(
      Array.from({ length: 10 }, () => withKey(desk, '/payments', body, key)),
    );
    const ok = results.filter((r) => r.status === 201);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(new Set(ok.map((r) => r.body.data.id)).size).toBe(1);
    expect(ok[0]!.body.data).toMatchObject({ receiptNumber: 'RCT-000002', cashAccountName: 'Card terminal' });
    const { rows } = await h.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM payments WHERE folio_id = $1`,
      [folioId],
    );
    expect(rows[0]!.n).toBe(2);
    expect(await ledgerBalance(folioId)).toBe('-6000.00');
  });

  it('Scenario C: refunds link to the payment, never exceed it, and keep the original intact', async () => {
    expect(
      (await withKey(desk, `/payments/${depositId}/refunds`, { amount: '100', reason: 'Asked' })).status,
    ).toBe(403);
    const refund = await withKey(manager, `/payments/${depositId}/refunds`, {
      amount: '1500',
      reason: 'Guest shortened the stay',
    });
    expect(refund.status).toBe(201);
    expect(refund.body.data).toMatchObject({
      amount: '5000.00',
      refunded: '1500.00',
      refundable: '3500.00',
      refunds: [
        { refundNumber: 'RF-000001', amount: '1500.00', method: 'cash', reason: 'Guest shortened the stay' },
      ],
    });
    const over = await withKey(manager, `/payments/${depositId}/refunds`, {
      amount: '3500.01',
      reason: 'Too much',
    });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_REMAINDER');
    // The deposit refund comes out of the deposit liability and the cash drawer. Both payments were taken before
    // check-in, so both are deposits: 5,000 + 1,000 − 1,500 is still held.
    expect(await ledgerBalance(folioId)).toBe('-4500.00');
    expect(await accountBalance('2100')).toBe('-4500.00');
  });

  it('needs a decision on the deposit before cancelling, and keeping it is a fee (P3-15)', async () => {
    const blocked = await desk.post(`${base}/reservations/${reservation}/cancel`, {
      reason: 'Plans changed',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('DEPOSIT_HANDLING_REQUIRED');
    expect(
      (
        await desk.post(`${base}/reservations/${reservation}/cancel`, {
          reason: 'Plans changed',
          deposit: 'forfeit',
        })
      ).status,
    ).toBe(403);

    const res = await manager.post(`${base}/reservations/${reservation}/cancel`, {
      reason: 'Plans changed',
      deposit: 'forfeit',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
    const [folio] = await folios(reservation);
    // Held: 3,500 left of the deposit + 1,000 card payment received before check-in (also a deposit).
    expect(folio.depositHeld).toBe('0.00');
    expect(folio.charges[0]).toMatchObject({
      categoryName: 'Cancellation and no-show fees',
      gross: '4500.00',
    });
    expect(folio.balance).toBe('0.00');
    expect(await ledgerBalance(folioId)).toBe('0.00');
    expect(await accountBalance('4500')).toBe('-4500.00');
    expect(await accountBalance('2100')).toBe('0.00');
  });
});

describe('payments during the stay', () => {
  let reservation: string;
  let folioId: string;
  let paymentId: string;

  it('posts against the receivable, and refunds only the credit the guest has', async () => {
    const booked = await book('2026-10-19', '2026-10-21', room['401']);
    reservation = booked.id;
    expect((await withKey(desk, `/reservations/${reservation}/rooms/${booked.rrId}/check-in`)).status).toBe(
      200,
    );
    folioId = (await folios(reservation))[0].id;

    const pay = await withKey(desk, '/payments', { folioId, amount: '1000', method: 'bank_transfer' });
    expect(pay.body.data).toMatchObject({ kind: 'payment', cashAccountName: 'Bank' });
    paymentId = pay.body.data.id;
    const credit = await h.admin.query<{ code: string }>(
      `SELECT a.code FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       WHERE l.journal_entry_id = $1 AND l.credit > 0`,
      [pay.body.data.journalEntryId],
    );
    expect(credit.rows[0]!.code).toBe('1200');

    await withKey(desk, `/folios/${folioId}/charges`, {
      categoryId: cat['fnb'],
      description: 'Dinner',
      unitPrice: '800',
    });
    const tooMuch = await withKey(manager, `/payments/${paymentId}/refunds`, {
      amount: '500',
      reason: 'Overpaid',
    });
    expect(tooMuch.status).toBe(409);
    const ok = await withKey(manager, `/payments/${paymentId}/refunds`, {
      amount: '200',
      reason: 'Overpaid',
    });
    expect(ok.status).toBe(201);
    expect((await folios(reservation))[0].balance).toBe('0.00');
    expect(await ledgerBalance(folioId)).toBe('0.00');
  });

  it('gives a receipt with the hotel details', async () => {
    await acc.put(`${base}/invoice-profile`, {
      legalName: 'A One Hospitality (Pvt) Ltd',
      address: null,
      registrationFields: [{ label: 'NTN', value: '0000000-1' }],
      invoicePrefix: 'INV-',
      receiptPrefix: 'RCT-',
      footer: 'Thank you.',
    });
    const res = await desk.get(`${base}/payments/${paymentId}/receipt`);
    expect(res.status).toBe(200);
    expect(res.body.data.hotel).toMatchObject({ name: 'A One', legalName: 'A One Hospitality (Pvt) Ltd' });
    expect(res.body.data.payment.refunds).toHaveLength(1);
  });

  it('refuses payments on a closed folio', async () => {
    const extra = await desk.post(`${base}/reservations/${reservation}/folios`, { label: 'Extras' });
    await h.admin.query(`UPDATE folios SET status = 'settled' WHERE id = $1`, [extra.body.data.id]);
    const res = await withKey(desk, '/payments', {
      folioId: extra.body.data.id,
      amount: '10',
      method: 'cash',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FOLIO_CLOSED');
  });

  it('keeps the trial balance in balance', async () => {
    expect((await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31')).body.data.balanced).toBe(
      true,
    );
  });
});

describe('cancelling with a deposit to refund', () => {
  it('leaves the guest in credit on an open folio until the refund is made', async () => {
    const reservation = (await book('2026-10-25', '2026-10-26')).id;
    const dep = await withKey(desk, '/payments', {
      reservationId: reservation,
      amount: '2000',
      method: 'cash',
    });
    const res = await desk.post(`${base}/reservations/${reservation}/cancel`, {
      reason: 'Changed',
      deposit: 'refund',
    });
    expect(res.status).toBe(200);
    const [folio] = await folios(reservation);
    expect(folio).toMatchObject({ status: 'open', balance: '-2000.00', depositHeld: '2000.00' });
    const refund = await withKey(manager, `/payments/${dep.body.data.id}/refunds`, {
      amount: '2000',
      reason: 'Cancelled in time',
    });
    expect(refund.status).toBe(201);
    expect((await folios(reservation))[0].balance).toBe('0.00');
    expect(await ledgerBalance(folio.id)).toBe('0.00');
  });
});

describe('payment permissions and isolation', () => {
  it('keeps payments within the tenant and roles', async () => {
    const list = await desk.get(`${base}/payments`);
    expect(list.status).toBe(200);
    const one = list.body.data[0].id;
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    expect((await hk.get(`${base}/payments/${one}`)).status).toBe(403);
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`${base}/payments/${one}`)).status).toBe(404);
    const baseB = `/properties/${h.fx.propB1}`;
    expect((await ownerB.get(`${baseB}/payments/${one}`)).status).toBe(404);
    const refund = await ownerB.agent
      .post(`/api/v1${baseB}/payments/${one}/refunds`)
      .set('origin', ORIGIN)
      .set('x-csrf-token', ownerB.csrf)
      .set('idempotency-key', randomUUID())
      .send({ amount: '1', reason: 'Not mine' });
    expect(refund.status).toBe(404);
  });
});
