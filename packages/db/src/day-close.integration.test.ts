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

describe('night audit records (Phase 4.5)', () => {
  const one = async (text: string, values: unknown[]) =>
    (await admin.query<{ id: string }>(text, values)).rows[0]!.id;
  let rr: string;
  let revenue: string;
  let journal: string;

  beforeAll(async () => {
    const type = await one(
      `INSERT INTO room_types (tenant_id, property_id, code, name, capacity_adults) VALUES ($1, $2, 'STD', 'S', 2)
       RETURNING id`,
      [ids.tenant, ids.property],
    );
    const guest = await one(`INSERT INTO guests (tenant_id, full_name) VALUES ($1, 'G') RETURNING id`, [
      ids.tenant,
    ]);
    const res = await one(
      `INSERT INTO reservations (tenant_id, property_id, booking_reference, guest_id, source, status)
       VALUES ($1, $2, 'NGHTADXY', $3, 'phone', 'checked_in') RETURNING id`,
      [ids.tenant, ids.property, guest],
    );
    rr = await one(
      `INSERT INTO reservation_rooms (tenant_id, property_id, reservation_id, room_type_id, arrival, departure, adults,
         nightly_rate, currency_code) VALUES ($1, $2, $3, $4, '2026-10-19', '2026-10-22', 1, 5000, 'PKR') RETURNING id`,
      [ids.tenant, ids.property, res, type],
    );
    revenue = await one(`SELECT id FROM accounts WHERE tenant_id = $1 AND code = '4000'`, [ids.tenant]);
    journal = await one(
      `INSERT INTO journal_entries (tenant_id, property_id, accounting_date, currency_code, source_type, narration, created_by)
       VALUES ($1, $2, '2026-10-19', 'PKR', 'night_audit', 'Accrual', $3) RETURNING id`,
      [ids.tenant, ids.property, ids.user],
    );
  });

  const accrue = (night: string, auditDate = '2026-10-19', amount = '4237.29') =>
    admin.query(
      `INSERT INTO room_revenue_accruals (tenant_id, property_id, reservation_room_id, night, business_date, net_amount,
         revenue_account_id, journal_entry_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ids.tenant, ids.property, rr, night, auditDate, amount, revenue, journal],
    );

  it('seeds the unbilled guest revenue account for every tenant', async () => {
    const { rows } = await admin.query<{ code: string; cls: string }>(
      `SELECT code, account_class AS cls FROM accounts WHERE tenant_id = $1 AND system_role = 'unbilled_revenue'`,
      [ids.tenant],
    );
    expect(rows).toEqual([{ code: '1210', cls: 'asset' }]);
  });

  it('accrues a night once, never ahead of the audit date, and never changes it', async () => {
    await accrue('2026-10-19');
    await expect(accrue('2026-10-19')).rejects.toMatchObject({ code: '23505' });
    await expect(accrue('2026-10-20')).rejects.toMatchObject({ code: '23514' });
    await expect(accrue('2026-10-20', '2026-10-20', '0')).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`DELETE FROM room_revenue_accruals`)).rejects.toThrow(/append-only/);
  });

  it('records new closes as night audits', async () => {
    const { rows } = await admin.query<{ kind: string }>(
      `SELECT DISTINCT kind FROM business_date_closes WHERE property_id = $1`,
      [ids.property],
    );
    expect(rows.map((r) => r.kind)).toEqual(['night_audit']);
  });
});
