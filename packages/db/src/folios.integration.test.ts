/** Folio rules held by the database (Phase 3 slice 3.3). */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = {
  tenant: '',
  property: '',
  user: '',
  guest: '',
  reservation: '',
  folio: '',
  category: '',
  journal: '',
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const one = async (text: string, values: unknown[]) =>
    (await admin.query<{ id: string }>(text, values)).rows[0]!.id;
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('folio-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  ids.user = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'f@x.test', 'F', 'x') RETURNING id`,
    [ids.tenant],
  );
  ids.guest = await one(`INSERT INTO guests (tenant_id, full_name) VALUES ($1, 'G') RETURNING id`, [
    ids.tenant,
  ]);
  ids.reservation = await one(
    `INSERT INTO reservations (tenant_id, property_id, booking_reference, guest_id, source, status)
     VALUES ($1, $2, 'FKMNTSTX', $3, 'phone', 'checked_in') RETURNING id`,
    [ids.tenant, ids.property, ids.guest],
  );
  ids.folio = await one(
    `INSERT INTO folios (tenant_id, property_id, reservation_id, guest_id, is_primary, currency_code)
     VALUES ($1, $2, $3, $4, true, 'PKR') RETURNING id`,
    [ids.tenant, ids.property, ids.reservation, ids.guest],
  );
  ids.category = await one(`SELECT id FROM charge_categories WHERE property_id = $1 AND code = 'fnb'`, [
    ids.property,
  ]);
  ids.journal = await one(
    `INSERT INTO journal_entries (tenant_id, property_id, accounting_date, currency_code, source_type, narration, created_by)
     VALUES ($1, $2, '2026-10-19', 'PKR', 'folio_charge', 'Test', $3) RETURNING id`,
    [ids.tenant, ids.property, ids.user],
  );
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const charge = (kind: string, net: string, tax: string, gross: string, reason: string | null = null) =>
  admin.query<{ id: string }>(
    `INSERT INTO folio_charges (tenant_id, property_id, folio_id, category_id, kind, description, service_date,
       unit_price, net_amount, tax_amount, gross_amount, reason, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, $5, 'Item', '2026-10-19', 0, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [ids.tenant, ids.property, ids.folio, ids.category, kind, net, tax, gross, reason, ids.journal, ids.user],
  );

describe('folios', () => {
  it('allow one main folio per reservation and are never deleted', async () => {
    await expect(
      admin.query(
        `INSERT INTO folios (tenant_id, property_id, reservation_id, guest_id, is_primary, currency_code)
         VALUES ($1, $2, $3, $4, true, 'PKR')`,
        [ids.tenant, ids.property, ids.reservation, ids.guest],
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(admin.query('DELETE FROM folios WHERE id = $1', [ids.folio])).rejects.toThrow(/not allowed/);
  });
});

describe('folio charges', () => {
  it('add up, are whole paisa, and have the right sign for their kind', async () => {
    await expect(charge('charge', '100.00', '16.00', '116.00')).resolves.toBeDefined();
    await expect(charge('charge', '100.00', '16.00', '117.00')).rejects.toThrow(/check constraint/);
    await expect(charge('charge', '100.001', '0', '100.001')).rejects.toThrow(/check constraint/);
    await expect(charge('charge', '-10.00', '0', '-10.00')).rejects.toThrow(/check constraint/);
    await expect(charge('allowance', '-10.00', '0', '-10.00')).rejects.toThrow(/check constraint/);
    await expect(charge('allowance', '-10.00', '-1.60', '-11.60', 'Late breakfast')).resolves.toBeDefined();
  });

  it('never change amounts and are never deleted; they may only be voided or transferred', async () => {
    const { rows } = await charge('charge', '50.00', '0', '50.00');
    const id = rows[0]!.id;
    await expect(
      admin.query('UPDATE folio_charges SET net_amount = 40, gross_amount = 40 WHERE id = $1', [id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(admin.query('DELETE FROM folio_charges WHERE id = $1', [id])).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      admin.query(`UPDATE folio_charges SET status = 'voided' WHERE id = $1`, [id]),
    ).rejects.toThrow(/check constraint/);
    await admin.query(
      `UPDATE folio_charges SET status = 'voided', void_journal_entry_id = $2, voided_by = $3, voided_at = now(),
         void_reason = 'Posted to the wrong guest' WHERE id = $1`,
      [id, ids.journal, ids.user],
    );
    await expect(
      admin.query(`UPDATE folio_charges SET status = 'posted', void_journal_entry_id = NULL WHERE id = $1`, [
        id,
      ]),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('keep their tax snapshot unchanged', async () => {
    const { rows } = await charge('charge', '100.00', '16.00', '116.00');
    const code = await admin.query<{ id: string }>(
      `INSERT INTO tax_codes (tenant_id, property_id, code, name, payable_account_id)
       SELECT $1, $2, 'ST', 'Sales tax', id FROM accounts WHERE tenant_id = $1 AND code = '2200' RETURNING id`,
      [ids.tenant, ids.property],
    );
    const tax = await admin.query<{ id: string }>(
      `INSERT INTO folio_charge_taxes (tenant_id, property_id, charge_id, tax_code_id, code, name, rate_percent,
         inclusive, base_amount, tax_amount, payable_account_id)
       SELECT $1, $2, $3, $4, 'ST', 'Sales tax', 16, false, 100, 16, payable_account_id FROM tax_codes WHERE id = $4
       RETURNING id`,
      [ids.tenant, ids.property, rows[0]!.id, code.rows[0]!.id],
    );
    await expect(
      admin.query('UPDATE folio_charge_taxes SET rate_percent = 17 WHERE id = $1', [tax.rows[0]!.id]),
    ).rejects.toThrow(/not allowed/);
  });
});
