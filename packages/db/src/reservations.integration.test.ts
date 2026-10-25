import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

/** The database-level double-booking guarantee, tested without any application code. */
let testDb: TestDatabase;
let admin: Client;
const ids = {
  tenant: '',
  property: '',
  type: '',
  type2: '',
  room: '',
  room2: '',
  guest: '',
  reservation: '',
};

async function one(text: string, values: unknown[]): Promise<string> {
  return (await admin.query<{ id: string }>(text, values)).rows[0]!.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('res-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  const type = (code: string) =>
    one(
      `INSERT INTO room_types (tenant_id, property_id, code, name, capacity_adults) VALUES ($1, $2, $3::text, $3::text, 2) RETURNING id`,
      [ids.tenant, ids.property, code],
    );
  ids.type = await type('STD');
  ids.type2 = await type('DLX');
  const room = (typeId: string, n: string) =>
    one(
      `INSERT INTO rooms (tenant_id, property_id, room_type_id, room_number) VALUES ($1, $2, $3, $4) RETURNING id`,
      [ids.tenant, ids.property, typeId, n],
    );
  ids.room = await room(ids.type, '101');
  ids.room2 = await room(ids.type2, '201');
  ids.guest = await one(`INSERT INTO guests (tenant_id, full_name) VALUES ($1, 'G') RETURNING id`, [
    ids.tenant,
  ]);
  ids.reservation = await one(
    `INSERT INTO reservations (tenant_id, property_id, booking_reference, guest_id, source, status)
     VALUES ($1, $2, 'ABCDEFGH', $3, 'phone', 'confirmed') RETURNING id`,
    [ids.tenant, ids.property, ids.guest],
  );
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const book = (arrival: string, departure: string, roomId: string | null = ids.room, typeId = ids.type) =>
  admin.query(
    `INSERT INTO reservation_rooms (tenant_id, property_id, reservation_id, room_type_id, room_id, arrival, departure,
                                    adults, nightly_rate, currency_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 2, 5000, 'PKR') RETURNING id`,
    [ids.tenant, ids.property, ids.reservation, typeId, roomId, arrival, departure],
  );

describe('double-booking exclusion constraint', () => {
  it('refuses an overlapping active booking of the same room', async () => {
    await book('2026-10-20', '2026-10-23');
    await expect(book('2026-10-22', '2026-10-24')).rejects.toThrow(/reservation_rooms_no_double_booking/);
    await expect(book('2026-10-18', '2026-10-21')).rejects.toThrow(/reservation_rooms_no_double_booking/);
  });

  it('allows same-day turnover and unassigned bookings', async () => {
    await expect(book('2026-10-23', '2026-10-25')).resolves.toBeDefined();
    await expect(book('2026-10-17', '2026-10-20')).resolves.toBeDefined();
    await expect(book('2026-10-21', '2026-10-22', null)).resolves.toBeDefined();
  });

  it('frees the nights once a booking is released', async () => {
    const { rows } = await book('2026-11-01', '2026-11-03');
    await expect(book('2026-11-02', '2026-11-04')).rejects.toThrow(/no_double_booking/);
    await admin.query(`UPDATE reservation_rooms SET status = 'released' WHERE id = $1`, [rows[0].id]);
    await expect(book('2026-11-02', '2026-11-04')).resolves.toBeDefined();
  });

  it('refuses a room that is not of the booked room type', async () => {
    await expect(book('2026-12-01', '2026-12-02', ids.room2, ids.type)).rejects.toThrow(/foreign key/);
  });

  it('refuses zero-night and overlong stays', async () => {
    await expect(book('2026-12-05', '2026-12-05', null)).rejects.toThrow(/check constraint/);
    await expect(book('2026-12-05', '2027-03-01', null)).rejects.toThrow(/check constraint/);
  });

  it("protects a booked room's type from being changed under the booking", async () => {
    await expect(
      admin.query(`UPDATE rooms SET room_type_id = $1 WHERE id = $2`, [ids.type2, ids.room]),
    ).rejects.toThrow(/foreign key/);
  });
});
