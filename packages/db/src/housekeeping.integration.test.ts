import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = { tenant: '', property: '', room: '' };

async function one(text: string, values: unknown[]): Promise<string> {
  return (await admin.query<{ id: string }>(text, values)).rows[0]!.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('hk-t', 'T', 'T') RETURNING id`,
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
  ids.room = await one(
    `INSERT INTO rooms (tenant_id, property_id, room_type_id, room_number) VALUES ($1, $2, $3, '101') RETURNING id`,
    [ids.tenant, ids.property, type],
  );
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const task = (type = 'clean') =>
  admin.query(
    `INSERT INTO housekeeping_tasks (tenant_id, property_id, room_id, task_type, source) VALUES ($1, $2, $3, $4, 'manual')
     RETURNING id`,
    [ids.tenant, ids.property, ids.room, type],
  );

describe('housekeeping schema', () => {
  it('allows one open task of each type per room', async () => {
    const { rows } = await task();
    await expect(task()).rejects.toThrow(/housekeeping_tasks_one_open/);
    await expect(task('inspect')).resolves.toBeDefined();
    await admin.query(`UPDATE housekeeping_tasks SET status = 'done', completed_at = now() WHERE id = $1`, [
      rows[0].id,
    ]);
    await expect(task()).resolves.toBeDefined();
  });

  it('keeps completion time and status consistent', async () => {
    // The open inspection task from the previous test.
    const { rows } = await admin.query(`SELECT id FROM housekeeping_tasks WHERE task_type = 'inspect'`);
    await expect(
      admin.query(`UPDATE housekeeping_tasks SET status = 'done' WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/check constraint/);
  });

  it('requires a room and a valid range for out-of-order periods', async () => {
    const ticket = (room: string | null, from: string | null, to: string | null) =>
      admin.query(
        `INSERT INTO maintenance_tickets (tenant_id, property_id, room_id, category, description, out_of_order_from, out_of_order_to)
         VALUES ($1, $2, $3, 'other', 'test', $4, $5)`,
        [ids.tenant, ids.property, room, from, to],
      );
    await expect(ticket(null, '2026-10-19', null)).rejects.toThrow(/check constraint/);
    await expect(ticket(ids.room, '2026-10-20', '2026-10-20')).rejects.toThrow(/check constraint/);
    await expect(ticket(ids.room, '2026-10-20', '2026-10-22')).resolves.toBeDefined();
  });
});
