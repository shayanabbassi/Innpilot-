import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOCKOUT_MINUTES, MAX_FAILED_ATTEMPTS } from '../src/auth/auth.service';
import { browser, PASSWORD, startHarness, totp, type Harness } from './harness';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.close();
});

async function auditActions(userId: string): Promise<string[]> {
  const { rows } = await h.admin.query<{ action: string }>(
    'SELECT action FROM audit_events WHERE entity_id = $1 ORDER BY occurred_at',
    [userId],
  );
  return rows.map((r) => r.action);
}

describe('sign in', () => {
  it('starts an active session for a non-privileged user and sets hardened cookies', async () => {
    const c = browser(h);
    const res = await c.login(h.fx.users.deskA.email);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sessionState: 'active' });

    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = cookies.find((x) => x.startsWith('ip_session='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    const csrf = cookies.find((x) => x.startsWith('ip_csrf='))!;
    expect(csrf).not.toMatch(/HttpOnly/i);

    const me = await c.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe(h.fx.users.deskA.email);
    expect(me.body.data.properties.map((p: { id: string }) => p.id).sort()).toEqual(
      [h.fx.propA1, h.fx.propA2].sort(),
    );
    expect(me.body.data.properties[0].permissions).toContain('stay.checkin');
    expect(me.body.data.properties[0].permissions).not.toContain('user.manage');
    expect(await auditActions(h.fx.users.deskA.id)).toContain('auth.login');
  });

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const unknown = await browser(h).login('nobody@a.test');
    const wrong = await browser(h).login(h.fx.users.auditorA.email, 'wrong-password-123');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error).toEqual(wrong.body.error);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it(`locks the account after ${MAX_FAILED_ATTEMPTS} failures, even for the right password`, async () => {
    const user = h.fx.users.housekeepingA;
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await browser(h).login(user.email, 'wrong-password-123');
    const res = await browser(h).login(user.email, PASSWORD);
    expect(res.status).toBe(423);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(res.body.error.message).toContain(String(LOCKOUT_MINUTES));
    expect(await auditActions(user.id)).toContain('auth.account_locked');

    await h.admin.query('UPDATE users SET locked_until = NULL WHERE id = $1', [user.id]);
    expect((await browser(h).login(user.email)).status).toBe(200);
  });

  it('refuses disabled users', async () => {
    const user = h.fx.users.auditorA;
    await h.admin.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [user.id]);
    const res = await browser(h).login(user.email);
    expect(res.status).toBe(403);
    await h.admin.query(`UPDATE users SET status = 'active' WHERE id = $1`, [user.id]);
  });
});

describe('sessions', () => {
  it('end on logout; the old cookie no longer works', async () => {
    const c = browser(h);
    await c.login(h.fx.users.deskA.email);
    expect((await c.post('/auth/logout')).status).toBe(200);
    const after = await c.get('/auth/me');
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('require the CSRF token on state-changing requests', async () => {
    const c = browser(h);
    await c.login(h.fx.users.deskA.email);
    const missing = await c.agent.post('/api/v1/auth/logout').set('origin', 'http://localhost:3000');
    expect(missing.status).toBe(403);
    expect(missing.body.error.code).toBe('CSRF_FAILED');
    c.csrf = 'forged-token-value';
    const forged = await c.post('/auth/logout');
    expect(forged.body.error.code).toBe('CSRF_FAILED');
  });

  it('expire after the idle timeout', async () => {
    const c = browser(h);
    await c.login(h.fx.users.deskA.email);
    await h.admin.query(
      `UPDATE sessions SET idle_expires_at = now() - interval '1 second' WHERE user_id = $1 AND revoked_at IS NULL`,
      [h.fx.users.deskA.id],
    );
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('end when the user is disabled by an administrator', async () => {
    const desk = browser(h);
    await desk.login(h.fx.users.deskA.email);
    const owner = await browser(h).loginActive(h.fx.users.ownerA);
    const disable = await owner.post(`/users/${h.fx.users.deskA.id}/status`, {
      status: 'disabled',
      reason: 'Left the hotel',
    });
    expect(disable.status).toBe(200);
    expect((await desk.get('/auth/me')).status).toBe(401);
    await owner.post(`/users/${h.fx.users.deskA.id}/status`, { status: 'active', reason: 'Rehired' });
  });
});

describe('two-step verification', () => {
  it('blocks a privileged user without MFA until they enrol', async () => {
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, full_name, password_hash)
       SELECT tenant_id, 'newacct@a.test', 'New Accountant', password_hash FROM users WHERE id = $1 RETURNING id`,
      [h.fx.users.deskA.id],
    );
    await h.admin.query(
      `INSERT INTO user_roles (tenant_id, user_id, role_code) VALUES ($1, $2, 'accountant')`,
      [h.fx.tenantA, rows[0]!.id],
    );

    const c = browser(h);
    const login = await c.login('newacct@a.test');
    expect(login.body.data.sessionState).toBe('mfa_enroll');

    const blocked = await c.get('/properties');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');
    expect((await c.get('/auth/me')).body.data).toMatchObject({ sessionState: 'mfa_enroll', properties: [] });

    const setup = await c.post('/auth/mfa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\/InnPilot/);
    const { rows: stored } = await h.admin.query('SELECT mfa_secret_enc FROM users WHERE id = $1', [
      rows[0]!.id,
    ]);
    expect(stored[0].mfa_secret_enc).not.toContain(setup.body.data.secret);

    expect((await c.post('/auth/mfa/enable', { code: '000000' })).body.error.code).toBe('INVALID_MFA_CODE');
    expect((await c.post('/auth/mfa/enable', { code: totp(setup.body.data.secret) })).status).toBe(200);
    expect((await c.get('/properties')).status).toBe(200);
  });

  it('requires a valid, unused code at sign-in for enrolled users', async () => {
    const user = h.fx.users.ownerA2;
    const c = browser(h);
    expect((await c.login(user.email)).body.data.sessionState).toBe('mfa_verify');
    expect((await c.get('/users')).body.error.code).toBe('MFA_REQUIRED');
    expect((await c.post('/auth/mfa/verify', { code: '123456' })).body.error.code).toBe('INVALID_MFA_CODE');

    const code = totp(user.mfaSecret!);
    expect((await c.post('/auth/mfa/verify', { code })).status).toBe(200);
    expect((await c.get('/users')).status).toBe(200);

    // The same code cannot be replayed in a second session.
    const other = browser(h);
    await other.login(user.email);
    expect((await other.post('/auth/mfa/verify', { code })).body.error.code).toBe('INVALID_MFA_CODE');
    await h.admin.query('UPDATE users SET mfa_last_used_step = NULL, failed_login_count = 0 WHERE id = $1', [
      user.id,
    ]);
  });

  it('applies immediately when a privileged role is granted to a signed-in user', async () => {
    const desk = browser(h);
    await desk.login(h.fx.users.deskA.email);
    expect((await desk.get('/properties')).status).toBe(200);

    const owner = await browser(h).loginActive(h.fx.users.ownerA);
    const grant = await owner.put(`/users/${h.fx.users.deskA.id}/roles`, {
      roles: [
        { role: 'front_desk', propertyId: null },
        { role: 'hotel_manager', propertyId: h.fx.propA2 },
      ],
    });
    expect(grant.status).toBe(200);
    expect((await desk.get('/properties')).body.error.code).toBe('MFA_ENROLLMENT_REQUIRED');

    await owner.put(`/users/${h.fx.users.deskA.id}/roles`, {
      roles: [{ role: 'front_desk', propertyId: null }],
    });
    expect((await desk.get('/properties')).status).toBe(200);
  });
});
