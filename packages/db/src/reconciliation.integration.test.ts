/**
 * Bank reconciliation and card settlement rules enforced by the database (Phase 4 slice 4.4). Run with the owner
 * connection, so they hold even if application code is bypassed.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = { tenant: '', property: '', user: '', period: '', bank: '', drawer: '' };
const acct: Record<string, string> = {};
let nextNumber = 1;

const one = async (text: string, values: unknown[]) =>
  (await admin.query<{ id: string }>(text, values)).rows[0]!.id;

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('rec-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  ids.user = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'r@x.test', 'R', 'x') RETURNING id`,
    [ids.tenant],
  );
  ids.period = await one(
    `INSERT INTO fiscal_periods (tenant_id, start_date, end_date) VALUES ($1, '2026-10-01', '2026-10-31') RETURNING id`,
    [ids.tenant],
  );
  ids.bank = await one(`SELECT id FROM cash_accounts WHERE property_id = $1 AND kind = 'bank'`, [
    ids.property,
  ]);
  ids.drawer = await one(`SELECT id FROM cash_accounts WHERE property_id = $1 AND kind = 'cash'`, [
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

/** Posts Dr <ledger> (tagged with the cash account) / Cr 3000 and returns the cash line's id. */
async function deposit(amount: string, date = '2026-10-10', cash = ids.bank, ledger = '1100') {
  await admin.query('BEGIN');
  try {
    const entry = await one(
      `INSERT INTO journal_entries (tenant_id, property_id, accounting_date, currency_code, source_type, narration, created_by)
       VALUES ($1, $2, $3, 'PKR', 'manual', 'Deposit', $4) RETURNING id`,
      [ids.tenant, ids.property, date, ids.user],
    );
    const line = await one(
      `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_no, account_id, debit, credit, cash_account_id)
       VALUES ($1, $2, 1, $3, $4, 0, $5) RETURNING id`,
      [ids.tenant, entry, acct[ledger], amount, cash],
    );
    await admin.query(
      `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_no, account_id, debit, credit)
       VALUES ($1, $2, 2, $3, 0, $4)`,
      [ids.tenant, entry, acct['3000'], amount],
    );
    await admin.query(
      `UPDATE journal_entries SET status = 'posted', journal_number = $2, period_id = $3, total_debit = $4,
         total_credit = $4, posted_by = $5, posted_at = now() WHERE id = $1`,
      [entry, nextNumber++, ids.period, amount, ids.user],
    );
    await admin.query('COMMIT');
    return line;
  } catch (err) {
    await admin.query('ROLLBACK');
    throw err;
  }
}

const start = (date = '2026-10-15', balance = '1000') =>
  one(
    `INSERT INTO bank_reconciliations (tenant_id, property_id, cash_account_id, statement_date, statement_balance, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [ids.tenant, ids.property, ids.bank, date, balance, ids.user],
  );
const tick = (rec: string, line: string) =>
  admin.query(
    `INSERT INTO reconciliation_items (tenant_id, reconciliation_id, journal_line_id) VALUES ($1, $2, $3)`,
    [ids.tenant, rec, line],
  );

describe('bank reconciliations', () => {
  let rec: string;
  let a: string;
  let b: string;

  it('keeps one reconciliation in progress per account', async () => {
    rec = await start();
    await expect(start('2026-10-16')).rejects.toMatchObject({ code: '23505' });
  });

  it('ticks only posted lines of its own account up to the statement date, each line once', async () => {
    a = await deposit('600');
    b = await deposit('400');
    const late = await deposit('50', '2026-10-18');
    const drawerLine = await deposit('70', '2026-10-10', ids.drawer, '1000');
    await tick(rec, a);
    await expect(tick(rec, late)).rejects.toThrow(/up to the statement date/);
    await expect(tick(rec, drawerLine)).rejects.toThrow(/lines of this account/);
    await expect(tick(rec, a)).rejects.toMatchObject({ code: '23505' });
  });

  it('needs an explanation to complete with a difference, and the difference must add up', async () => {
    const complete = (cleared: string, difference: string, why: string | null) =>
      admin.query(
        `UPDATE bank_reconciliations SET status = 'completed', cleared_balance = $2, difference = $3,
           difference_explanation = $4, completed_by = $5, completed_at = now() WHERE id = $1`,
        [rec, cleared, difference, why, ids.user],
      );
    await expect(complete('600', '300', 'x')).rejects.toMatchObject({ code: '23514' });
    await expect(complete('600', '400', null)).rejects.toMatchObject({ code: '23514' });
    await complete('600', '400', 'Deposit of 400 is still in transit');
  });

  it('locks a completed reconciliation and its lines', async () => {
    await expect(
      admin.query(`UPDATE bank_reconciliations SET statement_balance = 600 WHERE id = $1`, [rec]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(admin.query(`DELETE FROM bank_reconciliations WHERE id = $1`, [rec])).rejects.toThrow(
      /cannot be changed/,
    );
    await expect(
      admin.query(`DELETE FROM reconciliation_items WHERE reconciliation_id = $1`, [rec]),
    ).rejects.toThrow(/cannot change/);
    // The next reconciliation can take the line left open, but never the one already reconciled.
    const next = await start('2026-10-31', '1050');
    await tick(next, b);
    await expect(tick(next, a)).rejects.toMatchObject({ code: '23505' });
    // One still in progress can be abandoned; its ticks go with it.
    await admin.query(`DELETE FROM bank_reconciliations WHERE id = $1`, [next]);
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM reconciliation_items WHERE journal_line_id = $1`,
      [b],
    );
    expect(rows[0]!.n).toBe(0);
  });
});

describe('card settlements', () => {
  it('keeps the fee below the gross amount and never changes a settlement', async () => {
    const clearing = await one(
      `SELECT id FROM cash_accounts WHERE property_id = $1 AND kind = 'card_clearing'`,
      [ids.property],
    );
    const journal = await one(
      `SELECT journal_entry_id AS id FROM journal_lines WHERE cash_account_id = $1 LIMIT 1`,
      [ids.bank],
    );
    const settle = (gross: string, fee: string) =>
      one(
        `INSERT INTO card_settlements (tenant_id, property_id, clearing_account_id, bank_account_id, gross_amount,
           fee_amount, business_date, journal_entry_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, '2026-10-19', $7, $8) RETURNING id`,
        [ids.tenant, ids.property, clearing, ids.bank, gross, fee, journal, ids.user],
      );
    await expect(settle('100', '100')).rejects.toMatchObject({ code: '23514' });
    const id = await settle('100', '2.50');
    await expect(admin.query(`DELETE FROM card_settlements WHERE id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
  });

  it('has row-level security on the new tables', async () => {
    const { rows } = await admin.query<{ rls: boolean }>(
      `SELECT relrowsecurity AS rls FROM pg_class
       WHERE relname IN ('bank_reconciliations', 'reconciliation_items', 'card_settlements')`,
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.rls)).toBe(true);
  });
});
