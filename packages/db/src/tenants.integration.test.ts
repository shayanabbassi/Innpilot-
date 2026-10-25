import { sql } from 'drizzle-orm';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, withTenant, type DbHandle } from './client';
import { verifyPassword } from './password';
import * as schema from './schema';
import { createTenant } from './tenants';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
let app: DbHandle;

const base = {
  slug: 'margalla-test',
  legalName: 'Margalla Test Hotels (Pvt) Ltd',
  displayName: 'Margalla Test Hotel',
  propertyName: 'Margalla Test Hotel',
  ownerEmail: 'Owner@Margalla.example.test',
  ownerFullName: 'Test Owner',
  ownerPassword: 'a-long-test-password',
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  app = createDb(testDb.appUrl);
});

afterAll(async () => {
  await app?.close();
  await admin?.end();
  await testDb?.drop();
});

describe('createTenant', () => {
  it('creates tenant, un-onboarded property and owner atomically, with a platform audit event', async () => {
    const created = await createTenant(testDb.adminUrl, base);

    const { rows: props } = await admin.query(
      'SELECT tenant_id, timezone, currency_code, onboarding_completed_at, business_date::text FROM properties WHERE id = $1',
      [created.propertyId],
    );
    expect(props[0]).toMatchObject({
      tenant_id: created.tenantId,
      timezone: 'Asia/Karachi',
      currency_code: 'PKR',
      onboarding_completed_at: null,
    });
    expect(props[0].business_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const { rows: users } = await admin.query('SELECT email, password_hash FROM users WHERE id = $1', [
      created.ownerUserId,
    ]);
    expect(users[0].email).toBe('owner@margalla.example.test');
    expect(users[0].password_hash).not.toContain(base.ownerPassword);
    expect(await verifyPassword(users[0].password_hash, base.ownerPassword)).toBe(true);

    const { rows: roles } = await admin.query(
      'SELECT role_code, property_id FROM user_roles WHERE user_id = $1',
      [created.ownerUserId],
    );
    expect(roles).toEqual([{ role_code: 'tenant_owner', property_id: null }]);

    const { rows: audit } = await admin.query(
      `SELECT actor_type, action, changes FROM audit_events WHERE tenant_id = $1`,
      [created.tenantId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_type: 'platform', action: 'tenant.created' });
    expect(JSON.stringify(audit[0].changes)).not.toContain(base.ownerPassword);
  });

  it('is visible only inside its own tenant', async () => {
    const other = await createTenant(testDb.adminUrl, {
      ...base,
      slug: 'other-test',
      ownerEmail: 'owner@other.example.test',
    });
    const names = await withTenant(app.db, other.tenantId, (tx) =>
      tx.select({ slug: schema.tenants.slug }).from(schema.tenants),
    );
    expect(names).toEqual([{ slug: 'other-test' }]);
    const props = await withTenant(app.db, other.tenantId, (tx) =>
      tx.execute(sql`select count(*)::int as n from properties`),
    );
    expect(props.rows[0]).toEqual({ n: 1 });
  });

  it('rejects a duplicate slug or owner email without leaving partial rows', async () => {
    const before = await admin.query('SELECT count(*)::int AS n FROM tenants');
    await expect(
      createTenant(testDb.adminUrl, { ...base, ownerEmail: 'new@x.example.test' }),
    ).rejects.toThrow(/slug "margalla-test" already exists/);
    await expect(createTenant(testDb.adminUrl, { ...base, slug: 'fresh-slug' })).rejects.toThrow(
      /already registered/,
    );
    const after = await admin.query('SELECT count(*)::int AS n FROM tenants');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('validates input before touching the database', async () => {
    await expect(createTenant(testDb.adminUrl, { ...base, slug: 'Bad Slug!' })).rejects.toThrow(/slug/);
    await expect(createTenant(testDb.adminUrl, { ...base, ownerPassword: 'short' })).rejects.toThrow(
      /ownerPassword/,
    );
    await expect(
      createTenant(testDb.adminUrl, { ...base, slug: 'usd-test', currency: 'USD' as 'PKR' }),
    ).rejects.toThrow(/Only PKR/);
  });
});
