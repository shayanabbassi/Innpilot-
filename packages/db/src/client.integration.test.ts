import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { createTestDatabase, type TestDatabase } from './testing';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase();
});

afterAll(async () => {
  await tdb?.drop();
});

describe('connection pool', () => {
  it('survives an idle connection the server ends, and reconnects', async () => {
    const handle = createDb(tdb.appUrl, { max: 1 });
    try {
      const pid = Number(
        (await handle.pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid,
      );

      // As a database restart or a force-dropped database would: the server ends the pool's idle connection.
      const admin = new Client({ connectionString: tdb.adminUrl });
      await admin.connect();
      try {
        await admin.query('select pg_terminate_backend($1)', [pid]);
      } finally {
        await admin.end();
      }
      await new Promise((r) => setTimeout(r, 200));

      // Without the pool's error listener the line above crashes the process with an uncaught exception.
      const again = await handle.pool.query<{ pid: number }>('select pg_backend_pid() as pid');
      expect(Number(again.rows[0]!.pid)).not.toBe(pid);
    } finally {
      await handle.close();
    }
  });
});
