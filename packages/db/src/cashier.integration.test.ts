/**
 * Cashier shift and cash closing rules enforced by the database (Phase 4 slice 4.2, CASH-001). Run with the owner
 * connection, so they hold even if application code is bypassed.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = { tenant: '', property: '', cashier: '', other: '', drawer: '', bank: '', period: '' };
const acct: Record<string, string> = {};
let nextNumber = 1;

const one = async (text: string, values: unknown[]) =>
  (await admin.query<{ id: string }>(text, values)).rows[0]!.id;

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('cash-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  ids.cashier = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'c@x.test', 'C', 'x') RETURNING id`,
    [ids.tenant],
  );
  ids.other = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'o@x.test', 'O', 'x') RETURNING id`,
    [ids.tenant],
  );
  ids.period = await one(
    `INSERT INTO fiscal_periods (tenant_id, start_date, end_date) VALUES ($1, '2026-10-01', '2026-10-31') RETURNING id`,
    [ids.tenant],
  );
  for (const r of (
    await admin.query<{ id: string; code: string }>('SELECT id, code FROM accounts WHERE tenant_id = $1', [
      ids.tenant,
    ])
  ).rows)
    acct[r.code] = r.id;
  ids.drawer = await one(`SELECT id FROM cash_accounts WHERE property_id = $1 AND kind = 'cash'`, [
    ids.property,
  ]);
  ids.bank = await one(`SELECT id FROM cash_accounts WHERE property_id = $1 AND kind = 'bank'`, [
    ids.property,
  ]);
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const openShift = (user: string, drawer = ids.drawer, count = '1000') =>
  one(
    `INSERT INTO cashier_shifts (tenant_id, property_id, cash_account_id, user_id, business_date, opening_count,
       book_balance_at_open) VALUES ($1, $2, $3, $4, '2026-10-19', $5, 0) RETURNING id`,
    [ids.tenant, ids.property, drawer, user, count],
  );

/** Posts Dr <cash ledger> / Cr 4900 with the cash line linked to `shift`. */
async function postCash(amount: string, shift: string | null, cash = ids.drawer, ledger = '1000') {
  await admin.query('BEGIN');
  try {
    const id = await one(
      `INSERT INTO journal_entries (tenant_id, property_id, accounting_date, currency_code, source_type, narration, created_by)
       VALUES ($1, $2, '2026-10-19', 'PKR', 'manual', 'Cash in', $3) RETURNING id`,
      [ids.tenant, ids.property, ids.cashier],
    );
    await admin.query(
      `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_no, account_id, debit, credit, cash_account_id, cashier_shift_id)
       VALUES ($1, $2, 1, $3, $4, 0, $5, $6), ($1, $2, 2, $7, 0, $4, NULL, NULL)`,
      [ids.tenant, id, acct[ledger], amount, cash, shift, acct['4900']],
    );
    await admin.query(
      `UPDATE journal_entries SET status = 'posted', journal_number = $2, period_id = $3, total_debit = $4,
         total_credit = $4, posted_by = $5, posted_at = now() WHERE id = $1`,
      [id, nextNumber++, ids.period, amount, ids.cashier],
    );
    await admin.query('COMMIT');
    return id;
  } catch (err) {
    await admin.query('ROLLBACK');
    throw err;
  }
}

const close = (
  shift: string,
  expected: string,
  counted: string,
  variance: string,
  explanation: string | null,
) =>
  one(
    `INSERT INTO cash_closings (tenant_id, property_id, shift_id, cash_account_id, business_date, expected_amount,
       counted_amount, variance, explanation, threshold, approval_required, status, submitted_by)
     VALUES ($1, $2, $3, $4, '2026-10-19', $5, $6, $7, $8, 500, true, 'submitted', $9) RETURNING id`,
    [ids.tenant, ids.property, shift, ids.drawer, expected, counted, variance, explanation, ids.cashier],
  );

describe('cashier shifts', () => {
  let shift: string;

  it('allows one open shift per drawer and per user', async () => {
    shift = await openShift(ids.cashier);
    await expect(openShift(ids.other)).rejects.toMatchObject({ code: '23505' });
    // The cashier cannot hold a second shift on another drawer either.
    await expect(openShift(ids.cashier, ids.bank)).rejects.toMatchObject({ code: '23505' });
  });

  it('never changes or deletes the opening facts', async () => {
    await expect(
      admin.query(`UPDATE cashier_shifts SET opening_count = 1 WHERE id = $1`, [shift]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(admin.query(`DELETE FROM cashier_shifts WHERE id = $1`, [shift])).rejects.toThrow(
      /append-only/,
    );
  });

  it('links a cash line only to an open shift on its own drawer', async () => {
    await postCash('250', shift);
    await expect(postCash('10', shift, ids.bank, '1100')).rejects.toThrow(
      /open shift on its own cash drawer/,
    );
    const { rows } = await admin.query<{ n: string }>(
      `SELECT sum(debit - credit)::numeric(19,2)::text AS n FROM journal_lines WHERE cashier_shift_id = $1`,
      [shift],
    );
    expect(rows[0]!.n).toBe('250.00');
  });
});

describe('cash closings', () => {
  let shift: string;
  let closing: string;

  beforeAll(async () => {
    shift = (
      await admin.query<{ id: string }>(
        `SELECT id FROM cashier_shifts WHERE user_id = $1 AND status = 'open'`,
        [ids.cashier],
      )
    ).rows[0]!.id;
  });

  it('needs variance = counted − expected, and an explanation for any variance', async () => {
    await expect(close(shift, '1250', '1200', '-40', 'Short')).rejects.toMatchObject({ code: '23514' });
    await expect(close(shift, '1250', '1200', '-50', null)).rejects.toMatchObject({ code: '23514' });
    await expect(close(shift, '1250', '1200', '-50', '  ')).rejects.toMatchObject({ code: '23514' });
  });

  it('locks a submitted closing; a closed shift takes no more lines', async () => {
    closing = await close(shift, '1250', '1200', '-50', 'Gave change twice');
    await admin.query(`UPDATE cashier_shifts SET status = 'closed', closed_at = now() WHERE id = $1`, [
      shift,
    ]);
    await expect(postCash('5', shift)).rejects.toThrow(/open shift/);
    await expect(
      admin.query(`UPDATE cash_closings SET counted_amount = 1250, variance = 0 WHERE id = $1`, [closing]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(admin.query(`DELETE FROM cash_closings WHERE id = $1`, [closing])).rejects.toThrow(
      /append-only/,
    );
    // One live closing per shift.
    await expect(close(shift, '1250', '1250', '0', null)).rejects.toMatchObject({ code: '23505' });
  });

  it('keeps maker and checker apart, and approval final', async () => {
    await expect(
      admin.query(
        `UPDATE cash_closings SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
        [closing, ids.cashier],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await admin.query(
      `UPDATE cash_closings SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
      [closing, ids.other],
    );
    await expect(
      admin.query(`UPDATE cash_closings SET status = 'submitted' WHERE id = $1`, [closing]),
    ).rejects.toThrow(/cannot move/);
    await expect(
      admin.query(`UPDATE cash_closings SET approved_at = now() - interval '1 day' WHERE id = $1`, [closing]),
    ).rejects.toThrow(/cannot move/);
  });

  it('reopens only with a reason, and a reopened closing stays as history', async () => {
    await expect(
      admin.query(
        `UPDATE cash_closings SET status = 'reopened', reopened_by = $2, reopened_at = now() WHERE id = $1`,
        [closing, ids.other],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await admin.query(
      `UPDATE cash_closings SET status = 'reopened', reopened_by = $2, reopened_at = now(), reopen_reason = 'Recount'
       WHERE id = $1`,
      [closing, ids.other],
    );
    await expect(
      admin.query(`UPDATE cash_closings SET status = 'approved' WHERE id = $1`, [closing]),
    ).rejects.toThrow(/cannot move/);
    // The shift can be closed again with a new closing.
    await expect(close(shift, '1250', '1250', '0', null)).resolves.toBeTruthy();
  });

  it('keeps shifts and closings within the tenant (RLS on)', async () => {
    const { rows } = await admin.query<{ t: string; rls: boolean }>(
      `SELECT relname AS t, relrowsecurity AS rls FROM pg_class WHERE relname IN ('cashier_shifts', 'cash_closings')`,
    );
    expect(rows.every((r) => r.rls)).toBe(true);
  });
});
