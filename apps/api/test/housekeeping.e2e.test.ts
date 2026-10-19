import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let owner: BrowserClient;
let manager: BrowserClient;
let desk: BrowserClient;
let hk: BrowserClient;
let base: string;
let std: string;
const room: Record<string, string> = {};
let guestId: string;

const withKey = (c: BrowserClient, path: string, body: object) =>
  c.agent
    .post(`/api/v1${base}${path}`)
    .set('origin', 'http://localhost:3000')
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', randomUUID())
    .send(body);

const book = (roomId: string | null | undefined, arrival: string, departure: string) =>
  withKey(desk, '/reservations', {
    guestId,
    source: 'phone',
    rooms: [{ roomTypeId: std, roomId, arrival, departure, adults: 1 }],
  });

const state = async (n: string) =>
  (await h.admin.query('SELECT housekeeping_state, service_state FROM rooms WHERE id = $1', [room[n]]))
    .rows[0];
const openTasks = async (n: string) =>
  (
    await h.admin.query(
      `SELECT task_type, source FROM housekeeping_tasks WHERE room_id = $1 AND status IN ('open', 'in_progress')`,
      [room[n]],
    )
  ).rows;
const tasksOf = async (c: BrowserClient, n: string) =>
  (await c.get(`${base}/housekeeping/tasks`)).body.data.filter(
    (t: { roomNumber: string }) => t.roomNumber === n,
  );
const setState = (c: BrowserClient, n: string, s: string) =>
  c.post(`${base}/rooms/${room[n]}/housekeeping-state`, { state: s });
const available = async (arrival: string, departure: string) =>
  (await desk.get(`${base}/availability?arrival=${arrival}&departure=${departure}`)).body.data.roomTypes[0]
    .available;

beforeAll(async () => {
  h = await startHarness();
  owner = await browser(h).loginActive(h.fx.users.ownerA);
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
  guestId = (await desk.post('/guests', { fullName: 'Housekeeping Test Guest' })).body.data.id;
});

afterAll(async () => {
  await h?.close();
});

describe('housekeeping states and tasks', () => {
  it('creates exactly one cleaning task when a room becomes dirty', async () => {
    expect((await setState(hk, '101', 'dirty')).status).toBe(200);
    expect((await setState(hk, '101', 'dirty')).status).toBe(200);
    expect(await openTasks('101')).toEqual([{ task_type: 'clean', source: 'room_dirty' }]);
    const board = await desk.get(`${base}/room-board`);
    expect(board.body.data.rooms.find((r: { roomNumber: string }) => r.roomNumber === '101').boardState).toBe(
      'vacant_dirty',
    );
  });

  it('refuses transitions that skip cleaning', async () => {
    const res = await setState(hk, '101', 'inspected');
    expect(res.status).toBe(409);
    expect((await state('101')).housekeeping_state).toBe('dirty');
  });

  it('follows the task: start → cleaning, complete → clean', async () => {
    const [task] = await tasksOf(hk, '101');
    const started = await hk.post(`${base}/housekeeping/tasks/${task.id}/start`);
    expect(started.body.data).toMatchObject({ status: 'in_progress', housekeepingState: 'cleaning' });
    expect(started.body.data.assignedUserId).toBe(h.fx.users.housekeepingA.id);
    const done = await hk.post(`${base}/housekeeping/tasks/${task.id}/complete`, {});
    expect(done.body.data).toMatchObject({ status: 'done', housekeepingState: 'clean' });
    expect(await openTasks('101')).toEqual([]);
  });

  it('sends a room back to cleaning when it fails inspection', async () => {
    const insp = await hk.post(`${base}/housekeeping/tasks`, { roomId: room['101'], taskType: 'inspect' });
    expect(insp.status).toBe(201);
    const failed = await hk.post(`${base}/housekeeping/tasks/${insp.body.data.id}/complete`, {
      passed: false,
      notes: 'Bathroom not done',
    });
    expect(failed.status).toBe(200);
    expect((await state('101')).housekeeping_state).toBe('dirty');
    expect(await openTasks('101')).toEqual([{ task_type: 'clean', source: 'inspection_failed' }]);

    const [clean] = await tasksOf(hk, '101');
    await hk.post(`${base}/housekeeping/tasks/${clean.id}/complete`, {});
    const again = await hk.post(`${base}/housekeeping/tasks`, { roomId: room['101'], taskType: 'inspect' });
    await hk.post(`${base}/housekeeping/tasks/${again.body.data.id}/complete`, { passed: true });
    expect((await state('101')).housekeeping_state).toBe('inspected');
  });

  it('assigns only to housekeeping staff and lists them', async () => {
    await setState(hk, '102', 'dirty');
    const [task] = await tasksOf(hk, '102');
    const wrong = await manager.patch(`${base}/housekeeping/tasks/${task.id}`, {
      assignedUserId: h.fx.users.deskA.id,
    });
    expect(wrong.status).toBe(400);
    const ok = await manager.patch(`${base}/housekeeping/tasks/${task.id}`, {
      assignedUserId: h.fx.users.housekeepingA.id,
    });
    expect(ok.body.data.assignedName).toBeTruthy();
    const staff = await desk.get(`${base}/housekeeping/staff`);
    const ids = staff.body.data.map((s: { id: string }) => s.id);
    expect(ids).toContain(h.fx.users.housekeepingA.id);
    expect(ids).not.toContain(h.fx.users.deskA.id);
    await hk.post(`${base}/housekeeping/tasks/${task.id}/complete`, {});
  });

  it('lets front desk see tasks but not change room states, and shows no guest data', async () => {
    expect((await desk.get(`${base}/housekeeping/tasks?status=done`)).status).toBe(200);
    expect((await setState(desk, '102', 'dirty')).status).toBe(403);
    const list = await hk.get(`${base}/housekeeping/tasks?status=done`);
    expect(JSON.stringify(list.body)).not.toMatch(/guest|Housekeeping Test Guest/i);
  });

  it('creates a cleaning task when a guest moves out of a room', async () => {
    const b = await book(room['102'], '2026-10-19', '2026-10-21');
    const stay = await withKey(
      desk,
      `/reservations/${b.body.data.id}/rooms/${b.body.data.rooms[0].id}/check-in`,
      {},
    );
    expect(stay.status).toBe(200);
    const moved = await desk.post(`${base}/stays/${stay.body.data.id}/move`, {
      roomId: room['103'],
      reason: 'Noise',
    });
    expect(moved.status).toBe(200);
    expect((await state('102')).housekeeping_state).toBe('dirty');
    expect(await openTasks('102')).toEqual([{ task_type: 'clean', source: 'room_dirty' }]);
  });
});

describe('maintenance and out-of-order rooms', () => {
  let oooTicket: string;

  it('lets housekeeping report a problem but not take a room out of order', async () => {
    const report = await hk.post(`${base}/maintenance/tickets`, {
      roomId: room['101'],
      category: 'plumbing',
      description: 'Dripping tap',
    });
    expect(report.status).toBe(201);
    const ooo = await hk.post(`${base}/maintenance/tickets`, {
      roomId: room['101'],
      category: 'plumbing',
      description: 'Burst pipe',
      outOfOrder: { from: '2026-10-19', to: '2026-10-21' },
    });
    expect(ooo.status).toBe(403);
  });

  it('takes a room out of order today, removing it from sale for those nights only', async () => {
    expect(await available('2026-10-19', '2026-10-20')).toBe(2);
    const res = await manager.post(`${base}/maintenance/tickets`, {
      roomId: room['101'],
      category: 'hvac',
      priority: 'high',
      description: 'AC not cooling',
      outOfOrder: { from: '2026-10-19', to: '2026-10-21' },
    });
    expect(res.status).toBe(201);
    oooTicket = res.body.data.id;
    expect((await state('101')).service_state).toBe('out_of_order');
    expect(await available('2026-10-19', '2026-10-20')).toBe(1);
    expect(await available('2026-10-21', '2026-10-22')).toBe(3);
    const specific = await book(room['101'], '2026-10-20', '2026-10-21');
    expect(specific.status).toBe(409);
    expect((await book(room['101'], '2026-10-21', '2026-10-22')).status).toBe(201);
  });

  it('refuses while a guest is staying in the room', async () => {
    const res = await manager.post(`${base}/maintenance/tickets`, {
      roomId: room['103'],
      category: 'other',
      description: 'Paint',
      outOfOrder: { from: '2026-10-19', to: '2026-10-20' },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/guest is staying/);
  });

  it('needs a reason to unassign future bookings, then lists them on the ticket', async () => {
    const b = await book(room['102'], '2026-10-25', '2026-10-26');
    const body = {
      roomId: room['102'],
      category: 'furniture',
      description: 'Replace bed',
      outOfOrder: { from: '2026-10-24', to: '2026-10-27' },
    };
    const blocked = await manager.post(`${base}/maintenance/tickets`, body);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain(b.body.data.bookingReference);
    const ok = await manager.post(`${base}/maintenance/tickets`, {
      ...body,
      outOfOrder: { ...body.outOfOrder, overrideReason: 'Bed delivery fixed date' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.data.unassignedBookings).toEqual([
      { reservationId: b.body.data.id, bookingReference: b.body.data.bookingReference },
    ]);
    const after = await desk.get(`${base}/reservations/${b.body.data.id}`);
    expect(after.body.data.rooms[0].roomId).toBeNull();
    expect((await state('102')).service_state).toBe('in_service');
  });

  it('never oversells a room type', async () => {
    // Oct 25: 3 rooms, 102 out of order → 2 sellable; one booking already.
    expect((await book(null, '2026-10-25', '2026-10-26')).status).toBe(201);
    const third = await book(null, '2026-10-25', '2026-10-26');
    expect(third.status).toBe(409);
    const ooo = await manager.post(`${base}/maintenance/tickets`, {
      roomId: room['101'],
      category: 'other',
      description: 'Deep clean',
      outOfOrder: { from: '2026-10-25', to: '2026-10-26' },
    });
    expect(ooo.status).toBe(409);
    expect(ooo.body.error.code).toBe('ROOM_UNAVAILABLE');
  });

  it('returns the room to service when resolved (managers only)', async () => {
    expect(
      (await hk.post(`${base}/maintenance/tickets/${oooTicket}/resolve`, { note: 'Gas refilled' })).status,
    ).toBe(403);
    const res = await manager.post(`${base}/maintenance/tickets/${oooTicket}/resolve`, {
      note: 'Gas refilled',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('resolved');
    expect((await state('101')).service_state).toBe('in_service');
    expect(await available('2026-10-20', '2026-10-21')).toBe(2);
  });
});

describe('housekeeping isolation', () => {
  it("hides another tenant's tasks and tickets", async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`${base}/housekeeping/tasks`)).status).toBe(404);
    expect((await ownerB.get(`${base}/maintenance/tickets`)).status).toBe(404);
    const [task] = await tasksOf(hk, '102');
    expect((await ownerB.post(`/properties/${h.fx.propB1}/housekeeping/tasks/${task.id}/start`)).status).toBe(
      404,
    );
  });
});
