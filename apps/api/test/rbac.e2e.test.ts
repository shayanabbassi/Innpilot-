/**
 * SEC-002 and the staff-administration rules: permissions are enforced on the server regardless of UI,
 * property-scoped roles stay on their property, and nobody can grant more access than they hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type Harness } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

describe('permission enforcement', () => {
  it('forbids front desk from staff admin, audit log and property settings', async () => {
    const desk = await browser(h).loginActive(h.fx.users.deskA);
    expect((await desk.get('/users')).status).toBe(403);
    expect((await desk.get('/audit-events')).status).toBe(403);
    const patch = await desk.patch(`/properties/${h.fx.propA1}`, { name: 'Changed' });
    expect(patch.status).toBe(403);
    expect(patch.body.error.code).toBe('FORBIDDEN');
    expect((await desk.get(`/properties/${h.fx.propA1}`)).status).toBe(200);
  });

  it('keeps the auditor read-only', async () => {
    const auditor = await browser(h).loginActive(h.fx.users.auditorA);
    expect((await auditor.get('/users')).status).toBe(200);
    expect((await auditor.get('/audit-events')).status).toBe(200);
    expect((await auditor.patch(`/properties/${h.fx.propA1}`, { city: 'X' })).status).toBe(403);
    const create = await auditor.post('/users', {
      email: 'x@a.test',
      fullName: 'X',
      password: 'long-enough-pass',
      roles: [{ role: 'front_desk', propertyId: null }],
    });
    expect(create.status).toBe(403);
  });

  it('confines a property-scoped manager to their property', async () => {
    const m = await browser(h).loginActive(h.fx.users.managerA1);
    expect((await m.patch(`/properties/${h.fx.propA1}`, { city: 'Multan' })).status).toBe(200);
    expect((await m.patch(`/properties/${h.fx.propA2}`, { city: 'Multan' })).status).toBe(404);
    expect((await m.get('/properties')).body.data.map((p: { id: string }) => p.id)).toEqual([h.fx.propA1]);
    // Staff admin is tenant-wide and needs a tenant-wide role.
    expect((await m.get('/users')).status).toBe(403);
  });

  it('records property changes in the audit log with before and after values', async () => {
    const owner = await browser(h).loginActive(h.fx.users.ownerA);
    await owner.patch(`/properties/${h.fx.propA2}`, { checkInTime: '15:00' });
    const res = await owner.get(`/audit-events?entityId=${h.fx.propA2}`);
    const event = res.body.data.find((e: { action: string }) => e.action === 'property.updated');
    expect(event.changes).toEqual({ checkInTime: { from: '14:00', to: '15:00' } });
    expect(event.actor.userId).toBe(h.fx.users.ownerA.id);
    expect(event.requestId).toBeTruthy();
  });
});

describe('privilege escalation guards', () => {
  it('stop a manager granting the owner role or editing an owner', async () => {
    const m = await browser(h).loginActive(h.fx.users.managerA);
    const grant = await m.put(`/users/${h.fx.users.deskA.id}/roles`, {
      roles: [{ role: 'tenant_owner', propertyId: null }],
    });
    expect(grant.status).toBe(403);
    const demote = await m.put(`/users/${h.fx.users.ownerA.id}/roles`, {
      roles: [{ role: 'front_desk', propertyId: null }],
    });
    expect(demote.status).toBe(403);
    const disable = await m.post(`/users/${h.fx.users.ownerA.id}/status`, {
      status: 'disabled',
      reason: 'coup',
    });
    expect(disable.status).toBe(403);
  });

  it('stop anyone changing their own access', async () => {
    const owner = await browser(h).loginActive(h.fx.users.ownerA);
    const res = await owner.post(`/users/${h.fx.users.ownerA.id}/status`, {
      status: 'disabled',
      reason: 'oops',
    });
    expect(res.status).toBe(403);
  });

  it('let a manager create and manage front-line staff', async () => {
    const m = await browser(h).loginActive(h.fx.users.managerA);
    const created = await m.post('/users', {
      email: 'newdesk@a.test',
      fullName: 'New Desk',
      password: 'long-enough-pass',
      roles: [{ role: 'front_desk', propertyId: h.fx.propA1 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.roles).toEqual([{ role: 'front_desk', propertyId: h.fx.propA1 }]);

    const dup = await m.post('/users', {
      email: 'NEWDESK@a.test',
      fullName: 'Dup',
      password: 'long-enough-pass',
      roles: [{ role: 'front_desk', propertyId: null }],
    });
    expect(dup.status).toBe(409);

    const newDesk = browser(h);
    expect((await newDesk.login('newdesk@a.test', 'long-enough-pass')).status).toBe(200);
    expect((await newDesk.get('/properties')).body.data.map((p: { id: string }) => p.id)).toEqual([
      h.fx.propA1,
    ]);
  });

  it('lets an owner reset a lost authenticator, ending that user’s sessions', async () => {
    const target = browser(h);
    await target.loginActive(h.fx.users.managerA);
    const owner = await browser(h).loginActive(h.fx.users.ownerA);
    const res = await owner.post(`/users/${h.fx.users.managerA.id}/mfa/reset`, { reason: 'Phone lost' });
    expect(res.status).toBe(200);
    expect(res.body.data.mfaEnabled).toBe(false);
    expect((await target.get('/auth/me')).status).toBe(401);
    expect((await browser(h).login(h.fx.users.managerA.email)).body.data.sessionState).toBe('mfa_enroll');
  });

  it('keeps at least one active owner', async () => {
    const owner = await browser(h).loginActive(h.fx.users.ownerA);
    const demote = await owner.put(`/users/${h.fx.users.ownerA2.id}/roles`, {
      roles: [{ role: 'accountant', propertyId: null }],
    });
    // ownerA remains an owner, so demoting ownerA2 is allowed.
    expect(demote.status).toBe(200);
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM user_roles r JOIN users u ON u.id = r.user_id
        WHERE r.tenant_id = $1 AND r.role_code = 'tenant_owner' AND r.property_id IS NULL AND u.status = 'active'`,
      [h.fx.tenantA],
    );
    expect(rows[0].n).toBe(1);
  });
});
