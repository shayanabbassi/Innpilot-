/**
 * Phase 6 slice 6.4 — production start-up refuses a database role that row-level security does not bind.
 */
import { createDb, createTestDatabase, type TestDatabase } from '@innpilot/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRestrictedDatabaseRole } from '../src/db/role-check';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t?.drop();
});

describe('database role check', () => {
  it('accepts the restricted application role', async () => {
    const app = createDb(t.appUrl);
    try {
      await expect(assertRestrictedDatabaseRole(app.db)).resolves.toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('refuses the owner of the tables, which row-level security does not bind', async () => {
    const owner = createDb(t.adminUrl);
    try {
      await expect(assertRestrictedDatabaseRole(owner.db)).rejects.toThrow(
        /row-level security does not bind \(it is a superuser.*owns \d+ tables\)/,
      );
    } finally {
      await owner.close();
    }
  });
});
