/**
 * Phase 6 slice 6.1 — account recovery (PRD §8; D18 manager-issued resets) and session management. A reset gives a
 * one-time temporary password that expires, ends the person's sessions and allows nothing but choosing a new
 * password; only someone who may administer the person can issue it. The temporary password appears in no log and
 * no audit record.
 */
import { hashPassword } from '@innpilot/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/auth/crypto';
import { generateTotpSecret } from '../src/auth/totp';
import {
  browser,
  MFA_KEY,
  ORIGIN,
  PASSWORD,
  startHarness,
  totp,
  type BrowserClient,
  type Harness,
} from './harness';

let h: Harness;
let owner: BrowserClient;
let manager: BrowserClient;
const lines: string[] = [];
const NEW_PASSWORD = 'a-brand-new-passphrase-2026';

beforeAll(async () => {
  h = await startHarness({ logStream: { write: (line: string) => void lines.push(line) } });
  owner = await browser(h).loginActive(h.fx.users.ownerA);
  manager = await browser(h).loginActive(h.fx.users.managerA);
});

afterAll(async () => {
  await h?.close();
});

const reset = (by: BrowserClient, userId: string, reason = 'Forgot their password at the morning shift') =>
  by.post(`/users/${userId}/password-reset`, { reason });

describe('changing your own password', () => {
  it('needs the current password and a new, different, long enough one', async () => {
    const c = await browser(h).loginActive(h.fx.users.housekeepingA);
    const wrong = await c.post('/auth/password', {
      currentPassword: 'not-the-password',
      newPassword: NEW_PASSWORD,
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details[0].path).toBe('currentPassword');
    const same = await c.post('/auth/password', { currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.status).toBe(400);
    expect(same.body.error.details[0].path).toBe('newPassword');
    expect((await c.post('/auth/password', { currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(
      400,
    );
    await h.admin.query('UPDATE users SET failed_login_count = 0 WHERE id = $1', [
      h.fx.users.housekeepingA.id,
    ]);
  });

  it('changes it, keeps this session and ends the others', async () => {
    const here = await browser(h).loginActive(h.fx.users.housekeepingA);
    const there = await browser(h).loginActive(h.fx.users.housekeepingA);
    const res = await here.post('/auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect((await here.get('/auth/me')).status).toBe(200);
    expect((await there.get('/auth/me')).status).toBe(401);
    expect((await browser(h).login(h.fx.users.housekeepingA.email)).status).toBe(401);
    expect((await browser(h).login(h.fx.users.housekeepingA.email, NEW_PASSWORD)).status).toBe(200);
  });
});

describe('manager-issued reset (D18)', () => {
  let temporary = '';

  it('gives a one-time temporary password and ends the person’s sessions', async () => {
    const desk = await browser(h).loginActive(h.fx.users.deskA);
    const res = await reset(manager, h.fx.users.deskA.id);
    expect(res.status).toBe(200);
    temporary = res.body.data.temporaryPassword;
    expect(temporary).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
    expect(res.body.data.sessionsEnded).toBeGreaterThanOrEqual(1);
    expect(Date.parse(res.body.data.expiresAt) - Date.now()).toBeGreaterThan(23 * 3_600_000);
    expect((await desk.get('/auth/me')).status).toBe(401);
    expect((await browser(h).login(h.fx.users.deskA.email)).status).toBe(401);
  });

  it('allows nothing but choosing a new password', async () => {
    const c = browser(h);
    const login = await c.login(h.fx.users.deskA.email, temporary);
    expect(login.status).toBe(200);
    expect(login.body.data.sessionState).toBe('password_change');
    expect((await c.get('/auth/me')).body.data.sessionState).toBe('password_change');
    const blocked = await c.get(`/properties/${h.fx.propA1}/reservations`);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await c.get('/auth/sessions')).status).toBe(403);
    const changed = await c.post('/auth/password', { currentPassword: temporary, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);
    expect((await c.get('/auth/me')).body.data.sessionState).toBe('active');
    expect((await c.get(`/properties/${h.fx.propA1}/reservations`)).status).toBe(200);
    // The temporary password is spent.
    expect((await browser(h).login(h.fx.users.deskA.email, temporary)).status).toBe(401);
  });

  it('stops working when it expires', async () => {
    const res = await reset(manager, h.fx.users.cashierA.id);
    await h.admin.query(`UPDATE users SET password_expires_at = now() - interval '1 minute' WHERE id = $1`, [
      h.fx.users.cashierA.id,
    ]);
    const login = await browser(h).login(h.fx.users.cashierA.email, res.body.data.temporaryPassword);
    expect(login.status).toBe(401);
    expect(login.body.error.message).toMatch(/expired/);
  });

  it('asks for two-step verification before the new password when the person uses it', async () => {
    const res = await reset(owner, h.fx.users.accountantA.id, 'Locked out after a holiday');
    expect(res.status).toBe(200);
    const c = browser(h);
    const login = await c.login(h.fx.users.accountantA.email, res.body.data.temporaryPassword);
    expect(login.body.data.sessionState).toBe('mfa_verify');
    await h.admin.query('UPDATE users SET mfa_last_used_step = NULL WHERE id = $1', [
      h.fx.users.accountantA.id,
    ]);
    expect((await c.post('/auth/mfa/verify', { code: totp(h.fx.users.accountantA.mfaSecret!) })).status).toBe(
      200,
    );
    expect((await c.get('/auth/me')).body.data.sessionState).toBe('password_change');
  });

  it('is only for people the caller may administer, with a reason', async () => {
    expect((await reset(manager, h.fx.users.ownerA.id)).status).toBe(403); // more access than the manager
    expect((await reset(manager, h.fx.users.managerA.id)).status).toBe(403); // themselves
    expect((await manager.post(`/users/${h.fx.users.deskA.id}/password-reset`, { reason: 'x' })).status).toBe(
      400,
    );
    // Housekeeping (password changed above) has no staff management.
    const hk = browser(h);
    expect((await hk.login(h.fx.users.housekeepingA.email, NEW_PASSWORD)).status).toBe(200);
    expect((await reset(hk, h.fx.users.deskA.id)).status).toBe(403);
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await reset(ownerB, h.fx.users.deskA.id)).status).toBe(404);
  });

  it('is audited with its reason and never records the password, in the audit log or the logs', async () => {
    const res = await reset(manager, h.fx.users.auditorA.id, 'New phone, forgot the password');
    const secret = res.body.data.temporaryPassword as string;
    const audit = await h.admin.query<{ changes: Record<string, unknown>; reason: string }>(
      `SELECT changes, reason FROM audit_events WHERE action = 'user.password_reset' AND entity_id = $1`,
      [h.fx.users.auditorA.id],
    );
    expect(audit.rows[0]).toMatchObject({ reason: 'New phone, forgot the password' });
    const allAudit = await h.admin.query<{ t: string }>(
      `SELECT changes::text || coalesce(reason, '') AS t FROM audit_events`,
    );
    expect(allAudit.rows.some((r) => r.t.includes(secret))).toBe(false);
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.join('').includes(secret)).toBe(false);
    expect(lines.join('').includes(NEW_PASSWORD)).toBe(false);
  });
});

describe('your sessions', () => {
  it('lists them, ends one or all others, never the current one or someone else’s', async () => {
    const here = await browser(h).loginActive(h.fx.users.managerA1);
    const second = await browser(h).loginActive(h.fx.users.managerA1);
    const third = await browser(h).loginActive(h.fx.users.managerA1);
    const list = (await here.get('/auth/sessions')).body.data as { id: string; current: boolean }[];
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.length).toBeGreaterThanOrEqual(3);
    const current = list.find((s) => s.current)!;
    expect((await here.post(`/auth/sessions/${current.id}/end`)).status).toBe(409);
    const other = list.find((s) => !s.current)!;
    expect((await here.post(`/auth/sessions/${other.id}/end`)).status).toBe(200);
    // Someone else's session is not found.
    const managerSessions = (await manager.get('/auth/sessions')).body.data as { id: string }[];
    expect((await here.post(`/auth/sessions/${managerSessions[0]!.id}/end`)).status).toBe(404);
    const all = await here.post('/auth/sessions/end-others');
    expect(all.status).toBe(200);
    expect((await second.get('/auth/me')).status).toBe(401);
    expect((await third.get('/auth/me')).status).toBe(401);
    expect((await here.get('/auth/me')).status).toBe(200);
  });
});

describe('operators', () => {
  it('change their own password with the current one', async () => {
    const secret = generateTotpSecret();
    const id = (
      await h.admin.query<{ id: string }>(
        `INSERT INTO platform_operators (email, full_name, password_hash, mfa_secret_enc)
         VALUES ('ops@recovery.test', 'Ops', $1, $2) RETURNING id`,
        [await hashPassword(PASSWORD), encryptSecret(secret, MFA_KEY)],
      )
    ).rows[0]!.id;
    const agent = (await import('supertest')).default.agent(h.app.getHttpServer());
    const login = await agent
      .post('/api/v1/platform/auth/login')
      .set('origin', ORIGIN)
      .send({ email: 'ops@recovery.test', password: PASSWORD, code: totp(secret) });
    expect(login.status).toBe(200);
    const csrf = ([] as string[])
      .concat(login.headers['set-cookie'] ?? [])
      .find((c) => c.startsWith('ip_op_csrf='))!
      .split(';')[0]!
      .slice('ip_op_csrf='.length);
    const post = (body: object) =>
      agent.post('/api/v1/platform/auth/password').set('origin', ORIGIN).set('x-csrf-token', csrf).send(body);
    expect((await post({ currentPassword: 'wrong-one-123456', newPassword: NEW_PASSWORD })).status).toBe(400);
    expect((await post({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
    const { rows } = await h.admin.query<{ action: string }>(
      `SELECT action FROM platform_audit_events WHERE operator_id = $1 ORDER BY occurred_at`,
      [id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'platform.login',
      'platform.password_change_failed',
      'platform.password_changed',
    ]);
  });
});
