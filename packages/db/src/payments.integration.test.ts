/** Payment rules held by the database (Phase 3 slice 3.4). */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = {
  tenant: '',
  property: '',
  user: '',
  folio: '',
  reservation: '',
  cash: '',
  journal: '',
  payment: '',
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const one = async (text: string, values: unknown[]) =>
    (await admin.query<{ id: string }>(text, values)).rows[0]!.id;
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('pay-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  ids.user = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'p@x.test', 'P', 'x') RETURNING id`,
    [ids.tenant],
  );
  const guest = await one(`INSERT INTO guests (tenant_id, full_name) VALUES ($1, 'G') RETURNING id`, [
    ids.tenant,
  ]);
  ids.reservation = await one(
    `INSERT INTO reservations (tenant_id, property_id, booking_reference, guest_id, source, status)
     VALUES ($1, $2, 'PAYMTSTX', $3, 'phone', 'confirmed') RETURNING id`,
    [ids.tenant, ids.property, guest],
  );
  ids.folio = await one(
    `INSERT INTO folios (tenant_id, property_id, reservation_id, guest_id, is_primary, currency_code)
     VALUES ($1, $2, $3, $4, true, 'PKR') RETURNING id`,
    [ids.tenant, ids.property, ids.reservation, guest],
  );
  ids.cash = await one(`SELECT id FROM cash_accounts WHERE property_id = $1 AND kind = 'cash'`, [
    ids.property,
  ]);
  ids.journal = await one(
    `INSERT INTO journal_entries (tenant_id, property_id, accounting_date, currency_code, source_type, narration, created_by)
     VALUES ($1, $2, '2026-10-19', 'PKR', 'payment', 'Test', $3) RETURNING id`,
    [ids.tenant, ids.property, ids.user],
  );
  ids.payment = await one(
    `INSERT INTO payments (tenant_id, property_id, folio_id, reservation_id, kind, method, cash_account_id, amount,
       currency_code, business_date, receipt_number, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, 'deposit', 'cash', $5, 1000, 'PKR', '2026-10-19', 'RCT-000001', $6, $7) RETURNING id`,
    [ids.tenant, ids.property, ids.folio, ids.reservation, ids.cash, ids.journal, ids.user],
  );
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const refund = (amount: string, number: string) =>
  admin.query(
    `INSERT INTO refunds (tenant_id, property_id, payment_id, amount, method, cash_account_id, reason, business_date,
       refund_number, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, 'cash', $5, 'Guest cancelled', '2026-10-19', $6, $7, $8)`,
    [ids.tenant, ids.property, ids.payment, amount, ids.cash, number, ids.journal, ids.user],
  );
const apply = (amount: string) =>
  admin.query(
    `INSERT INTO deposit_applications (tenant_id, property_id, payment_id, amount, journal_entry_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [ids.tenant, ids.property, ids.payment, amount, ids.journal, ids.user],
  );

describe('property defaults', () => {
  it('give every property cash, bank and card accounts and a cancellation fee category', async () => {
    const cash = await admin.query<{ kind: string; code: string }>(
      `SELECT c.kind, a.code FROM cash_accounts c JOIN accounts a ON a.id = c.ledger_account_id
       WHERE c.property_id = $1 ORDER BY a.code`,
      [ids.property],
    );
    expect(cash.rows).toEqual([
      { kind: 'cash', code: '1000' },
      { kind: 'bank', code: '1100' },
      { kind: 'card_clearing', code: '1150' },
    ]);
    const fee = await admin.query(
      `SELECT 1 FROM charge_categories c JOIN accounts a ON a.id = c.revenue_account_id
       WHERE c.property_id = $1 AND c.system_kind = 'cancellation' AND a.code = '4500'`,
      [ids.property],
    );
    expect(fee.rowCount).toBe(1);
  });
});

describe('payments', () => {
  it('are append-only, in whole paisa, with unique receipt numbers', async () => {
    await expect(admin.query('UPDATE payments SET amount = 1 WHERE id = $1', [ids.payment])).rejects.toThrow(
      /not allowed/,
    );
    await expect(admin.query('DELETE FROM payments WHERE id = $1', [ids.payment])).rejects.toThrow(
      /not allowed/,
    );
    await expect(
      admin.query(
        `INSERT INTO payments (tenant_id, property_id, folio_id, reservation_id, kind, method, cash_account_id, amount,
           currency_code, business_date, receipt_number, journal_entry_id, created_by)
         VALUES ($1, $2, $3, $4, 'payment', 'cash', $5, 10.005, 'PKR', '2026-10-19', 'RCT-000002', $6, $7)`,
        [ids.tenant, ids.property, ids.folio, ids.reservation, ids.cash, ids.journal, ids.user],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('never refund or apply more than was received (Scenario C)', async () => {
    await refund('400', 'RF-1');
    await apply('500');
    await expect(refund('100.01', 'RF-2')).rejects.toThrow(/only 100\.0000 left/);
    await expect(apply('100.01')).rejects.toThrow(/only 100\.0000 left/);
    await expect(refund('100', 'RF-3')).resolves.toBeDefined();
    await expect(refund('400', 'RF-1')).rejects.toThrow();
    await expect(admin.query('DELETE FROM refunds')).rejects.toThrow(/not allowed/);
  });
});
