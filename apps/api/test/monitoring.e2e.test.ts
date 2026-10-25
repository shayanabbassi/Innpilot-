/**
 * Phase 6 slice 6.6 — monitoring. Liveness and readiness (a failing dependency makes readiness fail); metrics on
 * their own port, labelled by route templates and error codes only, so no guest or user data reaches them; the
 * signals the alerts watch (failed sign-ins, job failures, backups, readiness); scrubbed error reports delivered to
 * the configured webhook without request content.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { JobsService } from '../src/jobs/jobs.service';
import { ErrorReporter } from '../src/monitoring/error-reporter.service';
import { startMetricsServer } from '../src/monitoring/metrics-server';
import { MetricsService } from '../src/monitoring/metrics.service';
import { browser, MFA_KEY, ORIGIN, PII_KEY, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let desk: BrowserClient;
let metrics: MetricsService;
const CNIC = '35202-7654321-9'; // fictional

const baseEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DATABASE_URL: h.db.appUrl,
  WEB_ORIGINS: ORIGIN,
  COOKIE_SECURE: 'false',
  MFA_ENCRYPTION_KEY: MFA_KEY.toString('base64url'),
  PII_ENCRYPTION_KEY: PII_KEY.toString('base64url'),
  LOG_LEVEL: 'silent',
  RATE_LIMIT_ENABLED: 'false',
  JOBS_POLL_SECONDS: '0',
  STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:7070',
  STORAGE_BUCKET: 'innpilot-test',
  STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID,
  STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY,
});

beforeAll(async () => {
  h = await startHarness();
  metrics = h.app.get(MetricsService);
  desk = await browser(h).loginActive(h.fx.users.deskA);
});

afterAll(async () => {
  await h?.close();
});

describe('health', () => {
  it('answers liveness without touching dependencies, and readiness with each check', async () => {
    const live = await request(h.app.getHttpServer()).get('/api/v1/health/live');
    expect(live.status).toBe(200);
    const ready = await request(h.app.getHttpServer()).get('/api/v1/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.data).toEqual({
      status: 'ok',
      checks: { database: 'ok', storage: 'ok', migrations: 'ok' },
    });
  });

  it('fails readiness, naming the dependency, when storage is down', async () => {
    const broken = await createApp(
      loadConfig({
        ...baseEnv(),
        STORAGE_ENDPOINT: 'http://127.0.0.1:1',
        STORAGE_ACCESS_KEY_ID: 'nobody',
        STORAGE_SECRET_ACCESS_KEY: 'nothing-here',
      }),
      { logger: false },
    );
    await broken.init();
    try {
      const ready = await request(broken.getHttpServer()).get('/api/v1/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.body.error).toMatchObject({ code: 'NOT_READY', message: 'Not ready: storage.' });
      expect((await request(broken.getHttpServer()).get('/api/v1/health/live')).status).toBe(200);
      expect(await broken.get(MetricsService).render()).toContain('innpilot_ready{dependency="storage"} 0');
    } finally {
      await broken.close();
    }
  });
});

describe('metrics', () => {
  it('are served on their own port, and nowhere through the API', async () => {
    const server = await startMetricsServer(metrics, 0, '127.0.0.1');
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
      expect(await res.text()).toContain('innpilot_ready{dependency="database"} 1');
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    } finally {
      server.close();
    }
    expect((await request(h.app.getHttpServer()).get('/api/v1/metrics')).status).toBe(404);
  });

  it('label requests by route template, never by ids, names or identity numbers', async () => {
    const created = await desk.post('/guests', {
      fullName: 'Metrics Check Guest',
      phone: '0300 7654321',
      document: { documentType: 'cnic', issuingCountry: 'PK', number: CNIC },
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    await desk.get(`/guests/${id}`);
    await desk.get(`/guests?search=${encodeURIComponent('Metrics Check')}`);
    await desk.get(`/guests?search=${CNIC.replace(/-/g, '')}`);
    const text = await metrics.render();
    expect(text).toMatch(
      /innpilot_http_requests_total\{method="GET",route="\/api\/v1\/guests\/:id",status="200"\} \d+/,
    );
    expect(text).toMatch(
      /innpilot_http_request_duration_seconds_bucket\{method="POST",route="\/api\/v1\/guests",le="0.5"\}/,
    );
    for (const secret of [id, 'Metrics Check', CNIC, CNIC.replace(/-/g, ''), '7654321', 'desk@a.test']) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('count failed sign-ins by error code, for the spike alert', async () => {
    for (let i = 0; i < 3; i++) await browser(h).login('nobody@a.test', 'wrong-password-123');
    const text = await metrics.render();
    const n = Number(/innpilot_errors_total\{code="INVALID_CREDENTIALS"\} (\d+)/.exec(text)?.[1]);
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it('report the queue: a failed job is counted and shows in the failed gauge', async () => {
    await h.admin.query(
      `INSERT INTO jobs (tenant_id, kind, payload, created_by) VALUES ($1, 'report_export', $2, $3)`,
      [h.fx.tenantA, JSON.stringify({ report: 'nope', format: 'csv', query: {} }), h.fx.users.ownerA.id],
    );
    expect(await h.app.get(JobsService).runDue()).toBe(1);
    const text = await metrics.render();
    expect(text).toContain('innpilot_job_runs_total{kind="report_export",outcome="refused"} 1');
    expect(text).toContain('innpilot_jobs{state="failed_24h"} 1');
    expect(text).toContain('innpilot_jobs_oldest_queued_seconds 0');
  });

  it('report backups: last success, and a failed last attempt', async () => {
    expect(await metrics.render()).not.toContain('innpilot_backup_last_run_ok');
    const ok = new Date(Date.now() - 3 * 3600_000);
    await h.admin.query(
      `INSERT INTO backup_runs (started_at, finished_at, ok, object_key, bytes, duration_ms)
       VALUES ($1, $1, true, 'daily/x.ipbk', 100, 1000)`,
      [ok],
    );
    let text = await metrics.render();
    expect(text).toContain(
      `innpilot_backup_last_success_timestamp_seconds ${Math.floor(ok.getTime() / 1000)}`,
    );
    expect(text).toContain('innpilot_backup_last_run_ok 1');
    await h.admin.query(
      `INSERT INTO backup_runs (started_at, ok, duration_ms, error) VALUES (now(), false, 10, 'pg_dump exited with 1')`,
    );
    text = await metrics.render();
    expect(text).toContain('innpilot_backup_last_run_ok 0');
    expect(text).toContain(
      `innpilot_backup_last_success_timestamp_seconds ${Math.floor(ok.getTime() / 1000)}`,
    );
  });

  it('report database pool use', async () => {
    expect(await metrics.render()).toMatch(/innpilot_db_pool_connections\{state="max"\} 10/);
  });
});

describe('error reports', () => {
  let hook: Server;
  let url: string;
  const received: Record<string, unknown>[] = [];

  beforeAll(async () => {
    hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(JSON.parse(body) as Record<string, unknown>);
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  });

  afterAll(() => {
    hook.close();
  });

  const waitFor = async (n: number) => {
    for (let i = 0; i < 50 && received.length < n; i++) await new Promise((r) => setTimeout(r, 50));
  };

  it('sends unexpected errors to the webhook, scrubbed and without request content', async () => {
    // An API whose database is unreachable: sign-in fails with an unexpected error.
    const app: INestApplication = await createApp(
      loadConfig({
        ...baseEnv(),
        DATABASE_URL: 'postgres://nobody:nothing@127.0.0.1:1/none',
        ERROR_WEBHOOK_URL: url,
      }),
      { logger: false },
    );
    await app.init();
    try {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('origin', ORIGIN)
        .send({ email: 'guest.person@example.pk', password: 'a-secret-password-1' });
      expect(res.status).toBe(500);
      await waitFor(1);
      const report = received.at(-1)!;
      expect(report).toMatchObject({
        event: 'error',
        service: 'innpilot-api',
        where: { method: 'POST', route: '/api/v1/auth/login', requestId: res.body.meta.requestId },
      });
      const text = JSON.stringify(report);
      expect(text).not.toMatch(/guest\.person|example\.pk|a-secret-password|nothing@/);
    } finally {
      await app.close();
    }
  });

  it('scrubs identity numbers and contact details from messages and stacks', async () => {
    const reporter = new ErrorReporter(loadConfig({ ...baseEnv(), ERROR_WEBHOOK_URL: url }));
    const before = received.length;
    reporter.report(new Error(`Guest ${CNIC} (ali@example.pk, +92 300 1234567) could not be saved`), {
      requestId: 'r-1',
    });
    await waitFor(before + 1);
    const text = JSON.stringify(received.at(-1));
    expect(text).toContain('Guest [id-number] ([email], [number]) could not be saved');
    expect(text).not.toMatch(/35202|7654321|ali@|1234567/);
  });
});
