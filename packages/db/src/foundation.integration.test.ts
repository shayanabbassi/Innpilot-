import { ALL_PERMISSIONS, PERMISSIONS, ROLES, ROLE_CODES } from '@innpilot/contracts';
import { getTableColumns, getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type DbHandle } from './client';
import { migrate } from './migrate';
import * as schema from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
let app: DbHandle;
const ids = { tenantA: '', tenantB: '', propA: '', propB: '', userA: '', userB: '' };

async function insertTenant(slug: string): Promise<{ tenant: string; property: string; user: string }> {
  const t = await admin.query<{ id: string }>(
    `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1::text, $1::text, $1::text) RETURNING id`,
    [slug],
  );
  const tenant = t.rows[0]!.id;
  const p = await admin.query<{ id: string }>(
    `INSERT INTO properties (tenant_id, name, business_date) VALUES ($1, 'P', '2026-10-19') RETURNING id`,
    [tenant],
  );
  const u = await admin.query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, $2, 'U', 'x') RETURNING id`,
    [tenant, `${slug}@example.test`],
  );
  return { tenant, property: p.rows[0]!.id, user: u.rows[0]!.id };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  app = createDb(testDb.appUrl);
  const a = await insertTenant('tenant-a');
  const b = await insertTenant('tenant-b');
  Object.assign(ids, {
    tenantA: a.tenant,
    propA: a.property,
    userA: a.user,
    tenantB: b.tenant,
    propB: b.property,
    userB: b.user,
  });
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await testDb?.drop();
});

describe('migrations', () => {
  it('are idempotent on re-run', async () => {
    const result = await migrate(testDb.adminUrl);
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toContain('0001_foundation.sql');
  });

  it('seed the same permission and role catalogue as @innpilot/contracts', async () => {
    const perms = await admin.query<{ code: string; description: string }>(
      'SELECT code, description FROM permissions',
    );
    expect(Object.fromEntries(perms.rows.map((r) => [r.code, r.description]))).toEqual(PERMISSIONS);

    const roles = await admin.query<{ code: string; mfa_required: boolean }>(
      'SELECT code, mfa_required FROM roles',
    );
    expect(roles.rows.map((r) => r.code).sort()).toEqual([...ROLE_CODES].sort());
    for (const r of roles.rows)
      expect(r.mfa_required, r.code).toBe(ROLES[r.code as keyof typeof ROLES].mfaRequired);

    const grants = await admin.query<{ role_code: string; permission_code: string }>(
      'SELECT role_code, permission_code FROM role_permissions',
    );
    for (const code of ROLE_CODES) {
      const dbPerms = grants.rows.filter((g) => g.role_code === code).map((g) => g.permission_code);
      expect(dbPerms.sort(), code).toEqual([...ROLES[code].permissions].sort());
    }
    expect(ALL_PERMISSIONS.length).toBe(perms.rowCount);
  });

  it('match the Drizzle schema column-for-column', async () => {
    const tables: PgTable[] = (Object.values(schema) as unknown[]).filter((v): v is PgTable =>
      is(v, PgTable),
    );
    for (const table of tables) {
      const name = getTableName(table);
      const { rows } = await admin.query<{ column_name: string; is_nullable: 'YES' | 'NO' }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [name],
      );
      const dbColumns = new Map(rows.map((r) => [r.column_name, r.is_nullable === 'NO']));
      const drizzleColumns = Object.values(getTableColumns(table));
      expect(drizzleColumns.map((c) => c.name).sort(), `columns of ${name}`).toEqual(
        [...dbColumns.keys()].sort(),
      );
      for (const c of drizzleColumns) {
        expect(c.notNull, `${name}.${c.name} NOT NULL`).toBe(dbColumns.get(c.name));
      }
    }
  });
});

describe('row-level security guard', () => {
  it('is enabled on every table that has a tenant_id column', async () => {
    const { rows } = await admin.query<{ table_name: string; rls: boolean }>(`
      SELECT c.relname AS table_name, c.relrowsecurity AS rls
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND (EXISTS (SELECT 1 FROM pg_attribute a
                       WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
              OR c.relname = 'tenants')`);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.filter((r) => !r.rls).map((r) => r.table_name)).toEqual([]);
  });

  it('application role cannot bypass RLS', async () => {
    const { rows } = await admin.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'innpilot_app'",
    );
    expect(rows[0]).toEqual({ rolbypassrls: false, rolsuper: false });
  });
});

describe('tenant isolation (application role)', () => {
  const tenantTables = [
    'tenants',
    'properties',
    'users',
    'user_roles',
    'sessions',
    'audit_events',
    'idempotency_keys',
  ];

  it('sees nothing when no tenant context is set', async () => {
    for (const table of tenantTables) {
      const { rows } = await app.pool.query(`SELECT count(*)::int AS n FROM ${table}`);
      expect(rows[0].n, table).toBe(0);
    }
  });

  it("sees only the current tenant's rows", async () => {
    await withTenant(app.db, ids.tenantA, async (tx) => {
      const props = await tx.select().from(schema.properties);
      expect(props.map((p) => p.id)).toEqual([ids.propA]);
      const users = await tx.select().from(schema.users);
      expect(users.map((u) => u.id)).toEqual([ids.userA]);
      const tenants = await tx.select().from(schema.tenants);
      expect(tenants.map((t) => t.id)).toEqual([ids.tenantA]);
    });
  });

  it("cannot read another tenant's row by id", async () => {
    const rows = await withTenant(app.db, ids.tenantA, (tx) =>
      tx.execute(sql`select id from properties where id = ${ids.propB}`),
    );
    expect(rows.rows).toEqual([]);
  });

  it("cannot update or move another tenant's rows", async () => {
    const updated = await withTenant(app.db, ids.tenantA, (tx) =>
      tx.execute(sql`update properties set name = 'hijacked' where id = ${ids.propB}`),
    );
    expect(updated.rowCount).toBe(0);
    await expect(
      withTenant(app.db, ids.tenantA, (tx) =>
        tx.execute(sql`update properties set tenant_id = ${ids.tenantB} where id = ${ids.propA}`),
      ),
    ).rejects.toMatchObject({
      cause: { code: '42501', message: expect.stringMatching(/row-level security/) },
    });
  });

  it('cannot insert rows for another tenant', async () => {
    await expect(
      withTenant(app.db, ids.tenantA, (tx) =>
        tx.insert(schema.auditEvents).values({
          tenantId: ids.tenantB,
          actorType: 'system',
          action: 'test.write',
          entityType: 'test',
          changes: {},
        }),
      ),
    ).rejects.toMatchObject({
      cause: { code: '42501', message: expect.stringMatching(/row-level security/) },
    });
  });

  it('does not leak tenant context between pooled transactions', async () => {
    await withTenant(app.db, ids.tenantA, async () => undefined);
    const { rows } = await app.pool.query(`SELECT count(*)::int AS n FROM properties`);
    expect(rows[0].n).toBe(0);
  });

  it('rejects malformed tenant ids before touching the database', async () => {
    await expect(withTenant(app.db, "x' or 1=1 --", async () => undefined)).rejects.toThrow(/tenant UUID/);
  });
});

describe('composite foreign keys', () => {
  it("block a role assignment that points at another tenant's user or property", async () => {
    // Run as the owner (RLS bypassed) to prove the constraint itself holds, independent of RLS.
    await expect(
      admin.query(`INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1, $2, 'front_desk')`, [
        ids.tenantA,
        ids.userB,
      ]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      admin.query(
        `INSERT INTO user_roles (tenant_id, user_id, property_id, role_code) VALUES ($1, $2, $3, 'front_desk')`,
        [ids.tenantA, ids.userA, ids.propB],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('audit log', () => {
  it('is append-only even for the table owner', async () => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO audit_events (tenant_id, actor_type, action, entity_type) VALUES ($1, 'system', 'test.created', 'test')
       RETURNING id`,
      [ids.tenantA],
    );
    await expect(
      admin.query(`UPDATE audit_events SET reason = 'x' WHERE id = $1`, [rows[0]!.id]),
    ).rejects.toThrow(/append-only/);
    await expect(admin.query(`DELETE FROM audit_events WHERE id = $1`, [rows[0]!.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(admin.query(`TRUNCATE audit_events`)).rejects.toThrow(/append-only/);
  });

  it('cannot be deleted by the application role at all', async () => {
    await expect(
      withTenant(app.db, ids.tenantA, (tx) => tx.execute(sql`delete from audit_events`)),
    ).rejects.toMatchObject({
      cause: { code: '42501', message: expect.stringMatching(/permission denied/) },
    });
  });
});

describe('application role privileges', () => {
  it('cannot create tenants or read migration bookkeeping', async () => {
    await expect(
      app.pool.query(`INSERT INTO tenants (slug, legal_name, display_name) VALUES ('evil', 'e', 'e')`),
    ).rejects.toThrow(/permission denied/);
    await expect(app.pool.query(`SELECT * FROM schema_migrations`)).rejects.toThrow(/permission denied/);
  });

  it('cannot alter the role catalogue', async () => {
    await expect(
      app.pool.query(`INSERT INTO role_permissions VALUES ('front_desk', 'payment.refund')`),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('pre-tenant lookups', () => {
  it('find a login by case-insensitive email without exposing other columns', async () => {
    const { rows } = await app.pool.query(`SELECT * FROM auth_find_login('TENANT-A@example.test')`);
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['locked_until', 'password_hash', 'tenant_id', 'tenant_status', 'user_id', 'user_status'].sort(),
    );
    expect(rows[0].tenant_id).toBe(ids.tenantA);
  });

  it('resolve only live sessions', async () => {
    const live = Buffer.alloc(32, 1);
    const revoked = Buffer.alloc(32, 2);
    await admin.query(
      `INSERT INTO sessions (tenant_id, user_id, token_hash, csrf_token_hash, idle_expires_at, absolute_expires_at, revoked_at)
       VALUES ($1, $2, $3, $3, now() + interval '1 hour', now() + interval '2 hours', NULL),
              ($1, $2, $4, $4, now() + interval '1 hour', now() + interval '2 hours', now())`,
      [ids.tenantA, ids.userA, live, revoked],
    );
    const ok = await app.pool.query(`SELECT * FROM auth_resolve_session($1)`, [live]);
    expect(ok.rows[0]).toMatchObject({ tenant_id: ids.tenantA, user_id: ids.userA });
    const gone = await app.pool.query(`SELECT * FROM auth_resolve_session($1)`, [revoked]);
    expect(gone.rows).toEqual([]);
  });
});
