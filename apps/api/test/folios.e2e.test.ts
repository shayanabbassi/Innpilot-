/**
 * Phase 3 slice 3.3 — folios: charges with tax snapshots, allowances, voids, transfers, pending room nights (D7),
 * and the folio reconciliation recipe (folio balance = receivable lines in the ledger for that folio).
 */
import { randomUUID } from 'node:crypto';
import type { FolioDto } from '@innpilot/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let desk: BrowserClient;
let manager: BrowserClient;
let base: string;
const cat: Record<string, string> = {};
const room: Record<string, string> = {};
let std: string;
let pst: string;
let reservationId: string;
let folioId: string;
let companyFolioId: string;
const charge: Record<string, string> = {};

const withKey = (c: BrowserClient, path: string, body: object = {}, key: string = randomUUID()) =>
  c.agent
    .post(`/api/v1${base}${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', key)
    .send(body);
const folio = async (id = folioId) => (await desk.get(`${base}/folios/${id}`)).body.data;
const find = (f: FolioDto, d: string) => f.charges.find((x) => x.description === d && x.status === 'posted')!;

/** Folio reconciliation: the guest receivable lines tagged with a folio must sum to its balance. */
async function ledgerBalance(id: string): Promise<string> {
  const { rows } = await h.admin.query<{ b: string }>(
    `SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2)::text AS b
     FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
     JOIN accounts a ON a.id = l.account_id
     WHERE l.folio_id = $1 AND a.system_role = 'guest_receivable' AND e.status <> 'draft'`,
    [id],
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
  for (const r of (await owner.post(`${base}/rooms/bulk`, { from: '301', to: '303', roomTypeId: std })).body
    .data) {
    room[r.roomNumber] = r.id;
  }
  for (const c of (await acc.get(`${base}/charge-categories`)).body.data) cat[c.code] = c.id;
  pst = (
    await acc.post(`${base}/tax-codes`, {
      code: 'PST',
      name: 'Sales tax',
      firstRate: { effectiveFrom: '2026-10-19', ratePercent: '16' },
    })
  ).body.data.id;
  await acc.patch(`${base}/charge-categories/${cat['room']}`, { taxCodeIds: [pst] });
  await acc.patch(`${base}/charge-categories/${cat['fnb']}`, { taxCodeIds: [pst] });

  const guestId = (await desk.post('/guests', { fullName: 'Folio Guest' })).body.data.id;
  const booked = await withKey(desk, '/reservations', {
    guestId,
    source: 'phone',
    rooms: [
      { roomTypeId: std, roomId: room['301'], arrival: '2026-10-19', departure: '2026-10-22', adults: 1 },
    ],
  });
  reservationId = booked.body.data.id;
  const checkIn = await withKey(
    desk,
    `/reservations/${reservationId}/rooms/${booked.body.data.rooms[0].id}/check-in`,
  );
  if (checkIn.status !== 200) throw new Error(JSON.stringify(checkIn.body));
});

afterAll(async () => {
  await h?.close();
});

describe('folio at check-in', () => {
  it('opens the main folio with the stay, empty, with the booked nights as an estimate', async () => {
    const res = await desk.get(`${base}/reservations/${reservationId}/folios`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    const f = res.body.data[0];
    folioId = f.id;
    expect(f).toMatchObject({
      isPrimary: true,
      status: 'open',
      label: 'Main',
      guestName: 'Folio Guest',
      charges: [],
      balance: '0.00',
      pendingNights: [],
      // 3 nights × 5,000 + 16% = 17,400.
      stayEstimate: { nights: 3, net: '15000.00', tax: '2400.00', gross: '17400.00' },
    });
  });

  it('opens one for walk-ins too', async () => {
    const walkIn = await withKey(desk, '/walk-ins', {
      guest: { fullName: 'Walk In Folio' },
      roomId: room['302'],
      departure: '2026-10-20',
      adults: 1,
    });
    expect(walkIn.status).toBe(201);
    const folios = (await desk.get(`${base}/reservations/${walkIn.body.data.reservationId}/folios`)).body
      .data;
    expect(folios.map((x: { isPrimary: boolean }) => x.isPrimary)).toEqual([true]);
  });
});

describe('charges', () => {
  it('posts a charge with tax, once per key, and balances in the ledger', async () => {
    const key = randomUUID();
    const body = { categoryId: cat['fnb'], description: 'Dinner', quantity: '2', unitPrice: '1250.50' };
    const res = await withKey(desk, `/folios/${folioId}/charges`, body, key);
    expect(res.status).toBe(201);
    const dinner = find(res.body.data, 'Dinner');
    charge['dinner'] = dinner.id;
    expect(dinner).toMatchObject({
      kind: 'charge',
      quantity: '2',
      unitPrice: '1250.50',
      net: '2501.00',
      tax: '400.16',
      gross: '2901.16',
      taxes: [{ code: 'PST', ratePercent: '16', inclusive: false, amount: '400.16' }],
    });
    expect(res.body.data.balance).toBe('2901.16');

    const replay = await withKey(desk, `/folios/${folioId}/charges`, body, key);
    expect(replay.body.data.charges).toHaveLength(1);

    const lines = await h.admin.query<{
      code: string;
      debit: string;
      credit: string;
      folio_id: string | null;
    }>(
      `SELECT a.code, l.debit::numeric(19,2)::text AS debit, l.credit::numeric(19,2)::text AS credit, l.folio_id
       FROM journal_lines l JOIN accounts a ON a.id = l.account_id
       JOIN folio_charges c ON c.journal_entry_id = l.journal_entry_id WHERE c.id = $1 ORDER BY l.line_no`,
      [dinner.id],
    );
    expect(lines.rows).toEqual([
      { code: '1200', debit: '2901.16', credit: '0.00', folio_id: folioId },
      { code: '4100', debit: '0.00', credit: '2501.00', folio_id: null },
      { code: '2200', debit: '0.00', credit: '400.16', folio_id: null },
    ]);
    expect(await ledgerBalance(folioId)).toBe('2901.16');
  });

  it('refuses room-night charges, future dates and inactive categories', async () => {
    const post = (body: object) => withKey(desk, `/folios/${folioId}/charges`, body);
    expect((await post({ categoryId: cat['room'], description: 'Night', unitPrice: '5000' })).status).toBe(
      400,
    );
    expect(
      (
        await post({
          categoryId: cat['fnb'],
          description: 'Tomorrow',
          unitPrice: '10',
          serviceDate: '2026-10-20',
        })
      ).status,
    ).toBe(400);
    await acc.patch(`${base}/charge-categories/${cat['meeting']}`, { active: false });
    expect((await post({ categoryId: cat['meeting'], description: 'Hall', unitPrice: '10' })).status).toBe(
      400,
    );
  });

  it('lets only folio.adjust holders post allowances, void or transfer', async () => {
    expect(
      (
        await withKey(desk, `/folios/${folioId}/allowances`, {
          categoryId: cat['fnb'],
          description: 'Goodwill',
          amount: '100',
          reason: 'Cold food',
        })
      ).status,
    ).toBe(403);
    expect(
      (await withKey(desk, `/folio-charges/${charge['dinner']}/void`, { reason: 'Mistake' })).status,
    ).toBe(403);
  });

  it('posts an allowance as a negative item with tax reversed, and needs a reason', async () => {
    expect(
      (
        await withKey(manager, `/folios/${folioId}/allowances`, {
          categoryId: cat['fnb'],
          description: 'Goodwill',
          amount: '100',
        })
      ).status,
    ).toBe(400);
    const res = await withKey(manager, `/folios/${folioId}/allowances`, {
      categoryId: cat['fnb'],
      description: 'Goodwill',
      amount: '100',
      reason: 'Dinner served late',
    });
    expect(res.status).toBe(201);
    expect(find(res.body.data, 'Goodwill')).toMatchObject({
      kind: 'allowance',
      net: '-100.00',
      tax: '-16.00',
      gross: '-116.00',
      reason: 'Dinner served late',
    });
    expect(res.body.data.balance).toBe('2785.16');
    expect(await ledgerBalance(folioId)).toBe('2785.16');
  });
});

describe('corrections', () => {
  it('voids an item by reversing its journal exactly; the item stays, marked voided', async () => {
    const res = await withKey(manager, `/folio-charges/${charge['dinner']}/void`, {
      reason: 'Charged to wrong room',
    });
    expect(res.status).toBe(200);
    const voided = res.body.data.charges.find((x: { id: string }) => x.id === charge['dinner']);
    expect(voided).toMatchObject({
      status: 'voided',
      voidReason: 'Charged to wrong room',
      voidedByName: 'manager@a.test',
    });
    expect(res.body.data.balance).toBe('-116.00');
    expect(await ledgerBalance(folioId)).toBe('-116.00');
    expect(
      (await withKey(manager, `/folio-charges/${charge['dinner']}/void`, { reason: 'Again' })).status,
    ).toBe(409);
  });

  it('transfers an item to another folio; the receivable moves, revenue does not', async () => {
    const company = await desk.post(`${base}/reservations/${reservationId}/folios`, { label: 'Company' });
    expect(company.status).toBe(201);
    companyFolioId = company.body.data.id;
    const lunch = await withKey(desk, `/folios/${folioId}/charges`, {
      categoryId: cat['fnb'],
      description: 'Business lunch',
      unitPrice: '1000',
    });
    const lunchId = find(lunch.body.data, 'Business lunch').id;

    const open = (await desk.get(`${base}/folios`)).body.data;
    expect(open.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([folioId, companyFolioId]));

    const res = await withKey(manager, `/folio-charges/${lunchId}/transfer`, {
      toFolioId: companyFolioId,
      reason: 'Company pays business meals',
    });
    expect(res.status).toBe(200);
    const moved = res.body.data.charges.find((x: { id: string }) => x.id === lunchId);
    expect(moved.status).toBe('transferred');
    expect(moved.transferredTo.folioLabel).toBe('Company');
    const target = await folio(companyFolioId);
    expect(target.charges[0]).toMatchObject({
      gross: '1160.00',
      status: 'posted',
      transferredFrom: { chargeId: lunchId },
    });
    expect(target.balance).toBe('1160.00');
    expect(await ledgerBalance(companyFolioId)).toBe('1160.00');
    expect(await ledgerBalance(folioId)).toBe((await folio()).balance);

    // Voiding it on the company folio reverses the original revenue and tax, not the transfer.
    const voided = await withKey(manager, `/folio-charges/${target.charges[0].id}/void`, {
      reason: 'Company declined',
    });
    expect(voided.body.data.balance).toBe('0.00');
    expect(await ledgerBalance(companyFolioId)).toBe('0.00');
    const revenue = await h.admin.query<{ b: string }>(
      `SELECT coalesce(sum(l.credit - l.debit), 0)::numeric(19,2)::text AS b FROM journal_lines l
       JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.journal_entry_id
       WHERE a.tenant_id = $1 AND a.code = '4100' AND e.status <> 'draft'`,
      [h.fx.tenantA],
    );
    // Dinner voided, lunch voided: only the −100 allowance remains on F&B revenue.
    expect(revenue.rows[0]!.b).toBe('-100.00');
  });

  it('keeps the trial balance in balance', async () => {
    const tb = await acc.get('/finance/trial-balance?from=2026-10-01&to=2026-10-31');
    expect(tb.body.data.balanced).toBe(true);
  });
});

describe('pending room nights and tax snapshots', () => {
  it('TAX-001: a later rate leaves posted charges at their original rate', async () => {
    await acc.post(`${base}/tax-codes/${pst}/rates`, { effectiveFrom: '2026-10-20', ratePercent: '17' });
    const close = await withKey(manager, '/day-close', {
      businessDate: '2026-10-19',
      markNoShows: true,
      reason: 'Test close',
    });
    expect(close.status).toBe(200);

    const tea = await withKey(desk, `/folios/${folioId}/charges`, {
      categoryId: cat['fnb'],
      description: 'Tea',
      unitPrice: '100',
    });
    expect(find(tea.body.data, 'Tea')).toMatchObject({ serviceDate: '2026-10-20', tax: '17.00' });
    // The allowance posted on the 19th still shows 16%.
    expect(find(tea.body.data, 'Goodwill').taxes[0]).toMatchObject({ ratePercent: '16', amount: '-16.00' });
  });

  it('shows nights slept as pending (not posted), each at the tax rate of its own date', async () => {
    const f = await folio();
    expect(f.pendingNights).toEqual([
      {
        date: '2026-10-19',
        roomNumber: '301',
        rate: '5000.00',
        net: '5000.00',
        tax: '800.00',
        gross: '5800.00',
      },
    ]);
    expect(f.pending.gross).toBe('5800.00');
    // Tea 117 − allowance 116 = 1.00 posted; plus the pending night.
    expect(f.balance).toBe('1.00');
    expect(f.balanceWithPending).toBe('5801.00');
    // Estimate: 19th at 16%, 20th and 21st at 17%.
    expect(f.stayEstimate).toMatchObject({ nights: 3, gross: '17500.00' });
    expect(await ledgerBalance(folioId)).toBe('1.00');
  });

  it('refuses changes on a closed folio', async () => {
    await h.admin.query(`UPDATE folios SET status = 'settled' WHERE id = $1`, [companyFolioId]);
    const res = await withKey(desk, `/folios/${companyFolioId}/charges`, {
      categoryId: cat['fnb'],
      description: 'Late',
      unitPrice: '10',
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FOLIO_CLOSED');
  });
});

describe('folio permissions and isolation', () => {
  it('keeps housekeeping out and another tenant away from folios and items', async () => {
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    expect((await hk.get(`${base}/folios/${folioId}`)).status).toBe(403);
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`${base}/folios/${folioId}`)).status).toBe(404);
    const baseB = `/properties/${h.fx.propB1}`;
    expect((await ownerB.get(`${baseB}/folios/${folioId}`)).status).toBe(404);
    const tea = find(await folio(), 'Tea');
    const res = await ownerB.agent
      .post(`/api/v1${baseB}/folio-charges/${tea.id}/void`)
      .set('origin', ORIGIN)
      .set('x-csrf-token', ownerB.csrf)
      .set('idempotency-key', randomUUID())
      .send({ reason: 'Not mine' });
    expect(res.status).toBe(404);
  });
});
