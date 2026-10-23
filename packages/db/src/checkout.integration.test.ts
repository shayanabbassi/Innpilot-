/** Check-out rules held by the database (Phase 3 slice 3.5). */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = {
  tenant: '',
  property: '',
  user: '',
  reservation: '',
  folio: '',
  category: '',
  journal: '',
  charge: '',
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const one = async (text: string, values: unknown[]) =>
    (await admin.query<{ id: string }>(text, values)).rows[0]!.id;
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('out-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  ids.user = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'o@x.test', 'O', 'x') RETURNING id`,
    [ids.tenant],
  );
  const guest = await one(`INSERT INTO guests (tenant_id, full_name) VALUES ($1, 'G') RETURNING id`, [
    ids.tenant,
  ]);
  ids.reservation = await one(
    `INSERT INTO reservations (tenant_id, property_id, booking_reference, guest_id, source, status)
     VALUES ($1, $2, 'CHKTSTXY', $3, 'phone', 'checked_in') RETURNING id`,
    [ids.tenant, ids.property, guest],
  );
  ids.folio = await one(
    `INSERT INTO folios (tenant_id, property_id, reservation_id, guest_id, is_primary, currency_code)
     VALUES ($1, $2, $3, $4, true, 'PKR') RETURNING id`,
    [ids.tenant, ids.property, ids.reservation, guest],
  );
  ids.category = await one(`SELECT id FROM charge_categories WHERE property_id = $1 AND code = 'room'`, [
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

const nightCharge = () =>
  admin.query<{ id: string }>(
    `INSERT INTO folio_charges (tenant_id, property_id, folio_id, category_id, kind, description, service_date,
       unit_price, net_amount, tax_amount, gross_amount, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, 'room_night', 'Night', '2026-10-19', 5000, 5000, 0, 5000, $5, $6) RETURNING id`,
    [ids.tenant, ids.property, ids.folio, ids.category, ids.journal, ids.user],
  );

describe('room nights', () => {
  it('can be posted only once per booked room and night (OPS-003)', async () => {
    const rr = '00000000-0000-4000-8000-0000000000aa';
    const first = (await nightCharge()).rows[0]!.id;
    await admin.query(
      `INSERT INTO room_night_charges (tenant_id, property_id, charge_id, reservation_room_id, night)
       VALUES ($1, $2, $3, $4, '2026-10-19')`,
      [ids.tenant, ids.property, first, rr],
    );
    const second = (await nightCharge()).rows[0]!.id;
    await expect(
      admin.query(
        `INSERT INTO room_night_charges (tenant_id, property_id, charge_id, reservation_room_id, night)
         VALUES ($1, $2, $3, $4, '2026-10-19')`,
        [ids.tenant, ids.property, second, rr],
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('folio settlement', () => {
  it('closes only with a settlement time, and a write-off needs its journal', async () => {
    await expect(
      admin.query(`UPDATE folios SET status = 'settled' WHERE id = $1`, [ids.folio]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      admin.query(`UPDATE folios SET written_off = 10 WHERE id = $1`, [ids.folio]),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('invoices', () => {
  const invoice = (number: string, gross: string, paid: string, due: string) =>
    admin.query<{ id: string }>(
      `INSERT INTO invoices (tenant_id, property_id, folio_id, reservation_id, invoice_number, issue_date,
         currency_code, bill_to, net_amount, tax_amount, gross_amount, paid_amount, balance_due, hotel, created_by)
       VALUES ($1, $2, $3, $4, $5, '2026-10-19', 'PKR', 'G', $6, 0, $6, $7, $8, '{}', $9) RETURNING id`,
      [ids.tenant, ids.property, ids.folio, ids.reservation, number, gross, paid, due, ids.user],
    );

  it('add up, have unique numbers and are never changed', async () => {
    await expect(invoice('INV-000001', '5000', '5000', '1')).rejects.toThrow(/check constraint/);
    const { rows } = await invoice('INV-000001', '5000', '5000', '0');
    await expect(invoice('INV-000001', '1', '1', '0')).rejects.toThrow(/duplicate key/);
    await expect(
      admin.query(`UPDATE invoices SET bill_to = 'X' WHERE id = $1`, [rows[0]!.id]),
    ).rejects.toThrow(/not allowed/);
    await expect(admin.query(`DELETE FROM invoices WHERE id = $1`, [rows[0]!.id])).rejects.toThrow(
      /not allowed/,
    );
  });
});
