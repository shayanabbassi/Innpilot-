import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let manager: BrowserClient;
let desk: BrowserClient;
let hk: BrowserClient;
let base: string;
let std: string;
const room: Record<string, string> = {};
let guestId: string;

const withKey = (c: BrowserClient, path: string, body: object, key: string = randomUUID()) =>
  c.agent
    .post(`/api/v1${base}${path}`)
    .set('origin', 'http://localhost:3000')
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', key)
    .send(body);

const close = (body: object, key?: string) => withKey(manager, '/day-close', body, key);
const businessDate = async () =>
  (await h.admin.query('SELECT business_date::text AS d FROM properties WHERE id = $1', [h.fx.propA1]))
    .rows[0].d;
const serviceState = async (n: string) =>
  (await h.admin.query('SELECT service_state FROM rooms WHERE id = $1', [room[n]])).rows[0].service_state;

async function book(roomId: string | null, arrival: string, departure: string) {
  const res = await withKey(desk, '/reservations', {
    guestId,
    source: 'phone',
    rooms: [{ roomTypeId: std, roomId, arrival, departure, adults: 1 }],
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return {
    id: res.body.data.id as string,
    rrId: res.body.data.rooms[0].id as string,
    ref: res.body.data.bookingReference,
  };
}

beforeAll(async () => {
  h = await startHarness();
  const owner = await browser(h).loginActive(h.fx.users.ownerA);
  manager = await browser(h).loginActive(h.fx.users.managerA);
  desk = await browser(h).loginActive(h.fx.users.deskA);
  hk = await browser(h).loginActive(h.fx.users.housekeepingA);
  base = `/properties/${h.fx.propA1}`;
  const type = await owner.post(`${base}/room-types`, {
    code: 'STD',
    name: 'Standard',
    capacityAdults: 2,
    capacityChildren: 0,
    nightlyRate: '5000',
  });
  std = type.body.data.id;
  const rooms = await owner.post(`${base}/rooms/bulk`, { from: '101', to: '103', roomTypeId: std });
  for (const r of rooms.body.data) room[r.roomNumber] = r.id;
  guestId = (await desk.post('/guests', { fullName: 'Day Close Guest' })).body.data.id;
});

afterAll(async () => {
  await h?.close();
});

describe('day close', () => {
  it('closes a clean day without a reason and advances the date by one', async () => {
    const preview = await manager.get(`${base}/day-close/preview`);
    expect(preview.body.data).toMatchObject({
      businessDate: '2026-10-19',
      nextDate: '2026-10-20',
      issues: [],
    });
    const key = randomUUID();
    const res = await close({ businessDate: '2026-10-19' }, key);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      businessDate: '2026-10-19',
      nextDate: '2026-10-20',
      unresolved: [],
    });
    expect(await businessDate()).toBe('2026-10-20');

    const replay = await close({ businessDate: '2026-10-19' }, key);
    expect(replay.body.data.id).toBe(res.body.data.id);
    const stale = await close({ businessDate: '2026-10-19' });
    expect(stale.status).toBe(409);
    expect(await businessDate()).toBe('2026-10-20');
    const me = await manager.get('/auth/me');
    expect(me.body.data.properties.find((p: { id: string }) => p.id === h.fx.propA1).businessDate).toBe(
      '2026-10-20',
    );
  });

  it('lists open items, and needs no-shows marked or a reason before closing', async () => {
    const noShow = await book(null, '2026-10-20', '2026-10-21');
    const guest = await book(room['101']!, '2026-10-20', '2026-10-21');
    expect((await withKey(desk, `/reservations/${guest.id}/rooms/${guest.rrId}/check-in`, {})).status).toBe(
      200,
    );
    await hk.post(`${base}/rooms/${room['102']}/housekeeping-state`, { state: 'dirty' });

    const preview = await manager.get(`${base}/day-close/preview`);
    const checks = preview.body.data.issues.map(
      (i: { check: string; label: string }) => `${i.check}:${i.label}`,
    );
    expect(checks).toEqual(expect.arrayContaining([`arrivals_pending:${noShow.ref}`, 'rooms_not_clean:102']));
    expect(preview.body.data.counts).toMatchObject({ inHouse: 1, arrivalsCheckedIn: 1, arrivalsPending: 1 });

    const blocked = await close({ businessDate: '2026-10-20' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['arrivals_pending', 'rooms_not_clean']),
    );
    // Marking no-shows clears the arrivals, but the dirty room still needs a reason.
    expect((await close({ businessDate: '2026-10-20', markNoShows: true })).status).toBe(409);
    expect((await desk.get(`${base}/reservations/${noShow.id}`)).body.data.status).toBe('confirmed');

    const res = await close({
      businessDate: '2026-10-20',
      markNoShows: true,
      reason: 'Room 102 cleaned first thing',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.noShowsMarked).toBe(1);
    expect(res.body.data.unresolved.map((i: { check: string }) => i.check)).toEqual(['rooms_not_clean']);
    expect((await desk.get(`${base}/reservations/${noShow.id}`)).body.data.status).toBe('no_show');
    expect((await desk.get(`${base}/reservations/${guest.id}`)).body.data.status).toBe('checked_in');
  });

  it('flags guests still in house after their departure date', async () => {
    const preview = await manager.get(`${base}/day-close/preview`);
    expect(preview.body.data.businessDate).toBe('2026-10-21');
    expect(preview.body.data.issues.find((i: { check: string }) => i.check === 'overstays')).toMatchObject({
      detail: 'Due out 2026-10-21',
    });
  });

  it('starts and ends out-of-order periods on the right dates', async () => {
    const ticket = await manager.post(`${base}/maintenance/tickets`, {
      roomId: room['103'],
      category: 'electrical',
      description: 'Rewire',
      outOfOrder: { from: '2026-10-22', to: '2026-10-23' },
    });
    expect(ticket.status).toBe(201);
    expect(await serviceState('103')).toBe('in_service');
    const preview = await manager.get(`${base}/day-close/preview`);
    expect(preview.body.data.serviceChanges).toEqual([
      { roomId: room['103'], roomNumber: '103', to: 'out_of_order' },
    ]);

    expect((await close({ businessDate: '2026-10-21', reason: 'Overstay agreed with guest' })).status).toBe(
      200,
    );
    expect(await serviceState('103')).toBe('out_of_order');
    expect((await close({ businessDate: '2026-10-22', reason: 'Overstay agreed with guest' })).status).toBe(
      200,
    );
    expect(await serviceState('103')).toBe('in_service');
  });

  it('lets exactly one of several simultaneous closes through', async () => {
    const date = await businessDate();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => close({ businessDate: date, reason: 'Concurrent close test' })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    const { rows } = await h.admin.query(
      'SELECT count(*)::int AS n FROM business_date_closes WHERE property_id = $1 AND business_date = $2',
      [h.fx.propA1, date],
    );
    expect(rows[0].n).toBe(1);
  });

  it('keeps a history, newest first', async () => {
    const res = await manager.get(`${base}/day-close/history`);
    expect(res.body.data.map((c: { businessDate: string }) => c.businessDate)).toEqual([
      '2026-10-23',
      '2026-10-22',
      '2026-10-21',
      '2026-10-20',
      '2026-10-19',
    ]);
    expect(res.body.data[0].closedByName).toBeTruthy();
  });
});

describe('day close permissions', () => {
  it('is for managers only, within their own tenant', async () => {
    expect((await desk.get(`${base}/day-close/preview`)).status).toBe(403);
    expect((await withKey(desk, '/day-close', { businessDate: await businessDate() })).status).toBe(403);
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`${base}/day-close/preview`)).status).toBe(404);
  });
});
