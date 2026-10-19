import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = { tenant: '', property: '', user: '' };

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const one = async (text: string, values: unknown[]) =>
    (await admin.query<{ id: string }>(text, values)).rows[0]!.id;
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('close-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  ids.user = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'c@x.test', 'C', 'x') RETURNING id`,
    [ids.tenant],
  );
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const close = (date: string, next: string, unresolved = '[]', reason: string | null = null) =>
  admin.query(
    `INSERT INTO business_date_closes (tenant_id, property_id, business_date, next_date, unresolved, reason, snapshot, closed_by)
     VALUES ($1, $2, $3, $4, $5, $6, '{}', $7) RETURNING id`,
    [ids.tenant, ids.property, date, next, unresolved, reason, ids.user],
  );

describe('business date closes', () => {
  it('allows each date to be closed only once', async () => {
    await close('2026-10-19', '2026-10-20');
    await expect(close('2026-10-19', '2026-10-20')).rejects.toThrow(/duplicate key/);
  });

  it('only advances by one day and needs a reason for unresolved items', async () => {
    await expect(close('2026-10-20', '2026-10-22')).rejects.toThrow(/check constraint/);
    await expect(close('2026-10-20', '2026-10-21', '[{"check":"overstays"}]')).rejects.toThrow(
      /check constraint/,
    );
    await expect(
      close('2026-10-20', '2026-10-21', '[{"check":"overstays"}]', 'Known overstay'),
    ).resolves.toBeDefined();
  });

  it('is never edited or removed', async () => {
    await expect(admin.query(`DELETE FROM business_date_closes`)).rejects.toThrow(/not allowed/);
  });
});
