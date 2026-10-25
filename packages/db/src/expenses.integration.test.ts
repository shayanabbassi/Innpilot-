/**
 * Supplier, expense and payable rules enforced by the database (Phase 4 slice 4.3). Run with the owner connection,
 * so they hold even if application code is bypassed.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = { tenant: '', property: '', maker: '', checker: '', supplier: '', period: '', bank: '' };
const acct: Record<string, string> = {};
let nextNumber = 1;
let nextVoucher = 1;

const one = async (text: string, values: unknown[]) =>
  (await admin.query<{ id: string }>(text, values)).rows[0]!.id;

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('exp-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  ids.maker = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'm@x.test', 'M', 'x') RETURNING id`,
    [ids.tenant],
  );
  ids.checker = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'k@x.test', 'K', 'x') RETURNING id`,
    [ids.tenant],
  );
  ids.period = await one(
    `INSERT INTO fiscal_periods (tenant_id, start_date, end_date) VALUES ($1, '2026-10-01', '2026-10-31') RETURNING id`,
    [ids.tenant],
  );
  ids.supplier = await one(
    `INSERT INTO suppliers (tenant_id, name) VALUES ($1, 'Fresh Foods') RETURNING id`,
    [ids.tenant],
  );
  ids.bank = await one(`SELECT id FROM cash_accounts WHERE property_id = $1 AND kind = 'bank'`, [
    ids.property,
  ]);
  for (const r of (
    await admin.query<{ id: string; code: string }>('SELECT id, code FROM accounts WHERE tenant_id = $1', [
      ids.tenant,
    ])
  ).rows)
    acct[r.code] = r.id;
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

/** Posts Dr 6100 / Cr <credit code> 100, with the given supplier on each line. */
async function post(credit: string, supplierOnCredit: string | null, supplierOnDebit: string | null = null) {
  await admin.query('BEGIN');
  try {
    const id = await one(
      `INSERT INTO journal_entries (tenant_id, property_id, accounting_date, currency_code, source_type, narration, created_by)
       VALUES ($1, $2, '2026-10-19', 'PKR', 'manual', 'Bill', $3) RETURNING id`,
      [ids.tenant, ids.property, ids.maker],
    );
    await admin.query(
      `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_no, account_id, debit, credit, supplier_id)
       VALUES ($1, $2, 1, $3, 100, 0, $4), ($1, $2, 2, $5, 0, 100, $6)`,
      [ids.tenant, id, acct['6100'], supplierOnDebit, acct[credit], supplierOnCredit],
    );
    await admin.query(
      `UPDATE journal_entries SET status = 'posted', journal_number = $2, period_id = $3, total_debit = 100,
         total_credit = 100, posted_by = $4, posted_at = now() WHERE id = $1`,
      [id, nextNumber++, ids.period, ids.maker],
    );
    await admin.query('COMMIT');
    return id;
  } catch (err) {
    await admin.query('ROLLBACK');
    throw err;
  }
}

const voucher = (kind: 'cash' | 'bill', supplier: string | null, total = '100') =>
  one(
    `INSERT INTO expense_vouchers (tenant_id, property_id, voucher_number, kind, supplier_id, expense_date, description,
       net_amount, total_amount, created_by)
     VALUES ($1, $2, $3, $4, $5, '2026-10-19', 'Vegetables', $6, $6, $7) RETURNING id`,
    [ids.tenant, ids.property, `EXP-${nextVoucher++}`, kind, supplier, total, ids.maker],
  );

describe('suppliers on the ledger', () => {
  it('refuses an accounts payable line without its supplier, and a supplier on any other line', async () => {
    await expect(post('2000', null)).rejects.toThrow(/accounts payable line without its supplier/);
    await expect(post('2400', null, ids.supplier)).rejects.toThrow(/supplier elsewhere/);
    await expect(post('2000', ids.supplier)).resolves.toBeTruthy();
  });

  it('keeps supplier names unique per tenant, ignoring case, and never deletes a supplier', async () => {
    await expect(
      admin.query(`INSERT INTO suppliers (tenant_id, name) VALUES ($1, ' fresh foods ')`, [ids.tenant]),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(admin.query(`DELETE FROM suppliers WHERE id = $1`, [ids.supplier])).rejects.toThrow(
      /append-only/,
    );
  });
});

describe('expense vouchers', () => {
  it('needs a supplier on a bill, and keeps maker and checker apart', async () => {
    await expect(voucher('bill', null)).rejects.toMatchObject({ code: '23514' });
    const id = await voucher('bill', ids.supplier);
    await expect(
      admin.query(`UPDATE expense_vouchers SET approved_by = $2 WHERE id = $1`, [id, ids.maker]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('locks amounts and lines once submitted, and never deletes', async () => {
    const id = await voucher('bill', ids.supplier);
    await admin.query(
      `INSERT INTO expense_lines (tenant_id, voucher_id, line_no, account_id, amount) VALUES ($1, $2, 1, $3, 100)`,
      [ids.tenant, id, acct['5000']],
    );
    await admin.query(`UPDATE expense_vouchers SET status = 'submitted', submitted_by = $2 WHERE id = $1`, [
      id,
      ids.maker,
    ]);
    await expect(
      admin.query(`UPDATE expense_vouchers SET net_amount = 90, total_amount = 90 WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(
      admin.query(
        `INSERT INTO expense_lines (tenant_id, voucher_id, line_no, account_id, amount) VALUES ($1, $2, 2, $3, 5)`,
        [ids.tenant, id, acct['5000']],
      ),
    ).rejects.toThrow(/cannot be changed/);
    await expect(admin.query(`DELETE FROM expense_vouchers WHERE id = $1`, [id])).rejects.toThrow(
      /never deleted/,
    );
    // A void needs who and why.
    await expect(
      admin.query(`UPDATE expense_vouchers SET status = 'void' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await admin.query(
      `UPDATE expense_vouchers SET status = 'void', voided_by = $2, voided_at = now(), void_reason = 'Duplicate'
       WHERE id = $1`,
      [id, ids.checker],
    );
    await expect(
      admin.query(`UPDATE expense_vouchers SET status = 'submitted' WHERE id = $1`, [id]),
    ).rejects.toThrow(/void expense/);
  });

  it('pays only approved bills, never more than the bill', async () => {
    const id = await voucher('bill', ids.supplier, '100');
    const journal = await post('2000', ids.supplier);
    const pay = (amount: string) =>
      admin.query(
        `INSERT INTO expense_payments (tenant_id, property_id, voucher_id, cash_account_id, amount, business_date,
           journal_entry_id, created_by) VALUES ($1, $2, $3, $4, $5, '2026-10-19', $6, $7)`,
        [ids.tenant, ids.property, id, ids.bank, amount, journal, ids.maker],
      );
    await expect(pay('10')).rejects.toThrow(/approved, unpaid supplier bill/);
    await admin.query(
      `UPDATE expense_vouchers SET status = 'approved', approved_by = $2, approved_at = now(), journal_entry_id = $3
       WHERE id = $1`,
      [id, ids.checker, journal],
    );
    await pay('60');
    await expect(pay('40.01')).rejects.toThrow(/exceed the bill/);
    await pay('40');
    await expect(admin.query(`DELETE FROM expense_payments WHERE voucher_id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
  });

  it('has row-level security on every new table', async () => {
    const { rows } = await admin.query<{ rls: boolean }>(
      `SELECT relrowsecurity AS rls FROM pg_class
       WHERE relname IN ('suppliers', 'expense_vouchers', 'expense_lines', 'expense_payments')`,
    );
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.rls)).toBe(true);
  });
});
