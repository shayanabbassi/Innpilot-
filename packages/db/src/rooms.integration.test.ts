import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

/** Constraint-level guarantees for rooms, run as the owner so they hold even without RLS or app checks. */
let testDb: TestDatabase;
let admin: Client;
const ids = { tenant: '', p1: '', p2: '', type1: '', type2: '' };

async function one<T>(text: string, values: unknown[]): Promise<T> {
  const { rows } = await admin.query(text, values);
  return rows[0] as T;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  ids.tenant = (
    await one<{ id: string }>(
      `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('rooms-t', 'T', 'T') RETURNING id`,
      [],
    )
  ).id;
  const prop = async () =>
    (
      await one<{ id: string }>(
        `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
        [ids.tenant],
      )
    ).id;
  ids.p1 = await prop();
  ids.p2 = await prop();
  const type = async (propertyId: string) =>
    (
      await one<{ id: string }>(
        `INSERT INTO room_types (tenant_id, property_id, code, name, capacity_adults) VALUES ($1, $2, 'STD', 'Standard', 2)
         RETURNING id`,
        [ids.tenant, propertyId],
      )
    ).id;
  ids.type1 = await type(ids.p1);
  ids.type2 = await type(ids.p2);
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const insertRoom = (propertyId: string, typeId: string, number: string) =>
  admin.query(
    `INSERT INTO rooms (tenant_id, property_id, room_type_id, room_number) VALUES ($1, $2, $3, $4) RETURNING id`,
    [ids.tenant, propertyId, typeId, number],
  );

describe('rooms schema', () => {
  it("refuses a room that uses another property's room type", async () => {
    await expect(insertRoom(ids.p1, ids.type2, '101')).rejects.toThrow(/foreign key/);
  });

  it('treats room numbers case-insensitively and per property', async () => {
    await insertRoom(ids.p1, ids.type1, 'A-12');
    await expect(insertRoom(ids.p1, ids.type1, 'a-12')).rejects.toThrow(/duplicate key/);
    await expect(insertRoom(ids.p2, ids.type2, 'A-12')).resolves.toBeDefined();
  });

  it('refuses zero or negative rates and never updates a rate row', async () => {
    const rate = (amount: string, from: string) =>
      admin.query(
        `INSERT INTO room_type_rates (tenant_id, property_id, room_type_id, effective_from, nightly_rate, currency_code)
         VALUES ($1, $2, $3, $4, $5, 'PKR') RETURNING id`,
        [ids.tenant, ids.p1, ids.type1, from, amount],
      );
    await expect(rate('0', '2026-10-19')).rejects.toThrow(/check constraint/);
    const { rows } = await rate('4999.50', '2026-10-19');
    await expect(rate('5000', '2026-10-19')).rejects.toThrow(/duplicate key/);
    await expect(
      admin.query(`UPDATE room_type_rates SET nightly_rate = 1 WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/not allowed/);
    const { rows: stored } = await admin.query(
      `SELECT nightly_rate::text AS r FROM room_type_rates WHERE id = $1`,
      [rows[0].id],
    );
    expect(stored[0].r).toBe('4999.5000');
  });

  it('keeps room status history append-only', async () => {
    const { rows } = await insertRoom(ids.p1, ids.type1, '201');
    const ev = await one<{ id: string }>(
      `INSERT INTO room_status_events (tenant_id, property_id, room_id, dimension, from_state, to_state)
       VALUES ($1, $2, $3, 'housekeeping', 'clean', 'dirty') RETURNING id`,
      [ids.tenant, ids.p1, rows[0].id],
    );
    await expect(admin.query(`DELETE FROM room_status_events WHERE id = $1`, [ev.id])).rejects.toThrow(
      /not allowed/,
    );
  });

  it('refuses unknown housekeeping or service states', async () => {
    await expect(
      admin.query(`UPDATE rooms SET housekeeping_state = 'sparkling' WHERE property_id = $1`, [ids.p1]),
    ).rejects.toThrow(/check constraint/);
  });
});
