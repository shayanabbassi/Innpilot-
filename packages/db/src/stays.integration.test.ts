import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

/** Occupancy guarantees held by the database itself. */
let testDb: TestDatabase;
let admin: Client;
const ids = { tenant: '', property: '', room: '', room2: '', stay1: '', stay2: '' };

async function one(text: string, values: unknown[]): Promise<string> {
  return (await admin.query<{ id: string }>(text, values)).rows[0]!.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('stay-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  const type = await one(
    `INSERT INTO room_types (tenant_id, property_id, code, name, capacity_adults) VALUES ($1, $2, 'STD', 'S', 2) RETURNING id`,
    [ids.tenant, ids.property],
  );
  const room = (n: string) =>
    one(
      `INSERT INTO rooms (tenant_id, property_id, room_type_id, room_number) VALUES ($1, $2, $3, $4) RETURNING id`,
      [ids.tenant, ids.property, type, n],
    );
  ids.room = await room('101');
  ids.room2 = await room('102');
  const guest = await one(`INSERT INTO guests (tenant_id, full_name) VALUES ($1, 'G') RETURNING id`, [
    ids.tenant,
  ]);
  const res = await one(
    `INSERT INTO reservations (tenant_id, property_id, booking_reference, guest_id, source, status)
     VALUES ($1, $2, 'STAYTEST', $3, 'walk_in', 'checked_in') RETURNING id`,
    [ids.tenant, ids.property, guest],
  );
  const stay = () =>
    one(
      `INSERT INTO stays (tenant_id, property_id, reservation_id, guest_id) VALUES ($1, $2, $3, $4) RETURNING id`,
      [ids.tenant, ids.property, res, guest],
    );
  ids.stay1 = await stay();
  ids.stay2 = await stay();
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const segment = (stayId: string, roomId: string) =>
  admin.query(
    `INSERT INTO stay_rooms (tenant_id, property_id, stay_id, room_id, from_date) VALUES ($1, $2, $3, $4, '2026-10-19')
     RETURNING id`,
    [ids.tenant, ids.property, stayId, roomId],
  );

describe('stay occupancy constraints', () => {
  it('allows only one in-house guest per room', async () => {
    await segment(ids.stay1, ids.room);
    await expect(segment(ids.stay2, ids.room)).rejects.toThrow(/stay_rooms_one_guest_per_room/);
  });

  it('allows only one open room segment per stay', async () => {
    await expect(segment(ids.stay1, ids.room2)).rejects.toThrow(/stay_rooms_one_open_per_stay/);
  });

  it('frees the room once the segment ends', async () => {
    await admin.query(`UPDATE stay_rooms SET ended_at = now() WHERE stay_id = $1`, [ids.stay1]);
    await expect(segment(ids.stay2, ids.room)).resolves.toBeDefined();
  });

  it('keeps status and check-out time consistent', async () => {
    await expect(
      admin.query(`UPDATE stays SET status = 'checked_out' WHERE id = $1`, [ids.stay1]),
    ).rejects.toThrow(/check constraint/);
  });
});
