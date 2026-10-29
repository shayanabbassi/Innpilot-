import { type INestApplication } from '@nestjs/common';
import { CSRF_HEADER, type RoleCode } from '@innpilot/contracts';
import { createTestDatabase, hashPassword, type TestDatabase } from '@innpilot/db';
import { Client } from 'pg';
import type { DestinationStream } from 'pino';
import request from 'supertest';
import { encryptSecret } from '../src/auth/crypto';
import { base32Decode, generateTotpSecret, hotp, timeStep } from '../src/auth/totp';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'correct-horse-battery';
export const MFA_KEY = Buffer.alloc(32, 9);
export const PII_KEY = Buffer.alloc(32, 5);

export interface FixtureUser {
  id: string;
  email: string;
  /** Present when MFA was pre-enrolled by the fixture. */
  mfaSecret?: string;
}

export interface Fixture {
  tenantA: string;
  tenantB: string;
  propA1: string;
  propA2: string;
  propB1: string;
  users: Record<
    | 'ownerA'
    | 'ownerA2'
    | 'managerA'
    | 'managerA1'
    | 'deskA'
    | 'accountantA'
    | 'housekeepingA'
    | 'auditorA'
    | 'cashierA'
    | 'ownerB'
    | 'deskB',
    FixtureUser
  >;
}

export interface Harness {
  app: INestApplication;
  db: TestDatabase;
  /** Owner connection (bypasses RLS) for fixtures and direct assertions. */
  admin: Client;
  fx: Fixture;
  close(): Promise<void>;
}

async function insert<T extends Record<string, unknown>>(
  c: Client,
  text: string,
  values: unknown[],
): Promise<T> {
  const { rows } = await c.query<T>(text, values);
  return rows[0]!;
}

async function buildFixture(admin: Client): Promise<Fixture> {
  const hash = await hashPassword(PASSWORD);
  const tenant = async (slug: string) =>
    (
      await insert<{ id: string }>(
        admin,
        `INSERT INTO tenants (slug, legal_name, display_name, status)
      VALUES ($1::text, $1::text, $1::text, 'active') RETURNING id`,
        [slug],
      )
    ).id;
  const property = async (tenantId: string, name: string) =>
    (
      await insert<{ id: string }>(
        admin,
        `INSERT INTO properties (tenant_id, name, business_date)
      VALUES ($1, $2, '2026-10-19') RETURNING id`,
        [tenantId, name],
      )
    ).id;
  const user = async (
    tenantId: string,
    email: string,
    role: RoleCode,
    propertyId: string | null = null,
    withMfa = false,
  ): Promise<FixtureUser> => {
    const mfaSecret = withMfa ? generateTotpSecret() : undefined;
    const { id } = await insert<{ id: string }>(
      admin,
      `INSERT INTO users (tenant_id, email, full_name, password_hash, mfa_secret_enc, mfa_enabled_at)
       VALUES ($1, $2::text, $2::text, $3, $4, $5) RETURNING id`,
      [
        tenantId,
        email,
        hash,
        mfaSecret ? encryptSecret(mfaSecret, MFA_KEY) : null,
        mfaSecret ? new Date() : null,
      ],
    );
    await admin.query(
      `INSERT INTO user_roles (tenant_id, user_id, property_id, role_code) VALUES ($1, $2, $3, $4)`,
      [tenantId, id, propertyId, role],
    );
    return { id, email, mfaSecret };
  };

  const tenantA = await tenant('tenant-a');
  const tenantB = await tenant('tenant-b');
  const propA1 = await property(tenantA, 'A One');
  const propA2 = await property(tenantA, 'A Two');
  const propB1 = await property(tenantB, 'B One');
  return {
    tenantA,
    tenantB,
    propA1,
    propA2,
    propB1,
    users: {
      ownerA: await user(tenantA, 'owner@a.test', 'tenant_owner', null, true),
      ownerA2: await user(tenantA, 'owner2@a.test', 'tenant_owner', null, true),
      managerA: await user(tenantA, 'manager@a.test', 'hotel_manager', null, true),
      managerA1: await user(tenantA, 'manager1@a.test', 'hotel_manager', propA1, true),
      deskA: await user(tenantA, 'desk@a.test', 'front_desk'),
      accountantA: await user(tenantA, 'accountant@a.test', 'accountant', null, true),
      housekeepingA: await user(tenantA, 'hk@a.test', 'housekeeping'),
      auditorA: await user(tenantA, 'auditor@a.test', 'read_only_auditor'),
      cashierA: await user(tenantA, 'cashier@a.test', 'cashier'),
      ownerB: await user(tenantB, 'owner@b.test', 'tenant_owner', null, true),
      deskB: await user(tenantB, 'desk@b.test', 'front_desk'),
    },
  };
}

export interface HarnessOptions {
  /** Turns on the application logger at trace level, writing to this stream. */
  logStream?: DestinationStream;
  /** Extra configuration for this run, e.g. a feature switch. */
  env?: Record<string, string>;
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDatabase();
  const admin = new Client({ connectionString: db.adminUrl });
  await admin.connect();
  const fx = await buildFixture(admin);
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: db.appUrl,
    WEB_ORIGINS: ORIGIN,
    COOKIE_SECURE: 'false',
    MFA_ENCRYPTION_KEY: MFA_KEY.toString('base64url'),
    PII_ENCRYPTION_KEY: PII_KEY.toString('base64url'),
    LOG_LEVEL: options.logStream ? 'trace' : 'silent',
    RATE_LIMIT_ENABLED: 'false',
    // Jobs are run by the tests themselves, not by a timer.
    JOBS_POLL_SECONDS: '0',
    // The local storage container (pnpm db:up), with its own bucket for tests.
    STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:7070',
    STORAGE_BUCKET: 'innpilot-test',
    STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY,
    ...options.env,
  });
  const app = await createApp(
    config,
    options.logStream ? { logStream: options.logStream } : { logger: false },
  );
  await app.init();
  return {
    app,
    db,
    admin,
    fx,
    async close() {
      await app.close();
      await admin.end();
      await db.drop();
    },
  };
}

/** A TOTP code for the current time step. */
export function totp(secret: string, offsetSteps = 0): string {
  return hotp(base32Decode(secret), timeStep(Date.now()) + offsetSteps);
}

/** A browser-like client: keeps cookies and sends the Origin and CSRF headers like the web app does. */
export class BrowserClient {
  readonly agent: ReturnType<typeof request.agent>;
  csrf = '';

  constructor(private readonly h: Harness) {
    this.agent = request.agent(h.app.getHttpServer());
  }

  async login(email: string, password = PASSWORD) {
    const res = await this.agent.post('/api/v1/auth/login').set('origin', ORIGIN).send({ email, password });
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const csrf = cookies.find((c) => c.startsWith('ip_csrf='));
    if (csrf) this.csrf = decodeURIComponent(csrf.split(';')[0]!.slice('ip_csrf='.length));
    return res;
  }

  /** Logs in and completes MFA if the account has a fixture secret. Clears the replay marker for test speed. */
  async loginActive(user: FixtureUser) {
    const res = await this.login(user.email);
    if (res.status !== 200) throw new Error(`login failed for ${user.email}: ${JSON.stringify(res.body)}`);
    if (res.body.data.sessionState === 'mfa_verify') {
      if (!user.mfaSecret) throw new Error(`${user.email} needs MFA but has no fixture secret`);
      const verify = await this.post('/auth/mfa/verify', { code: totp(user.mfaSecret) });
      if (verify.status !== 200) throw new Error(`mfa verify failed: ${JSON.stringify(verify.body)}`);
      await this.h.admin.query('UPDATE users SET mfa_last_used_step = NULL WHERE id = $1', [user.id]);
    }
    return this;
  }

  get(path: string) {
    return this.agent.get(`/api/v1${path}`);
  }

  post(path: string, body: unknown = {}) {
    return this.agent
      .post(`/api/v1${path}`)
      .set('origin', ORIGIN)
      .set(CSRF_HEADER, this.csrf)
      .send(body as object);
  }

  put(path: string, body: unknown) {
    return this.agent
      .put(`/api/v1${path}`)
      .set('origin', ORIGIN)
      .set(CSRF_HEADER, this.csrf)
      .send(body as object);
  }

  /** Sends a file as the raw request body, the way the web app uploads attachments. */
  upload(path: string, file: Buffer, contentType = 'application/octet-stream') {
    return this.agent
      .post(`/api/v1${path}`)
      .set('origin', ORIGIN)
      .set(CSRF_HEADER, this.csrf)
      .set('content-type', contentType)
      .send(file);
  }

  delete(path: string) {
    return this.agent.delete(`/api/v1${path}`).set('origin', ORIGIN).set(CSRF_HEADER, this.csrf);
  }

  patch(path: string, body: unknown) {
    return this.agent
      .patch(`/api/v1${path}`)
      .set('origin', ORIGIN)
      .set(CSRF_HEADER, this.csrf)
      .send(body as object);
  }
}

export const browser = (h: Harness) => new BrowserClient(h);
