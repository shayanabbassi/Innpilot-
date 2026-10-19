/**
 * SEC-001: a user from Tenant A must not read or change anything belonging to Tenant B,
 * and must not be able to tell whether a Tenant B record exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let ownerA: BrowserClient;

beforeAll(async () => {
  h = await startHarness();
  ownerA = await browser(h).loginActive(h.fx.users.ownerA);
  // Give Tenant B some audit history to (not) find.
  await (
    await browser(h).loginActive(h.fx.users.ownerB)
  ).patch(`/properties/${h.fx.propB1}`, { city: 'Quetta' });
});

afterAll(async () => {
  await h?.close();
});

describe('cross-tenant isolation', () => {
  it("lists only the caller's tenant", async () => {
    const props = await ownerA.get('/properties');
    expect(props.body.data.map((p: { id: string }) => p.id).sort()).toEqual(
      [h.fx.propA1, h.fx.propA2].sort(),
    );

    const users = await ownerA.get('/users');
    const emails: string[] = users.body.data.map((u: { email: string }) => u.email);
    expect(emails.length).toBeGreaterThan(0);
    expect(emails.every((e) => e.endsWith('@a.test'))).toBe(true);

    const audit = await ownerA.get('/audit-events?limit=100');
    const propertyIds = audit.body.data.map((e: { propertyId: string | null }) => e.propertyId);
    expect(propertyIds).not.toContain(h.fx.propB1);
  });

  it("answers 404 for another tenant's property, identical to a missing one", async () => {
    const foreign = await ownerA.get(`/properties/${h.fx.propB1}`);
    const missing = await ownerA.get('/properties/00000000-0000-4000-8000-000000000000');
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toEqual(missing.body.error);
  });

  it("cannot change another tenant's property", async () => {
    const res = await ownerA.patch(`/properties/${h.fx.propB1}`, { name: 'Hijacked' });
    expect(res.status).toBe(404);
    const { rows } = await h.admin.query('SELECT name FROM properties WHERE id = $1', [h.fx.propB1]);
    expect(rows[0].name).toBe('B One');
  });

  it("cannot administer another tenant's users", async () => {
    const target = h.fx.users.deskB.id;
    const roles = await ownerA.put(`/users/${target}/roles`, {
      roles: [{ role: 'front_desk', propertyId: null }],
    });
    const status = await ownerA.post(`/users/${target}/status`, { status: 'disabled', reason: 'attack' });
    const mfa = await ownerA.post(`/users/${h.fx.users.ownerB.id}/mfa/reset`, { reason: 'attack' });
    for (const res of [roles, status, mfa]) expect(res.status).toBe(404);

    const { rows } = await h.admin.query<{ status: string; mfa_enabled_at: Date | null }>(
      'SELECT status, mfa_enabled_at FROM users WHERE id = ANY($1)',
      [[target, h.fx.users.ownerB.id]],
    );
    expect(rows.every((r) => r.status === 'active')).toBe(true);
    expect(rows.some((r) => r.mfa_enabled_at !== null)).toBe(true);
  });

  it("cannot assign a role on another tenant's property", async () => {
    const res = await ownerA.post('/users', {
      email: 'sneaky@a.test',
      fullName: 'Sneaky',
      password: 'long-enough-pass',
      roles: [{ role: 'front_desk', propertyId: h.fx.propB1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a client-supplied tenant id outright', async () => {
    const res = await ownerA.post('/users', {
      email: 'other@a.test',
      fullName: 'Other',
      password: 'long-enough-pass',
      roles: [{ role: 'front_desk', propertyId: null }],
      tenantId: h.fx.tenantB,
    });
    expect(res.status).toBe(400);
    const { rowCount } = await h.admin.query(`SELECT 1 FROM users WHERE email = 'other@a.test'`);
    expect(rowCount).toBe(0);
  });

  it("filters audit events by another tenant's entity id to nothing", async () => {
    const res = await ownerA.get(`/audit-events?entityId=${h.fx.users.ownerB.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });
});
