import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let owner: BrowserClient;
let desk: BrowserClient;
let base: string;
const t = { std: '', dlx: '' };
const room: Record<string, string> = {};
let guestId: string;

type RoomInput = {
  roomTypeId: string;
  roomId?: string | null;
  arrival: string;
  departure: string;
  adults: number;
  children?: number;
  nightlyRate?: string;
  rateOverrideReason?: string;
};

function book(c: BrowserClient, rooms: RoomInput[], key: string | null = randomUUID(), extra: object = {}) {
  const req = c.agent
    .post(`/api/v1${base}/reservations`)
    .set('origin', 'http://localhost:3000')
    .set('x-csrf-token', c.csrf);
  if (key) req.set('idempotency-key', key);
  return req.send({ guestId, source: 'phone', rooms, ...extra });
}

const std = (arrival: string, departure: string, roomId?: string | null): RoomInput => ({
  roomTypeId: t.std,
  roomId: roomId ?? null,
  arrival,
  departure,
  adults: 2,
});

beforeAll(async () => {
  h = await startHarness();
  owner = await browser(h).loginActive(h.fx.users.ownerA);
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
  t.std = await mk('STD', '5000', '101', '103');
  t.dlx = await mk('DLX', '9000', '201', '201');
  guestId = (await desk.post('/guests', { fullName: 'Booking Test Guest', phone: '0300 5550001' })).body.data
    .id;
});

afterAll(async () => {
  await h?.close();
});

describe('availability and booking', () => {
  it('reports rooms left and the rate for each type', async () => {
    const res = await desk.get(`${base}/availability?arrival=2026-10-20&departure=2026-10-22`);
    expect(res.status).toBe(200);
    const byCode = Object.fromEntries(res.body.data.roomTypes.map((x: { code: string }) => [x.code, x]));
    expect(byCode.STD).toMatchObject({ available: 3, nightlyRate: '5000.00' });
    expect(byCode.STD.freeRooms).toHaveLength(3);
    expect(byCode.DLX).toMatchObject({ available: 1, nightlyRate: '9000.00' });
  });

  it('creates a confirmed booking with a readable reference and the agreed rate', async () => {
    const res = await book(desk, [std('2026-10-20', '2026-10-22', room['101'])]);
    expect(res.status).toBe(201);
    expect(res.body.data.bookingReference).toMatch(/^[A-HJKMNP-Z2-9]{8}$/);
    expect(res.body.data).toMatchObject({
      status: 'confirmed',
      arrival: '2026-10-20',
      departure: '2026-10-22',
    });
    expect(res.body.data.rooms[0]).toMatchObject({
      roomNumber: '101',
      nights: 2,
      nightlyRate: '5000.00',
      roomTotal: '10000.00',
      rateOverridden: false,
    });
  });

  it('returns the original booking for a retried request and requires a key', async () => {
    const key = randomUUID();
    const first = await book(desk, [std('2026-11-01', '2026-11-02')], key);
    const retry = await book(desk, [std('2026-11-01', '2026-11-02')], key);
    expect(retry.status).toBe(201);
    expect(retry.body.data.id).toBe(first.body.data.id);
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM reservation_rooms WHERE arrival = '2026-11-01'`,
    );
    expect(rows[0].n).toBe(1);
    const noKey = await book(desk, [std('2026-11-01', '2026-11-02')], null);
    expect(noKey.status).toBe(400);
  });

  it('refuses an overlapping booking of the same room but allows same-day turnover', async () => {
    const clash = await book(desk, [std('2026-10-21', '2026-10-23', room['101'])]);
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('ROOM_UNAVAILABLE');
    const turnover = await book(desk, [std('2026-10-22', '2026-10-24', room['101'])]);
    expect(turnover.status).toBe(201);
  });

  it('validates room type, capacity and dates', async () => {
    expect((await book(desk, [{ ...std('2026-10-20', '2026-10-21'), roomId: room['201'] }])).status).toBe(
      400,
    );
    expect((await book(desk, [{ ...std('2026-10-20', '2026-10-21'), adults: 3 }])).status).toBe(400);
    expect((await book(desk, [std('2026-10-10', '2026-10-12')])).status).toBe(400);
  });
});

describe('OPS-001: concurrent bookings', () => {
  it('lets exactly one of 20 simultaneous bookings take the same room and night', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => book(desk, [std('2026-10-25', '2026-10-26', room['102'])])),
    );
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM reservation_rooms WHERE room_id = $1 AND arrival = '2026-10-25' AND status = 'active'`,
      [room['102']],
    );
    expect(rows[0].n).toBe(1);
  });

  it('never oversells a room type, even without room numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => book(desk, [std('2026-10-28', '2026-10-29')])),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ROOM_UNAVAILABLE'),
    ).toBe(true);
    const avail = await desk.get(`${base}/availability?arrival=2026-10-28&departure=2026-10-29`);
    const stdRow = avail.body.data.roomTypes.find((x: { code: string }) => x.code === 'STD');
    expect(stdRow.available).toBe(0);
  });
});

describe('rates', () => {
  it('only lets managers and owners change the rate, with a reason', async () => {
    const override = {
      ...std('2026-11-05', '2026-11-06'),
      nightlyRate: '4200',
      rateOverrideReason: 'Corporate',
    };
    expect((await book(desk, [override])).status).toBe(403);
    const res = await book(owner, [override]);
    expect(res.status).toBe(201);
    expect(res.body.data.rooms[0]).toMatchObject({ nightlyRate: '4200.00', rateOverridden: true });
  });

  it('keeps the agreed rate when the room type rate changes later', async () => {
    const before = await book(desk, [std('2026-11-10', '2026-11-11')]);
    await owner.post(`${base}/room-types/${t.std}/rates`, {
      effectiveFrom: '2026-11-01',
      nightlyRate: '7000',
    });
    const existing = await desk.get(`${base}/reservations/${before.body.data.id}`);
    expect(existing.body.data.rooms[0].nightlyRate).toBe('5000.00');
    const after = await book(desk, [std('2026-11-12', '2026-11-13')]);
    expect(after.body.data.rooms[0].nightlyRate).toBe('7000.00');
  });
});

describe('changes, cancellation and history', () => {
  let id: string;
  let segId: string;

  it('assigns a room later, refusing one that is already taken', async () => {
    const res = await book(desk, [std('2026-11-20', '2026-11-22')]);
    id = res.body.data.id;
    segId = res.body.data.rooms[0].id;
    await book(desk, [std('2026-11-21', '2026-11-22', room['103'])]);
    const taken = await desk.post(`${base}/reservations/${id}/rooms/${segId}/assign`, {
      roomId: room['103'],
    });
    expect(taken.status).toBe(409);
    const ok = await desk.post(`${base}/reservations/${id}/rooms/${segId}/assign`, { roomId: room['101'] });
    expect(ok.status).toBe(200);
    expect(ok.body.data.rooms[0].roomNumber).toBe('101');
  });

  it('changes dates while keeping the agreed rate', async () => {
    const res = await desk.put(`${base}/reservations/${id}/rooms/${segId}`, {
      ...std('2026-11-20', '2026-11-23', room['101']),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.rooms[0]).toMatchObject({
      nights: 3,
      nightlyRate: '7000.00',
      roomTotal: '21000.00',
    });
  });

  it('refuses a no-show before the arrival date', async () => {
    const res = await desk.post(`${base}/reservations/${id}/no-show`, {});
    expect(res.status).toBe(409);
  });

  it('cancels with a reason and frees the room', async () => {
    expect((await desk.post(`${base}/reservations/${id}/cancel`, {})).status).toBe(400);
    const res = await desk.post(`${base}/reservations/${id}/cancel`, { reason: 'Guest changed plans' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'cancelled', cancelReason: 'Guest changed plans' });
    expect(res.body.data.rooms[0].status).toBe('released');
    expect((await book(desk, [std('2026-11-20', '2026-11-23', room['101'])])).status).toBe(201);
    expect((await desk.post(`${base}/reservations/${id}/cancel`, { reason: 'again' })).status).toBe(409);
  });

  it('shows the full history', async () => {
    const res = await desk.get(`${base}/reservations/${id}/history`);
    expect(res.body.data.map((e: { action: string }) => e.action).reverse()).toEqual([
      'reservation.created',
      'reservation.room_assigned',
      'reservation.room_changed',
      'reservation.cancelled',
    ]);
  });

  it('lists by date range and finds by reference or guest name', async () => {
    const one = await desk.get(`${base}/reservations/${id}`);
    const byRef = await desk.get(
      `${base}/reservations?status=cancelled&search=${one.body.data.bookingReference}`,
    );
    expect(byRef.body.data.map((x: { id: string }) => x.id)).toEqual([id]);
    const range = await desk.get(`${base}/reservations?from=2026-10-25&to=2026-10-26`);
    expect(range.body.data.length).toBeGreaterThanOrEqual(1);
    expect(
      range.body.data.every(
        (x: { arrival: string; departure: string }) => x.arrival < '2026-10-26' && x.departure > '2026-10-25',
      ),
    ).toBe(true);
    const byName = await desk.get(`${base}/reservations?search=Booking%20Test`);
    expect(byName.body.data.length).toBeGreaterThan(0);
  });
});

describe('reservation permissions and isolation', () => {
  it('keeps housekeeping and other properties out', async () => {
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    expect((await hk.get(`${base}/reservations`)).status).toBe(403);
    const m = await browser(h).loginActive(h.fx.users.managerA1);
    expect((await m.get(`/properties/${h.fx.propA2}/reservations`)).status).toBe(404);
  });

  it("refuses another tenant's guest, property and bookings", async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    const list = await desk.get(`${base}/reservations`);
    const someId = list.body.data[0].id;
    expect((await ownerB.get(`${base}/reservations/${someId}`)).status).toBe(404);
    expect((await ownerB.get(`/properties/${h.fx.propB1}/reservations/${someId}`)).status).toBe(404);

    const guestB = (await ownerB.post('/guests', { fullName: 'Tenant B Guest' })).body.data.id;
    const res = await desk.agent
      .post(`/api/v1${base}/reservations`)
      .set('origin', 'http://localhost:3000')
      .set('x-csrf-token', desk.csrf)
      .set('idempotency-key', randomUUID())
      .send({ guestId: guestB, source: 'phone', rooms: [std('2026-12-01', '2026-12-02')] });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('guestId');
  });
});
