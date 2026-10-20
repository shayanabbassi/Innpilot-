/**
 * Year-end close records enforced by the database (Phase 4 slice 4.6). Run with the owner connection, so they hold
 * even if application code is bypassed.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = { tenant: '', user: '' };

const one = async (text: string, values: unknown[]) =>
  (await admin.query<{ id: string }>(text, values)).rows[0]!.id;

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  ids.tenant = await one(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ('year-t', 'T', 'T') RETURNING id`,
    [],
  );
  ids.user = await one(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, 'y@x.test', 'Y', 'x') RETURNING id`,
    [ids.tenant],
  );
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const closeYear = (year = 2026) =>
  one(
    `INSERT INTO fiscal_years (tenant_id, year, result, closed_by) VALUES ($1, $2, 1500, $3) RETURNING id`,
    [ids.tenant, year, ids.user],
  );

describe('fiscal years', () => {
  let year: string;

  it('closes a year once at a time', async () => {
    year = await closeYear();
    await expect(closeYear()).rejects.toMatchObject({ code: '23505' });
  });

  it('reopens only with a reason, changes nothing else, and is never deleted', async () => {
    await expect(
      admin.query(
        `UPDATE fiscal_years SET status = 'reopened', reopened_by = $2, reopened_at = now() WHERE id = $1`,
        [year, ids.user],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE fiscal_years SET result = 0 WHERE id = $1`, [year])).rejects.toThrow(
      /can only be reopened/,
    );
    await admin.query(
      `UPDATE fiscal_years SET status = 'reopened', reopened_by = $2, reopened_at = now(), reopen_reason = 'Late bill'
       WHERE id = $1`,
      [year, ids.user],
    );
    await expect(
      admin.query(`UPDATE fiscal_years SET reopen_reason = 'Other' WHERE id = $1`, [year]),
    ).rejects.toThrow(/can only be reopened/);
    await expect(admin.query(`DELETE FROM fiscal_years WHERE id = $1`, [year])).rejects.toThrow(
      /can only be reopened/,
    );
    // Reopened, the year can be closed again; the earlier close stays as history.
    await expect(closeYear()).resolves.toBeTruthy();
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM fiscal_years WHERE tenant_id = $1 AND year = 2026`,
      [ids.tenant],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it('has row-level security on the new tables', async () => {
    const { rows } = await admin.query<{ rls: boolean }>(
      `SELECT relrowsecurity AS rls FROM pg_class WHERE relname IN ('fiscal_years', 'fiscal_year_entries')`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.rls)).toBe(true);
  });
});
