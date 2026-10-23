import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let owner: BrowserClient;
let manager: BrowserClient;
let desk: BrowserClient;
let base: string;
const t = { std: '', dlx: '' };
const room: Record<string, string> = {};
let guestId: string;

const withKey = (c: BrowserClient, path: string, body: object, key: string = randomUUID()) =>
  c.agent
    .post(`/api/v1${base}${path}`)
    .set('origin', 'http://localhost:3000')
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', key)
    .send(body);

async function booking(roomId: string | null, arrival: string, departure: string, status = 'confirmed') {
  const res = await withKey(desk, '/reservations', {
    guestId,
    source: 'phone',
    status,
    rooms: [{ roomTypeId: t.std, roomId, arrival, departure, adults: 2 }],
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return { id: res.body.data.id as string, rrId: res.body.data.rooms[0].id as string };
}

const checkIn = (c: BrowserClient, b: { id: string; rrId: string }, body: object = {}, key?: string) =>
  withKey(c, `/reservations/${b.id}/rooms/${b.rrId}/check-in`, body, key);

const setBusinessDate = (d: string) =>
  h.admin.query('UPDATE properties SET business_date = $1 WHERE id = $2', [d, h.fx.propA1]);
const roomState = async (number: string) =>
  (await h.admin.query('SELECT housekeeping_state, service_state FROM rooms WHERE id = $1', [room[number]]))
    .rows[0];

beforeAll(async () => {
  h = await startHarness();
  owner = await browser(h).loginActive(h.fx.users.ownerA);
  manager = await browser(h).loginActive(h.fx.users.managerA);
  desk = await browser(h).loginActive(h.fx.users.deskA);
  base = `/properties/${h.fx.propA1}`;
  const mk = async (code: string, rate: string, from: string, to: string) => {
    const type = await owner.post(`${base}/room-types`, {
      code,
      name: code,
      capacityAdults: 2,
      capacityChildren: 1,
      nightlyRate: rate,
    });
    const rooms = await owner.post(`${base}/rooms/bulk`, { from, to, roomTypeId: type.body.data.id });
    for (const r of rooms.body.data) room[r.roomNumber] = r.id;
    return type.body.data.id as string;
  };
  t.std = await mk('STD', '5000', '101', '105');
  t.dlx = await mk('DLX', '9000', '201', '202');
  guestId = (await desk.post('/guests', { fullName: 'Stay Test Guest', phone: '0300 5550002' })).body.data.id;
});

afterAll(async () => {
  await h?.close();
});

describe('check-in', () => {
  let b101: { id: string; rrId: string };

  it('lists today’s arrival with its room ready', async () => {
    b101 = await booking(room['101']!, '2026-10-19', '2026-10-22');
    const today = await desk.get(`${base}/front-desk/today`);
    expect(today.status).toBe(200);
    expect(today.body.data.arrivals).toEqual([
      expect.objectContaining({ reservationId: b101.id, roomNumber: '101', readiness: null }),
    ]);
  });

  it('checks the guest in, marks the booking in house and the room occupied', async () => {
    const key = randomUUID();
    const res = await checkIn(desk, b101, {}, key);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'in_house', roomNumber: '101', departure: '2026-10-22' });
    const stayId = res.body.data.id;

    const again = await checkIn(desk, b101, {}, key);
    expect(again.body.data.id).toBe(stayId);
    const second = await checkIn(desk, b101);
    expect(second.status).toBe(409);

    const reservation = await desk.get(`${base}/reservations/${b101.id}`);
    expect(reservation.body.data.status).toBe('checked_in');
    expect(reservation.body.data.rooms[0].stayId).toBe(stayId);
    const board = await desk.get(`${base}/room-board`);
    expect(board.body.data.rooms.find((r: { roomNumber: string }) => r.roomNumber === '101').boardState).toBe(
      'occupied',
    );
    const today = await desk.get(`${base}/front-desk/today`);
    expect(today.body.data.arrivals).toEqual([]);
    expect(today.body.data.inHouse.map((s: { id: string }) => s.id)).toEqual([stayId]);
  });

  it('refuses pending and future bookings', async () => {
    const pending = await booking(room['102']!, '2026-10-19', '2026-10-20', 'pending');
    expect((await checkIn(desk, pending)).status).toBe(409);
    const future = await booking(room['102']!, '2026-10-25', '2026-10-26');
    expect((await checkIn(desk, future)).body.error.message).toMatch(/due on 2026-10-25/);
  });

  it('assigns a room at check-in when the booking has none', async () => {
    const b = await booking(null, '2026-10-19', '2026-10-21');
    const missing = await checkIn(desk, b);
    expect(missing.status).toBe(400);
    const res = await checkIn(desk, b, { roomId: room['105'] });
    expect(res.status).toBe(200);
    expect(res.body.data.roomNumber).toBe('105');
  });
});

describe('OPS-002: room readiness', () => {
  it('blocks an out-of-order room unless a manager overrides with a reason, and audits the override', async () => {
    await h.admin.query(`UPDATE rooms SET service_state = 'out_of_order' WHERE id = $1`, [room['103']]);
    const b = await booking(room['103']!, '2026-10-19', '2026-10-20');

    const today = await desk.get(`${base}/front-desk/today`);
    expect(
      today.body.data.arrivals.find((a: { reservationId: string }) => a.reservationId === b.id).readiness,
    ).toBe('out_of_order');

    const blocked = await checkIn(desk, b);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('ROOM_NOT_READY');
    expect(blocked.body.error.details[0].path).toBe('readinessOverrideReason');

    expect((await checkIn(desk, b, { readinessOverrideReason: 'Guest insists' })).status).toBe(403);

    const ok = await checkIn(manager, b, { readinessOverrideReason: 'AC fixed, ticket not closed yet' });
    expect(ok.status).toBe(200);
    const audit = await h.admin.query(
      `SELECT changes, reason FROM audit_events WHERE entity_id = $1 AND action = 'reservation.checked_in'`,
      [b.id],
    );
    expect(audit.rows[0].changes.readinessOverride).toEqual({
      problem: 'out_of_order',
      reason: 'AC fixed, ticket not closed yet',
    });
    expect(audit.rows[0].reason).toBe('AC fixed, ticket not closed yet');
  });

  it('blocks a dirty room the same way', async () => {
    await h.admin.query(`UPDATE rooms SET housekeeping_state = 'dirty' WHERE id = $1`, [room['104']]);
    const b = await booking(room['104']!, '2026-10-19', '2026-10-20');
    const res = await checkIn(desk, b);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not been cleaned/);
    await h.admin.query(`UPDATE rooms SET housekeeping_state = 'clean' WHERE id = $1`, [room['104']]);
    expect((await checkIn(desk, b)).status).toBe(200);
  });
});

describe('walk-ins', () => {
  it('creates the guest, booking and stay in one step, once per key', async () => {
    const key = randomUUID();
    const body = {
      guest: { fullName: 'Walk In Demo', phone: '0311 2223334' },
      roomId: room['201'],
      departure: '2026-10-21',
      adults: 1,
    };
    const res = await withKey(desk, '/walk-ins', body, key);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'in_house', roomNumber: '201', departure: '2026-10-21' });
    const replay = await withKey(desk, '/walk-ins', body, key);
    expect(replay.body.data.id).toBe(res.body.data.id);
    const reservation = await desk.get(`${base}/reservations/${res.body.data.reservationId}`);
    expect(reservation.body.data).toMatchObject({ source: 'walk_in', status: 'checked_in' });
    expect(reservation.body.data.rooms[0]).toMatchObject({ nightlyRate: '9000.00', nights: 2 });
  });

  it('refuses an occupied room and rolls back everything', async () => {
    const before = await h.admin.query(
      `SELECT count(*)::int AS n FROM guests WHERE full_name = 'Should Not Exist'`,
    );
    const res = await withKey(desk, '/walk-ins', {
      guest: { fullName: 'Should Not Exist' },
      roomId: room['101'],
      departure: '2026-10-20',
      adults: 1,
    });
    expect(res.status).toBe(409);
    const after = await h.admin.query(
      `SELECT count(*)::int AS n FROM guests WHERE full_name = 'Should Not Exist'`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('room moves', () => {
  it('moves a guest on arrival day to another type, keeping the rate, and marks the old room dirty', async () => {
    const today = await desk.get(`${base}/front-desk/today`);
    const stay = today.body.data.inHouse.find((s: { roomNumber: string }) => s.roomNumber === '105');
    const res = await desk.post(`${base}/stays/${stay.id}/move`, {
      roomId: room['202'],
      reason: 'Upgrade: noise',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.roomNumber).toBe('202');
    expect(res.body.data.segments).toHaveLength(2);
    expect((await roomState('105')).housekeeping_state).toBe('dirty');
    const reservation = await desk.get(`${base}/reservations/${stay.reservationId}`);
    expect(reservation.body.data.rooms).toEqual([
      expect.objectContaining({ roomNumber: '202', roomTypeCode: 'DLX', nightlyRate: '5000.00' }),
    ]);
    const history = await desk.get(`${base}/reservations/${stay.reservationId}/history`);
    expect(history.body.data[0]).toMatchObject({
      action: 'reservation.room_moved',
      reason: 'Upgrade: noise',
    });
  });

  it('refuses a move into an occupied room', async () => {
    const today = await desk.get(`${base}/front-desk/today`);
    const stay = today.body.data.inHouse.find((s: { roomNumber: string }) => s.roomNumber === '202');
    const res = await desk.post(`${base}/stays/${stay.id}/move`, { roomId: room['101'], reason: 'Try' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ROOM_NOT_READY');
  });

  it('keeps nights already spent on the old room when moving mid-stay', async () => {
    await setBusinessDate('2026-10-20');
    const today = await desk.get(`${base}/front-desk/today`);
    const stay = today.body.data.inHouse.find((s: { roomNumber: string }) => s.roomNumber === '101');
    await h.admin.query(`UPDATE rooms SET housekeeping_state = 'clean' WHERE id = $1`, [room['105']]);
    const res = await desk.post(`${base}/stays/${stay.id}/move`, {
      roomId: room['105'],
      reason: 'Leak in 101',
    });
    expect(res.status).toBe(200);
    const reservation = await desk.get(`${base}/reservations/${stay.reservationId}`);
    const segs = reservation.body.data.rooms.map(
      (r: { roomNumber: string; arrival: string; departure: string }) => [
        r.roomNumber,
        r.arrival,
        r.departure,
      ],
    );
    expect(segs).toEqual([
      ['101', '2026-10-19', '2026-10-20'],
      ['105', '2026-10-20', '2026-10-22'],
    ]);
  });

  it('never lets a second guest into a room someone is still in, even with an override', async () => {
    // The walk-in in 201 was due out on the 21st; push the date past it so the room is still occupied (overstay).
    await setBusinessDate('2026-10-21');
    const created = await withKey(desk, '/reservations', {
      guestId,
      source: 'phone',
      rooms: [{ roomTypeId: t.dlx, arrival: '2026-10-21', departure: '2026-10-22', adults: 1 }],
    });
    const b = { id: created.body.data.id as string, rrId: created.body.data.rooms[0].id as string };
    const res = await checkIn(manager, b, { roomId: room['201'], readinessOverrideReason: 'Please' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/another guest/);
    const today = await desk.get(`${base}/front-desk/today`);
    expect(today.body.data.departures.map((s: { roomNumber: string }) => s.roomNumber)).toContain('201');
  });
});

describe('stay permissions and isolation', () => {
  it('keeps housekeeping from checking guests in', async () => {
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    const b = await booking(null, '2026-10-21', '2026-10-22');
    expect((await checkIn(hk, b, { roomId: room['104'] })).status).toBe(403);
  });

  it("hides another tenant's front desk and stays", async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`${base}/front-desk/today`)).status).toBe(404);
    const today = await desk.get(`${base}/front-desk/today`);
    const stayId = today.body.data.inHouse[0].id;
    expect((await ownerB.get(`/properties/${h.fx.propB1}/stays/${stayId}`)).status).toBe(404);
  });
});
