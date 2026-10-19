import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './bootstrap';
import { loadConfig } from './config';

/**
 * Boots the real application against an unreachable database. Covers everything that happens before
 * (or instead of) a database call: routing, envelopes, headers, validation, CSRF origin checks and
 * safe handling of infrastructure failures.
 */
let app: INestApplication;

beforeAll(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
    WEB_ORIGINS: 'http://localhost:3000',
    COOKIE_SECURE: 'false',
    MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
    LOG_LEVEL: 'silent',
  });
  app = await createApp(config, { logger: false });
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('API shell', () => {
  it('rejects unauthenticated access with the standard envelope and a request id', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
  });

  it('echoes a well-formed incoming request id and replaces a malformed one', async () => {
    const good = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('x-request-id', 'trace-12345678');
    expect(good.headers['x-request-id']).toBe('trace-12345678');
    const bad = await request(app.getHttpServer()).get('/api/v1/auth/me').set('x-request-id', '<script>');
    expect(bad.headers['x-request-id']).not.toBe('<script>');
  });

  it('returns 404 in the envelope for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('sets security headers and hides the framework', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
  });

  it('validates the login body with field-level details', async () => {
    const res = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path).sort()).toEqual(['email', 'password']);
  });

  it('rejects malformed JSON without echoing parser internals', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/SyntaxError|Unexpected/);
  });

  it('rejects state-changing requests from foreign origins before doing any work', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('origin', 'https://evil.example')
      .send({ email: 'a@example.test', password: 'whatever-password' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('turns infrastructure failures into a generic error without leaking details', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('origin', 'http://localhost:3000')
      .send({ email: 'a@example.test', password: 'whatever-password' });
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|postgres|stack/i);
  });

  it('rate-limits sign-in attempts per client', async () => {
    const attempt = () =>
      request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('origin', 'http://localhost:3000')
        .send({ email: 'a@example.test', password: 'whatever-password' });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attempt()).status);
    expect(statuses.at(-1)).toBe(429);
    const limited = await attempt();
    expect(limited.body.error.code).toBe('RATE_LIMITED');
  });

  it('reports the database as unavailable on the health check', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Database unavailable.');
  });
});
