/**
 * Phase 5 slice 5.7 — platform administration (D16). Operators are a separate identity: a tenant session never
 * reaches a platform route and an operator session never reaches a tenant route. Sign-in needs password and code.
 * Suspension stops sign-in and existing sessions. Support access is reason-coded, time-bound and audited in both
 * the platform log and the tenant's own log; without it an operator sees metadata only.
 */
import { hashPassword } from '@innpilot/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/auth/crypto';
import { generateTotpSecret } from '../src/auth/totp';
import { browser, MFA_KEY, ORIGIN, PASSWORD, startHarness, totp, type Harness } from './harness';

let h: Harness;
const operator = { id: '', email: 'ops@platform.test', secret: generateTotpSecret() };

/** An operator console client: its own cookie jar, the operator CSRF cookie echoed in the header. */
class OperatorClient {
  readonly agent: ReturnType<typeof request.agent>;
  csrf = '';
  constructor() {
    this.agent = request.agent(h.app.getHttpServer());
  }
  async login(code: string, password = PASSWORD) {
    const res = await this.agent
      .post('/api/v1/platform/auth/login')
      .set('origin', ORIGIN)
      .send({ email: operator.email, password, code });
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const csrf = cookies.find((c) => c.startsWith('ip_op_csrf='));
    if (csrf) this.csrf = decodeURIComponent(csrf.split(';')[0]!.slice('ip_op_csrf='.length));
    return res;
  }
  get(path: string) {
    return this.agent.get(`/api/v1${path}`);
  }
  send(method: 'post' | 'patch', path: string, body: object = {}, csrf = true) {
    const r = this.agent[method](`/api/v1${path}`).set('origin', ORIGIN);
    return (csrf ? r.set('x-csrf-token', this.csrf) : r).send(body);
  }
}

let ops: OperatorClient;
/** A fresh code for the next sign-in (each 30-second step can be used once). */
async function freshCode(): Promise<string> {
  await h.admin.query('UPDATE platform_operators SET mfa_last_used_step = NULL WHERE id = $1', [operator.id]);
  return totp(operator.secret);
}

beforeAll(async () => {
  h = await startHarness();
  operator.id = (
    await h.admin.query<{ id: string }>(
      `INSERT INTO platform_operators (email, full_name, password_hash, mfa_secret_enc)
       VALUES ($1, 'Ops Person', $2, $3) RETURNING id`,
      [operator.email, await hashPassword(PASSWORD), encryptSecret(operator.secret, MFA_KEY)],
    )
  ).rows[0]!.id;
  ops = new OperatorClient();
  const res = await ops.login(totp(operator.secret));
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
});

afterAll(async () => {
  await h?.close();
});

describe('operator sign-in', () => {
  it('needs the password and a current code, and refuses a code used before', async () => {
    const other = new OperatorClient();
    expect((await other.login('000000')).status).toBe(401);
    expect((await other.login(totp(operator.secret), 'wrong-password-123')).status).toBe(401);
    // The code that signed in the first client cannot be replayed.
    const replay = await other.login(totp(operator.secret));
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('INVALID_CREDENTIALS');
    await h.admin.query('UPDATE platform_operators SET failed_attempts = 0 WHERE id = $1', [operator.id]);
    expect((await other.get('/platform/me')).status).toBe(401);
    expect((await ops.get('/platform/me')).body.data).toMatchObject({
      email: operator.email,
      fullName: 'Ops Person',
    });
  });

  it('keeps tenant and operator sessions apart', async () => {
    const owner = await browser(h).loginActive(h.fx.users.ownerA);
    expect((await owner.get('/platform/tenants')).status).toBe(401);
    expect((await owner.get('/auth/me')).status).toBe(200);
    expect((await ops.get('/auth/me')).status).toBe(401);
    expect((await ops.get(`/properties/${h.fx.propA1}/rooms`)).status).toBe(401);
  });

  it('refuses a change without the operator CSRF token', async () => {
    const res = await ops.send(
      'patch',
      `/platform/tenants/${h.fx.tenantA}`,
      { plan: 'growth', reason: 'Upgrade' },
      false,
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });
});

describe('tenants', () => {
  it('lists hotels with metadata and counts only', async () => {
    const res = await ops.get('/platform/tenants');
    expect(res.status).toBe(200);
    const a = res.body.data.find((t: { id: string }) => t.id === h.fx.tenantA);
    expect(a).toMatchObject({
      slug: 'tenant-a',
      status: 'active',
      plan: 'starter',
      roomBand: 'up_to_20',
      properties: 2,
    });
    expect(a.users).toBeGreaterThan(5);
    expect(Object.keys(a).sort()).toEqual([
      'createdAt',
      'displayName',
      'id',
      'lastSignIn',
      'legalName',
      'overBand',
      'plan',
      'properties',
      'roomBand',
      'rooms',
      'slug',
      'status',
      'users',
    ]);
  });

  it('changes the plan with a reason, recorded on both sides', async () => {
    expect(
      (await ops.send('patch', `/platform/tenants/${h.fx.tenantA}`, { plan: 'growth', reason: 'short' }))
        .status,
    ).toBe(400);
    const res = await ops.send('patch', `/platform/tenants/${h.fx.tenantA}`, {
      plan: 'growth',
      roomBand: 'up_to_50',
      reason: 'Upgraded after the sales call',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ plan: 'growth', roomBand: 'up_to_50' });
    const tenantLog = await h.admin.query<{
      actor_type: string;
      changes: Record<string, unknown>;
      reason: string;
    }>(
      `SELECT actor_type, changes, reason FROM audit_events WHERE tenant_id = $1 AND action = 'platform.tenant_updated'`,
      [h.fx.tenantA],
    );
    expect(tenantLog.rows[0]).toMatchObject({
      actor_type: 'platform',
      reason: 'Upgraded after the sales call',
      changes: { plan: { from: 'starter', to: 'growth' }, operatorEmail: operator.email },
    });
    const detail = (await ops.get(`/platform/tenants/${h.fx.tenantA}`)).body.data;
    expect(detail.log[0]).toMatchObject({ action: 'platform.tenant_updated', operatorName: 'Ops Person' });
  });

  it('suspension stops sign-in and ends existing sessions; reactivation restores them', async () => {
    const desk = await browser(h).loginActive(h.fx.users.deskA);
    expect((await desk.get('/auth/me')).status).toBe(200);
    const res = await ops.send('patch', `/platform/tenants/${h.fx.tenantA}`, {
      status: 'suspended',
      reason: 'Payment overdue for two months',
    });
    expect(res.body.data.status).toBe('suspended');
    expect((await desk.get('/auth/me')).status).toBe(401);
    expect((await browser(h).login(h.fx.users.deskA.email)).status).toBe(403);
    // Another hotel is not affected.
    expect((await (await browser(h).loginActive(h.fx.users.deskB)).get('/auth/me')).status).toBe(200);
    await ops.send('patch', `/platform/tenants/${h.fx.tenantA}`, {
      status: 'active',
      reason: 'Payment received in full',
    });
    expect((await browser(h).login(h.fx.users.deskA.email)).status).toBe(200);
  });

  it('reports an unknown hotel as missing', async () => {
    expect((await ops.get('/platform/tenants/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await ops.get('/platform/tenants/not-a-uuid')).status).toBe(404);
  });
});

describe('support access', () => {
  it('shows nothing inside a hotel without a grant', async () => {
    const res = await ops.get(`/platform/tenants/${h.fx.tenantB}/support`);
    expect(res.status).toBe(403);
  });

  it('needs a reason and one of the allowed durations', async () => {
    const path = `/platform/tenants/${h.fx.tenantB}/access`;
    expect((await ops.send('post', path, { reason: 'help', minutes: 30 })).status).toBe(400);
    expect(
      (await ops.send('post', path, { reason: 'Owner asked for help with roles', minutes: 600 })).status,
    ).toBe(400);
  });

  it('opens time-bound access, audited in the hotel’s own log, with staff and set-up only', async () => {
    const res = await ops.send('post', `/platform/tenants/${h.fx.tenantB}/access`, {
      reason: 'Owner asked for help with staff roles (ticket 42)',
      minutes: 30,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ active: true, operatorName: 'Ops Person' });
    const minutes = (Date.parse(res.body.data.expiresAt) - Date.parse(res.body.data.grantedAt)) / 60_000;
    expect(minutes).toBe(30);

    const view = await ops.get(`/platform/tenants/${h.fx.tenantB}/support`);
    expect(view.status).toBe(200);
    expect(view.body.data.users.map((u: { email: string }) => u.email).sort()).toEqual([
      'desk@b.test',
      'owner@b.test',
    ]);
    expect(view.body.data.properties).toHaveLength(1);
    // Nothing of tenant A, and no guest or money records in the view at all.
    expect(JSON.stringify(view.body.data)).not.toMatch(/@a\.test|guest|folio|payment/i);

    const log = await h.admin.query<{ action: string }>(
      `SELECT action FROM audit_events WHERE tenant_id = $1 AND actor_type = 'platform' ORDER BY occurred_at`,
      [h.fx.tenantB],
    );
    expect(log.rows.map((r) => r.action)).toEqual(['platform.access_granted', 'platform.support_read']);
    // The hotel's owner sees it in their audit log.
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    const audit = (await ownerB.get('/audit-events?limit=50')).body.data;
    expect(audit.some((e: { action: string }) => e.action === 'platform.access_granted')).toBe(true);
  });

  it('ends on request and on expiry', async () => {
    expect((await ops.send('post', `/platform/tenants/${h.fx.tenantB}/access/end`)).status).toBe(200);
    expect((await ops.get(`/platform/tenants/${h.fx.tenantB}/support`)).status).toBe(403);
    expect((await ops.send('post', `/platform/tenants/${h.fx.tenantB}/access/end`)).status).toBe(409);
    // A grant whose time is up gives nothing.
    await h.admin.query(
      `INSERT INTO tenant_access_grants (tenant_id, operator_id, reason, granted_at, expires_at)
       VALUES ($1, $2, 'Expired grant for the test', now() - interval '2 hours', now() - interval '1 hour')`,
      [h.fx.tenantB, operator.id],
    );
    expect((await ops.get(`/platform/tenants/${h.fx.tenantB}/support`)).status).toBe(403);
    const detail = (await ops.get(`/platform/tenants/${h.fx.tenantB}`)).body.data;
    expect(detail.activeGrant).toBeNull();
    expect(detail.grants.every((g: { active: boolean }) => !g.active)).toBe(true);
  });

  it('cannot be stretched or erased in the database', async () => {
    const [grant] = (
      await h.admin.query<{ id: string }>(
        `SELECT id FROM tenant_access_grants WHERE tenant_id = $1 LIMIT 1`,
        [h.fx.tenantB],
      )
    ).rows;
    await expect(
      h.admin.query(`UPDATE tenant_access_grants SET expires_at = now() + interval '1 day' WHERE id = $1`, [
        grant!.id,
      ]),
    ).rejects.toThrow(/can only be ended/);
    await expect(
      h.admin.query(`DELETE FROM tenant_access_grants WHERE id = $1`, [grant!.id]),
    ).rejects.toThrow();
    await expect(
      h.admin.query(
        `INSERT INTO tenant_access_grants (tenant_id, operator_id, reason, expires_at)
         VALUES ($1, $2, 'Far too long a grant', now() + interval '5 hours')`,
        [h.fx.tenantB, operator.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(h.admin.query(`DELETE FROM platform_audit_events`)).rejects.toThrow();
  });
});

describe('sign-out', () => {
  it('ends the operator session', async () => {
    const other = new OperatorClient();
    expect((await other.login(await freshCode())).status).toBe(200);
    expect((await other.send('post', '/platform/auth/logout')).status).toBe(200);
    expect((await other.get('/platform/tenants')).status).toBe(401);
    expect((await ops.get('/platform/tenants')).status).toBe(200);
  });
});
