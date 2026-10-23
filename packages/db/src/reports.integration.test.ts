/**
 * Report groups on the chart of accounts (Phase 5 slice 5.1, P5-4), enforced by the database: every account has a
 * group that fits its class, new accounts get the usual one, and the default chart places equipment and loans as
 * non-current.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
let tenant = '';

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  tenant = (
    await admin.query<{ id: string }>(
      `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('groups-t', 'T', 'T') RETURNING id`,
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const group = async (code: string) =>
  (
    await admin.query<{ g: string }>(
      `SELECT report_group AS g FROM accounts WHERE tenant_id = $1 AND code = $2`,
      [tenant, code],
    )
  ).rows[0]?.g;

describe('report groups', () => {
  it('seeds the default chart of a new tenant with a group for every account', async () => {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM accounts WHERE tenant_id = $1 AND report_group IS NULL`,
      [tenant],
    );
    expect(rows[0]!.n).toBe('0');
    expect(await group('1000')).toBe('current_asset');
    expect(await group('1500')).toBe('non_current_asset');
    expect(await group('1590')).toBe('non_current_asset');
    expect(await group('2000')).toBe('current_liability');
    expect(await group('2400')).toBe('non_current_liability');
    expect(await group('3100')).toBe('equity');
    expect(await group('4000')).toBe('revenue');
    expect(await group('5000')).toBe('cost_of_sales');
    expect(await group('6100')).toBe('operating_expense');
    expect(await group('7000')).toBe('other');
  });

  it('gives a new account the usual group for its class', async () => {
    await admin.query(
      `INSERT INTO accounts (tenant_id, code, name, account_class, normal_balance)
       VALUES ($1, '1600', 'Vehicles', 'asset', 'debit'), ($1, '6150', 'Gas', 'expense', 'debit')`,
      [tenant],
    );
    expect(await group('1600')).toBe('current_asset');
    expect(await group('6150')).toBe('operating_expense');
  });

  it('refuses a group that does not fit the class', async () => {
    await expect(
      admin.query(
        `UPDATE accounts SET report_group = 'current_asset' WHERE tenant_id = $1 AND code = '4000'`,
        [tenant],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `UPDATE accounts SET report_group = 'non_current_liability' WHERE tenant_id = $1 AND code = '1600'`,
        [tenant],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      admin.query(
        `INSERT INTO accounts (tenant_id, code, name, account_class, normal_balance, report_group)
         VALUES ($1, '6160', 'Water', 'expense', 'debit', 'other')`,
        [tenant],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await admin.query(
      `UPDATE accounts SET report_group = 'non_current_asset' WHERE tenant_id = $1 AND code = '1600'`,
      [tenant],
    );
    expect(await group('1600')).toBe('non_current_asset');
  });
});
