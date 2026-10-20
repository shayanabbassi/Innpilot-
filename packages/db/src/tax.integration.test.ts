/** Tax setup rules held by the database (Phase 3 slice 3.2). */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = { tenant: '', property: '', other: '', otherProperty: '', payable: '', taxCode: '' };

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const one = async (text: string, values: unknown[]) =>
    (await admin.query<{ id: string }>(text, values)).rows[0]!.id;
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('tax-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  ids.other = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('tax-o', 'O', 'O') RETURNING id`,
    [],
  );
  ids.otherProperty = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'Q', '2026-10-19') RETURNING id`,
    [ids.other],
  );
  ids.payable = await one(`SELECT id FROM accounts WHERE tenant_id = $1 AND code = '2200'`, [ids.tenant]);
  ids.taxCode = await one(
    `INSERT INTO tax_codes (tenant_id, property_id, code, name, payable_account_id)
     VALUES ($1, $2, 'ST', 'Sales tax on services', $3) RETURNING id`,
    [ids.tenant, ids.property, ids.payable],
  );
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

describe('property defaults', () => {
  it('gives every new property charge categories on the template revenue accounts, and no taxes', async () => {
    const { rows } = await admin.query<{ code: string; account: string; system_kind: string | null }>(
      `SELECT c.code, a.code AS account, c.system_kind FROM charge_categories c
       JOIN accounts a ON a.id = c.revenue_account_id WHERE c.property_id = $1 ORDER BY c.code`,
      [ids.otherProperty],
    );
    expect(rows).toEqual([
      { code: 'cancellation', account: '4500', system_kind: 'cancellation' },
      { code: 'fnb', account: '4100', system_kind: null },
      { code: 'laundry', account: '4200', system_kind: null },
      { code: 'meeting', account: '4400', system_kind: null },
      { code: 'other', account: '4900', system_kind: null },
      { code: 'room', account: '4000', system_kind: 'room' },
      { code: 'transport', account: '4300', system_kind: null },
    ]);
    const taxes = await admin.query('SELECT 1 FROM tax_codes WHERE property_id = $1', [ids.otherProperty]);
    expect(taxes.rowCount).toBe(0);
    const profile = await admin.query('SELECT invoice_prefix FROM invoice_profiles WHERE property_id = $1', [
      ids.otherProperty,
    ]);
    expect(profile.rows[0].invoice_prefix).toBe('INV-');
  });

  it('keeps the room category active', async () => {
    await expect(
      admin.query(`UPDATE charge_categories SET active = false WHERE property_id = $1 AND code = 'room'`, [
        ids.property,
      ]),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('tax rates', () => {
  it('are never edited in place, and stay between 0 and 100 percent', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tax_rates (tenant_id, property_id, tax_code_id, effective_from, rate_percent)
       VALUES ($1, $2, $3, '2026-07-01', 16) RETURNING id`,
      [ids.tenant, ids.property, ids.taxCode],
    );
    await expect(
      admin.query(`UPDATE tax_rates SET rate_percent = 17 WHERE id = $1`, [rows[0]!.id]),
    ).rejects.toThrow(/not allowed/);
    await expect(
      admin.query(
        `INSERT INTO tax_rates (tenant_id, property_id, tax_code_id, effective_from, rate_percent)
         VALUES ($1, $2, $3, '2026-07-01', 18)`,
        [ids.tenant, ids.property, ids.taxCode],
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      admin.query(
        `INSERT INTO tax_rates (tenant_id, property_id, tax_code_id, effective_from, rate_percent)
         VALUES ($1, $2, $3, '2026-08-01', 101)`,
        [ids.tenant, ids.property, ids.taxCode],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('are never removed with their tax code', async () => {
    await expect(admin.query(`DELETE FROM tax_codes WHERE id = $1`, [ids.taxCode])).rejects.toThrow(
      /not allowed/,
    );
  });

  it("cannot point a category of one tenant at another tenant's tax code or account", async () => {
    const [category] = (
      await admin.query<{ id: string }>(
        `SELECT id FROM charge_categories WHERE property_id = $1 AND code = 'fnb'`,
        [ids.otherProperty],
      )
    ).rows;
    await expect(
      admin.query(
        `INSERT INTO charge_category_taxes (tenant_id, property_id, category_id, tax_code_id) VALUES ($1, $2, $3, $4)`,
        [ids.other, ids.otherProperty, category!.id, ids.taxCode],
      ),
    ).rejects.toThrow(/foreign key/);
    await expect(
      admin.query(`UPDATE charge_categories SET revenue_account_id = $2 WHERE id = $1`, [
        category!.id,
        ids.payable,
      ]),
    ).rejects.toThrow(/foreign key/);
  });
});
