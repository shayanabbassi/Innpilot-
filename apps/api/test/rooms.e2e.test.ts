import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let owner: BrowserClient;
let base: string;
let deluxe: { id: string };

beforeAll(async () => {
  h = await startHarness();
  owner = await browser(h).loginActive(h.fx.users.ownerA);
  base = `/properties/${h.fx.propA1}`;
});

afterAll(async () => {
  await h?.close();
});

describe('room types and rates', () => {
  it('creates a room type with a first rate kept as an exact decimal string', async () => {
    const res = await owner.post(`${base}/room-types`, {
      code: 'dlx',
      name: 'Deluxe King',
      capacityAdults: 2,
      capacityChildren: 1,
      nightlyRate: '12499.50',
    });
    expect(res.status).toBe(201);
    deluxe = res.body.data;
    expect(res.body.data).toMatchObject({
      code: 'DLX',
      roomCount: 0,
      currentRate: { nightlyRate: '12499.50', currencyCode: 'PKR', effectiveFrom: '2026-10-19' },
    });
  });

  it('refuses a duplicate code, a float, too many decimals and zero', async () => {
    const dup = await owner.post(`${base}/room-types`, {
      code: 'DLX',
      name: 'x',
      capacityAdults: 1,
      capacityChildren: 0,
    });
    expect(dup.status).toBe(409);
    for (const nightlyRate of [12499.5, '12499.555', '0']) {
      const res = await owner.post(`${base}/room-types/${deluxe.id}/rates`, { nightlyRate });
      expect(res.status, String(nightlyRate)).toBe(400);
    }
  });

  it('adds future rates, refuses past ones, and only lets future rates be removed', async () => {
    const past = await owner.post(`${base}/room-types/${deluxe.id}/rates`, {
      effectiveFrom: '2026-10-01',
      nightlyRate: '1',
    });
    expect(past.status).toBe(400);

    const future = await owner.post(`${base}/room-types/${deluxe.id}/rates`, {
      effectiveFrom: '2026-12-15',
      nightlyRate: '15000',
    });
    expect(future.status).toBe(201);
    const history = await owner.get(`${base}/room-types/${deluxe.id}/rates`);
    expect(history.body.data.map((r: { effectiveFrom: string }) => r.effectiveFrom)).toEqual([
      '2026-12-15',
      '2026-10-19',
    ]);
    // Today's rate is still the current one.
    const types = await owner.get(`${base}/room-types`);
    expect(types.body.data[0].currentRate.nightlyRate).toBe('12499.50');

    const current = history.body.data[1].id;
    const removeCurrent = await owner.agent
      .delete(`/api/v1${base}/room-types/${deluxe.id}/rates/${current}`)
      .set('origin', 'http://localhost:3000')
      .set('x-csrf-token', owner.csrf);
    expect(removeCurrent.status).toBe(409);
    const removeFuture = await owner.agent
      .delete(`/api/v1${base}/room-types/${deluxe.id}/rates/${future.body.data.id}`)
      .set('origin', 'http://localhost:3000')
      .set('x-csrf-token', owner.csrf);
    expect(removeFuture.status).toBe(200);
  });
});

describe('rooms', () => {
  it('bulk-creates a numbered range', async () => {
    const res = await owner.post(`${base}/rooms/bulk`, {
      from: '101',
      to: '105',
      floor: '1',
      roomTypeId: deluxe.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.map((r: { roomNumber: string }) => r.roomNumber)).toEqual([
      '101',
      '102',
      '103',
      '104',
      '105',
    ]);
  });

  it('creates nothing when part of a bulk range already exists, and names the clashes', async () => {
    const res = await owner.post(`${base}/rooms/bulk`, { from: '104', to: '110', roomTypeId: deluxe.id });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('104, 105');
    const rooms = await owner.get(`${base}/rooms`);
    expect(rooms.body.data).toHaveLength(5);
  });

  it('treats room numbers case-insensitively', async () => {
    await owner.post(`${base}/rooms`, { roomNumber: 'A-1', roomTypeId: deluxe.id });
    const dup = await owner.post(`${base}/rooms`, { roomNumber: 'a-1', roomTypeId: deluxe.id });
    expect(dup.status).toBe(409);
  });

  it("refuses another property's room type", async () => {
    const other = await owner.post(`/properties/${h.fx.propA2}/room-types`, {
      code: 'STD',
      name: 'Standard',
      capacityAdults: 2,
      capacityChildren: 0,
    });
    const res = await owner.post(`${base}/rooms`, { roomNumber: '999', roomTypeId: other.body.data.id });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('roomTypeId');
  });

  it('will not deactivate a room type that still has active rooms', async () => {
    const res = await owner.patch(`${base}/room-types/${deluxe.id}`, { active: false });
    expect(res.status).toBe(409);
  });

  it('shows the board with derived states and counts', async () => {
    const rooms = await owner.get(`${base}/rooms`);
    const r102 = rooms.body.data.find((r: { roomNumber: string }) => r.roomNumber === '102');
    await h.admin.query(`UPDATE rooms SET housekeeping_state = 'dirty' WHERE id = $1`, [r102.id]);
    await owner.patch(`${base}/rooms/${rooms.body.data[0].id}`, { active: false });

    const board = await owner.get(`${base}/room-board`);
    expect(board.status).toBe(200);
    expect(board.body.data.businessDate).toBe('2026-10-19');
    expect(board.body.data.counts).toMatchObject({ vacant_ready: 4, vacant_dirty: 1, inactive: 1 });
    expect(board.body.data.rooms.find((r: { roomNumber: string }) => r.roomNumber === '102').boardState).toBe(
      'vacant_dirty',
    );
  });

  it('audits changes', async () => {
    const audit = await owner.get('/audit-events?entityType=room_type');
    const actions = audit.body.data.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'room_type.created',
        'room_type.rate_added',
        'room_type.rate_removed',
        'room.bulk_created',
      ]),
    );
  });
});

describe('room permissions and isolation', () => {
  it('lets front desk and housekeeping read the board but not change rooms', async () => {
    for (const user of [h.fx.users.deskA, h.fx.users.housekeepingA]) {
      const c = await browser(h).loginActive(user);
      expect((await c.get(`${base}/room-board`)).status).toBe(200);
      expect((await c.post(`${base}/rooms`, { roomNumber: '301', roomTypeId: deluxe.id })).status).toBe(403);
      expect((await c.post(`${base}/room-types/${deluxe.id}/rates`, { nightlyRate: '1' })).status).toBe(403);
    }
  });

  it('keeps a property-scoped manager to their own property', async () => {
    const m = await browser(h).loginActive(h.fx.users.managerA1);
    expect((await m.get(`${base}/rooms`)).status).toBe(200);
    expect((await m.get(`/properties/${h.fx.propA2}/rooms`)).status).toBe(404);
  });

  it("hides another tenant's rooms and refuses its ids", async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`${base}/rooms`)).status).toBe(404);
    expect((await ownerB.get(`${base}/room-board`)).status).toBe(404);
    // Tenant B cannot use Tenant A's room type even in its own property.
    const res = await ownerB.post(`/properties/${h.fx.propB1}/rooms`, {
      roomNumber: '1',
      roomTypeId: deluxe.id,
    });
    expect(res.status).toBe(400);
    expect((await ownerB.get(`/properties/${h.fx.propB1}/room-types/${deluxe.id}/rates`)).status).toBe(404);
  });
});
