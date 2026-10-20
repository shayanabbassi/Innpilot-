/**
 * Ledger rules enforced by the database itself (Phase 3 slice 3.1). These run with the owner connection, so they
 * prove the rules hold even if application code is bypassed.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = { tenant: '', other: '', property: '', user: '', period: '', closedPeriod: '' };
const acct: Record<string, string> = {};
let nextNumber = 1;

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const one = async (text: string, values: unknown[]) =>
    (await admin.query<{ id: string }>(text, values)).rows[0]!.id;
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('ledger-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.other = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('ledger-o', 'O', 'O') RETURNING id`,
    [],
  );
  ids.property = await one(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [ids.tenant],
  );
  ids.user = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'l@x.test', 'L', 'x') RETURNING id`,
    [ids.tenant],
  );
  ids.period = await one(
    `INSERT INTO fiscal_periods (tenant_id, start_date, end_date) VALUES ($1, '2026-10-01', '2026-10-31') RETURNING id`,
    [ids.tenant],
  );
  ids.closedPeriod = await one(
    `INSERT INTO fiscal_periods (tenant_id, start_date, end_date, status, closed_by, closed_at)
     VALUES ($1, '2026-09-01', '2026-09-30', 'closed', $2, now()) RETURNING id`,
    [ids.tenant, ids.user],
  );
  const rows = await admin.query<{ id: string; code: string }>(
    'SELECT id, code FROM accounts WHERE tenant_id = $1',
    [ids.tenant],
  );
  for (const r of rows.rows) acct[r.code] = r.id;
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

interface Line {
  code: string;
  debit?: string;
  credit?: string;
}

/** Writes an entry the way the posting service does: draft, lines, then posted — all in one transaction. */
async function post(
  lines: Line[],
  opts: { date?: string; period?: string; totals?: [string, string] } = {},
): Promise<string> {
  const dr = lines.reduce((s, l) => s + Number(l.debit ?? 0), 0).toFixed(2);
  const cr = lines.reduce((s, l) => s + Number(l.credit ?? 0), 0).toFixed(2);
  await admin.query('BEGIN');
  try {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO journal_entries (tenant_id, property_id, accounting_date, currency_code, source_type, narration, created_by)
       VALUES ($1, $2, $3, 'PKR', 'manual', 'Test entry', $4) RETURNING id`,
      [ids.tenant, ids.property, opts.date ?? '2026-10-19', ids.user],
    );
    const id = rows[0]!.id;
    let n = 1;
    for (const l of lines) {
      await admin.query(
        `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_no, account_id, debit, credit)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [ids.tenant, id, n++, acct[l.code], l.debit ?? '0', l.credit ?? '0'],
      );
    }
    await admin.query(
      `UPDATE journal_entries SET status = 'posted', journal_number = $2, period_id = $3, total_debit = $4,
         total_credit = $5, posted_by = $6, posted_at = now() WHERE id = $1`,
      [id, nextNumber++, opts.period ?? ids.period, opts.totals?.[0] ?? dr, opts.totals?.[1] ?? cr, ids.user],
    );
    await admin.query('COMMIT');
    return id;
  } catch (err) {
    await admin.query('ROLLBACK');
    throw err;
  }
}

const entryCount = async () =>
  (await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM journal_entries')).rows[0]!.n;

describe('chart of accounts', () => {
  it('gives every new tenant the starter template with its system accounts', async () => {
    const { rows } = await admin.query<{ n: number; roles: string[] }>(
      `SELECT count(*)::int AS n, array_agg(system_role) FILTER (WHERE system_role IS NOT NULL) AS roles
       FROM accounts WHERE tenant_id = $1`,
      [ids.tenant],
    );
    expect(rows[0]!.n).toBe(45);
    expect(rows[0]!.roles).toEqual(
      expect.arrayContaining([
        'guest_receivable',
        'guest_deposits',
        'room_revenue',
        'tax_payable',
        'rounding',
      ]),
    );
  });

  it('keeps code, class and system role fixed, and never deletes or deactivates a system account', async () => {
    await expect(
      admin.query(`UPDATE accounts SET code = '1001' WHERE id = $1`, [acct['1000']]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(admin.query(`DELETE FROM accounts WHERE id = $1`, [acct['1500']])).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      admin.query(`UPDATE accounts SET active = false WHERE id = $1`, [acct['1200']]),
    ).rejects.toThrow(/check constraint/);
    await admin.query(`UPDATE accounts SET name = 'Front office cash' WHERE id = $1`, [acct['1000']]);
  });

  it('matches the code range to the account class', async () => {
    await expect(
      admin.query(
        `INSERT INTO accounts (tenant_id, code, name, account_class, normal_balance) VALUES ($1, '4999', 'X', 'expense', 'debit')`,
        [ids.tenant],
      ),
    ).rejects.toThrow(/check constraint/);
  });
});

describe('journal entries', () => {
  it('posts a balanced entry', async () => {
    const id = await post([
      { code: '1000', debit: '1500.00' },
      { code: '4000', credit: '1500.00' },
    ]);
    const { rows } = await admin.query('SELECT status FROM journal_entries WHERE id = $1', [id]);
    expect(rows[0].status).toBe('posted');
  });

  it('rejects an unbalanced entry at commit and leaves nothing behind (FIN-001)', async () => {
    const before = await entryCount();
    // Header totals claim a balance; the lines do not have one. Caught at commit.
    await expect(
      post(
        [
          { code: '1000', debit: '100.00' },
          { code: '4000', credit: '99.99' },
        ],
        { totals: ['100.00', '100.00'] },
      ),
    ).rejects.toThrow(/does not balance/);
    // Unequal header totals are refused straight away.
    await expect(
      post([
        { code: '1000', debit: '100.00' },
        { code: '4000', credit: '99.99' },
      ]),
    ).rejects.toThrow(/check constraint/);
    await expect(post([{ code: '1000', debit: '100.00' }], { totals: ['100.00', '100.00'] })).rejects.toThrow(
      /does not balance/,
    );
    await expect(
      post(
        [
          { code: '1000', debit: '100.00' },
          { code: '4000', credit: '100.00' },
        ],
        { totals: ['200.00', '200.00'] },
      ),
    ).rejects.toThrow(/does not balance/);
    expect(await entryCount()).toBe(before);
  });

  it('refuses lines on both sides, negative amounts and fractions of a paisa', async () => {
    await expect(
      post([
        { code: '1000', debit: '10.00', credit: '10.00' },
        { code: '4000', credit: '0' },
      ]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      post([
        { code: '1000', debit: '-10.00' },
        { code: '4000', credit: '-10.00' },
      ]),
    ).rejects.toThrow(/check constraint/);
    await expect(
      post([
        { code: '1000', debit: '10.005' },
        { code: '4000', credit: '10.005' },
      ]),
    ).rejects.toThrow(/check constraint/);
  });

  it('never changes or deletes a posted entry or its lines (FIN-004)', async () => {
    const id = await post([
      { code: '1100', debit: '500.00' },
      { code: '4900', credit: '500.00' },
    ]);
    await expect(
      admin.query(`UPDATE journal_entries SET narration = 'x' WHERE id = $1`, [id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(admin.query(`DELETE FROM journal_entries WHERE id = $1`, [id])).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(
      admin.query(`UPDATE journal_lines SET debit = 600 WHERE journal_entry_id = $1 AND debit > 0`, [id]),
    ).rejects.toThrow(/cannot be changed/);
    await expect(admin.query(`DELETE FROM journal_lines WHERE journal_entry_id = $1`, [id])).rejects.toThrow(
      /cannot be changed/,
    );
    await expect(
      admin.query(
        `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_no, account_id, debit) VALUES ($1, $2, 9, $3, 1)`,
        [ids.tenant, id, acct['1000']],
      ),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('lets a posted entry become reversed only by linking its reversal, changing nothing else', async () => {
    const original = await post([
      { code: '1000', debit: '250.00' },
      { code: '4100', credit: '250.00' },
    ]);
    await expect(
      admin.query(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [original]),
    ).rejects.toThrow(/check constraint/);

    await admin.query('BEGIN');
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO journal_entries (tenant_id, property_id, accounting_date, currency_code, source_type, narration,
         created_by, reverses_entry_id)
       VALUES ($1, $2, '2026-10-19', 'PKR', 'reversal', 'Reversal', $3, $4) RETURNING id`,
      [ids.tenant, ids.property, ids.user, original],
    );
    const reversal = rows[0]!.id;
    await admin.query(
      `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_no, account_id, debit, credit)
       VALUES ($1, $2, 1, $3, 0, 250), ($1, $2, 2, $4, 250, 0)`,
      [ids.tenant, reversal, acct['1000'], acct['4100']],
    );
    await admin.query(
      `UPDATE journal_entries SET status = 'posted', journal_number = $2, period_id = $3, total_debit = 250,
         total_credit = 250, posted_by = $4, posted_at = now() WHERE id = $1`,
      [reversal, nextNumber++, ids.period, ids.user],
    );
    await expect(
      admin.query(
        `UPDATE journal_entries SET status = 'reversed', reversed_by_id = $2, narration = 'changed' WHERE id = $1`,
        [original, reversal],
      ),
    ).rejects.toThrow(/cannot be changed/);
    await admin.query('ROLLBACK');
  });

  it('refuses to post into a closed period, or a period that does not cover the date (FIN-005)', async () => {
    await expect(
      post(
        [
          { code: '1000', debit: '10.00' },
          { code: '4000', credit: '10.00' },
        ],
        { date: '2026-09-15', period: ids.closedPeriod },
      ),
    ).rejects.toThrow(/period 2026-09 is closed/);
    await expect(
      post(
        [
          { code: '1000', debit: '10.00' },
          { code: '4000', credit: '10.00' },
        ],
        { date: '2026-11-02', period: ids.period },
      ),
    ).rejects.toThrow(/does not cover/);
  });

  it('lets drafts be edited and deleted together with their lines', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO journal_entries (tenant_id, property_id, accounting_date, currency_code, source_type, narration, created_by)
       VALUES ($1, $2, '2026-10-19', 'PKR', 'manual', 'Draft', $3) RETURNING id`,
      [ids.tenant, ids.property, ids.user],
    );
    const id = rows[0]!.id;
    await admin.query(
      `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_no, account_id, debit) VALUES ($1, $2, 1, $3, 5)`,
      [ids.tenant, id, acct['1000']],
    );
    await admin.query(`UPDATE journal_lines SET debit = 6 WHERE journal_entry_id = $1`, [id]);
    await admin.query(`DELETE FROM journal_entries WHERE id = $1`, [id]);
    const left = await admin.query('SELECT 1 FROM journal_lines WHERE journal_entry_id = $1', [id]);
    expect(left.rowCount).toBe(0);
  });
});

describe('ledger isolation', () => {
  it("hides one tenant's accounts and journals from another", async () => {
    const app = new Client({ connectionString: testDb.appUrl });
    await app.connect();
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.other]);
      const accounts = await app.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM accounts WHERE tenant_id = $1',
        [ids.tenant],
      );
      const journals = await app.query<{ n: number }>('SELECT count(*)::int AS n FROM journal_entries');
      const own = await app.query<{ n: number }>('SELECT count(*)::int AS n FROM accounts');
      expect(accounts.rows[0]!.n).toBe(0);
      expect(journals.rows[0]!.n).toBe(0);
      expect(own.rows[0]!.n).toBe(45);
      await app.query('ROLLBACK');
    } finally {
      await app.end();
    }
  });
});
