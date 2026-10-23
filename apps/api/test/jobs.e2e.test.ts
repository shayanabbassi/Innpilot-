/**
 * Phase 6 slice 6.3 — background jobs and exports prepared in the background.
 *
 * Jobs carry their tenant and run inside it as the person who asked, with that person's access at run time; a job
 * never reads another tenant; retries (after a crash or a storage outage) replace the job's one file and audit
 * record instead of adding more; failures the person can act on fail at once with a readable message; only the
 * person who asked can see the job and download its file, through a five-minute link, until the file expires and
 * the clean-up job deletes it.
 */
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { EXPORT_JOBS_PER_USER } from '@innpilot/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { JobsService } from '../src/jobs/jobs.service';
import { S3Client } from '../src/storage/s3';
import { browser, MFA_KEY, ORIGIN, PII_KEY, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let jobs: JobsService;
let acc: BrowserClient;
let ownerA: BrowserClient;
let ownerB: BrowserClient;
let desk: BrowserClient;

const OCT = { from: '2026-10-01', to: '2026-10-31' };
const s3 = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:7070',
  region: 'us-east-1',
  bucket: 'innpilot-test',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
});

const withKey = (c: BrowserClient, path: string, body: object = {}) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', randomUUID())
    .send(body);

/** Posts a revenue journal so each tenant's report has a figure only it could contain. */
async function postRevenue(c: BrowserClient, propertyId: string, amount: string) {
  const account: Record<string, string> = {};
  for (const a of (await c.get('/finance/accounts')).body.data) account[a.code] = a.id;
  const draft = await withKey(c, '/finance/journal-entries/draft', {
    propertyId,
    narration: 'Revenue for the background export test',
    accountingDate: '2026-10-10',
    lines: [
      { accountId: account['1100'], debit: amount },
      { accountId: account['4000'], credit: amount },
    ],
  });
  if (draft.status !== 201) throw new Error(JSON.stringify(draft.body));
  const posted = await withKey(c, `/finance/journal-entries/${draft.body.data.id}/post`);
  if (posted.status !== 200) throw new Error(JSON.stringify(posted.body));
}

const queue = (c: BrowserClient, query: Record<string, string>, report = 'profit-loss', format = 'csv') =>
  c.post('/exports', { report, format, query });

/** Downloads a file response as raw bytes. */
function fetchFile(c: BrowserClient, url: string) {
  return c.agent
    .get(url)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

async function downloadJob(c: BrowserClient, jobId: string): Promise<string> {
  const link = await c.post(`/exports/${jobId}/link`);
  if (link.status !== 200) throw new Error(`${link.status} ${JSON.stringify(link.body)}`);
  const res = await fetchFile(c, link.body.data.url);
  if (res.status !== 200) throw new Error(`download ${res.status}`);
  return (res.body as Buffer).toString('utf8');
}

const job = async (id: string) =>
  (await h.admin.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0] as {
    status: string;
    attempts: number;
    last_error: string | null;
    run_after: Date;
  };
const filesOf = async (id: string) =>
  (await h.admin.query('SELECT * FROM export_files WHERE job_id = $1', [id])).rows as {
    id: string;
    object_key: string;
    removed_at: Date | null;
  }[];
const exportedAudits = async (jobId: string) =>
  (
    await h.admin.query(
      `SELECT changes FROM audit_events WHERE action = 'report.exported' AND changes->>'jobId' = $1`,
      [jobId],
    )
  ).rows;

beforeAll(async () => {
  h = await startHarness();
  jobs = h.app.get(JobsService);
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  ownerA = await browser(h).loginActive(h.fx.users.ownerA);
  ownerB = await browser(h).loginActive(h.fx.users.ownerB);
  desk = await browser(h).loginActive(h.fx.users.deskA);
  await postRevenue(acc, h.fx.propA1, '12500.50');
  await postRevenue(ownerB, h.fx.propB1, '777.77');
});

afterAll(async () => {
  await h?.close();
});

describe('queueing a background export', () => {
  it('checks the filters and export.run before anything is queued', async () => {
    expect((await queue(acc, { from: '2026-10-01' })).status).toBe(400);
    expect((await acc.post('/exports', { report: 'nope', format: 'csv', query: {} })).status).toBe(400);
    expect((await queue(desk, { ...OCT, propertyId: h.fx.propA1 })).status).toBe(403);
    const m1 = await browser(h).loginActive(h.fx.users.managerA1);
    expect((await queue(m1, { ...OCT, propertyId: h.fx.propA2 })).status).toBe(404);
    expect((await queue(m1, OCT, 'user-activity')).status).toBe(403);
    expect((await queue(ownerB, { ...OCT, propertyId: h.fx.propA1 })).status).toBe(404);
    const { rows } = await h.admin.query('SELECT count(*)::int AS n FROM jobs');
    expect(rows[0].n).toBe(0);
  });

  it('queues, audits, and shows the job to the person who asked', async () => {
    const res = await queue(acc, { ...OCT, propertyId: h.fx.propA1 });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      report: 'profit-loss',
      format: 'csv',
      status: 'queued',
      file: null,
    });
    const { rows } = await h.admin.query(
      `SELECT entity_id, changes FROM audit_events WHERE action = 'report.export_queued'`,
    );
    expect(rows).toEqual([expect.objectContaining({ entity_id: res.body.data.id })]);
    expect((await acc.get('/exports')).body.data.map((j: { id: string }) => j.id)).toEqual([
      res.body.data.id,
    ]);
    expect((await ownerA.get('/exports')).body.data).toEqual([]);
    expect((await ownerB.get('/exports')).body.data).toEqual([]);
  });
});

describe('running background exports', () => {
  let jobA: string;
  let jobB: string;

  it('runs each job inside its own tenant, as the person who asked', async () => {
    jobA = (await acc.get('/exports')).body.data[0].id;
    jobB = (await queue(ownerB, { ...OCT, propertyId: h.fx.propB1 })).body.data.id;
    expect(await jobs.runDue()).toBe(2);
    expect(await jobs.runDue()).toBe(0);

    const [a] = (await acc.get('/exports')).body.data;
    expect(a).toMatchObject({ id: jobA, status: 'succeeded', error: null });
    expect(a.file.rowCount).toBeGreaterThan(0);
    expect(a.file.expired).toBe(false);
    const hours = (Date.parse(a.file.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    const csvA = await downloadJob(acc, jobA);
    const csvB = await downloadJob(ownerB, jobB);
    expect(csvA).toMatch(/12,?500\.50/);
    expect(csvA).not.toMatch(/777\.77/);
    expect(csvB).toMatch(/777\.77/);
    expect(csvB).not.toMatch(/12,?500\.50/);
  });

  it('stores the file encrypted under the job key and audits the export once', async () => {
    const [file] = await filesOf(jobA);
    expect(file!.object_key).toBe(`t/${h.fx.tenantA}/exports/${jobA}`);
    const stored = await s3.get(file!.object_key);
    expect(stored!.toString('latin1')).not.toMatch(/Profit|12,?500/);
    expect(await exportedAudits(jobA)).toEqual([
      {
        changes: expect.objectContaining({
          report: 'profit-loss',
          background: true,
          rows: expect.any(Number),
        }),
      },
    ]);
  });

  it('downloads only for the person who asked, as a saved file', async () => {
    const link = (await acc.post(`/exports/${jobA}/link`)).body.data;
    const res = await fetchFile(acc, link.url);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="innpilot_profit-loss_/);
    expect(res.headers['cache-control']).toBe('private, no-store');
    // Same tenant, allowed to export, but not the person who asked.
    expect((await ownerA.post(`/exports/${jobA}/link`)).status).toBe(404);
    expect((await fetchFile(ownerA, link.url)).status).toBe(404);
    expect((await ownerB.post(`/exports/${jobA}/link`)).status).toBe(404);
    expect((await fetchFile(ownerB, link.url)).status).toBe(404);
    expect((await acc.post(`/exports/${randomUUID()}/link`)).status).toBe(404);
  });

  it('replaces its own file when run again after stopping before it recorded success', async () => {
    // As if the worker stopped after storing the file: the job is still "running" and its lease has lapsed.
    await h.admin.query(
      `UPDATE jobs SET status = 'running', finished_at = NULL, locked_until = now() - interval '1 second'
       WHERE id = $1`,
      [jobA],
    );
    expect(await jobs.runDue()).toBe(1);
    expect(await job(jobA)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await filesOf(jobA)).toHaveLength(1);
    expect(await exportedAudits(jobA)).toHaveLength(1);
    // The row was updated with the new file's encryption details, so it still opens.
    expect(await downloadJob(acc, jobA)).toMatch(/12,?500\.50/);
  });

  it('fails a job whose worker stopped once it has no tries left', async () => {
    const id = (await queue(ownerA, { ...OCT, propertyId: h.fx.propA1 })).body.data.id;
    await h.admin.query(
      `UPDATE jobs SET status = 'running', attempts = max_attempts, locked_until = now() - interval '1 second'
       WHERE id = $1`,
      [id],
    );
    expect(await jobs.runDue()).toBe(0);
    const row = await job(id);
    expect(row.status).toBe('failed');
    expect(row.last_error).toMatch(/stopped before finishing/);
    expect((await ownerA.get('/exports')).body.data[0]).toMatchObject({ id, status: 'failed', file: null });
  });

  it(`allows ${EXPORT_JOBS_PER_USER} exports in preparation per person`, async () => {
    const ids: string[] = [];
    for (let i = 0; i < EXPORT_JOBS_PER_USER; i++) {
      const res = await ownerA.post('/exports', {
        report: 'balance-sheet',
        format: 'xlsx',
        query: { asOf: '2026-10-19', propertyId: h.fx.propA1 },
      });
      expect(res.status).toBe(201);
      ids.push(res.body.data.id);
    }
    const over = await queue(ownerA, { ...OCT, propertyId: h.fx.propA1 });
    expect(over.status).toBe(409);
    expect(over.body.error.message).toMatch(/already have 3 exports/);
    expect(await jobs.runDue()).toBe(EXPORT_JOBS_PER_USER);
    for (const id of ids) expect((await job(id)).status).toBe('succeeded');
    expect((await queue(ownerA, { ...OCT, propertyId: h.fx.propA1 })).status).toBe(201);
    await jobs.runDue();
  });
});

describe('several workers', () => {
  it('never run the same job twice at once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < EXPORT_JOBS_PER_USER; i++) {
      ids.push((await queue(acc, { ...OCT, propertyId: h.fx.propA1 }, 'tax-summary')).body.data.id);
    }
    const ran = await Promise.all([jobs.runDue(), jobs.runDue(), jobs.runDue()]);
    expect(ran.reduce((a, b) => a + b, 0)).toBe(EXPORT_JOBS_PER_USER);
    for (const id of ids) expect(await job(id)).toMatchObject({ status: 'succeeded', attempts: 1 });
  });
});

describe('storage outage', () => {
  let broken: INestApplication;

  beforeAll(async () => {
    broken = await createApp(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: h.db.appUrl,
        WEB_ORIGINS: ORIGIN,
        COOKIE_SECURE: 'false',
        MFA_ENCRYPTION_KEY: MFA_KEY.toString('base64url'),
        PII_ENCRYPTION_KEY: PII_KEY.toString('base64url'),
        LOG_LEVEL: 'silent',
        RATE_LIMIT_ENABLED: 'false',
        JOBS_POLL_SECONDS: '0',
        STORAGE_ENDPOINT: 'http://127.0.0.1:1',
        STORAGE_BUCKET: 'innpilot-test',
        STORAGE_ACCESS_KEY_ID: 'nobody',
        STORAGE_SECRET_ACCESS_KEY: 'nothing-here',
      }),
      { logger: false },
    );
    await broken.init();
  });

  afterAll(async () => {
    await broken?.close();
  });

  it('waits and tries again, then succeeds with one file', async () => {
    const id = (await queue(acc, { ...OCT, propertyId: h.fx.propA1 }, 'cashbook')).body.data.id;
    expect(await broken.get(JobsService).runDue()).toBe(1);
    const waiting = await job(id);
    expect(waiting).toMatchObject({ status: 'queued', attempts: 1, last_error: 'Waiting to try again.' });
    expect(waiting.run_after.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(await filesOf(id)).toHaveLength(0);
    // Not due yet, so a healthy worker leaves it alone…
    expect(await jobs.runDue()).toBe(0);
    // …until its wait is over.
    await h.admin.query('UPDATE jobs SET run_after = now() WHERE id = $1', [id]);
    expect(await jobs.runDue()).toBe(1);
    expect(await job(id)).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await filesOf(id)).toHaveLength(1);
    expect(await exportedAudits(id)).toHaveLength(1);
  });
});

describe('expiry and clean-up', () => {
  it('stops serving an expired export and deletes it on the next clean-up', async () => {
    const id = (await queue(acc, { ...OCT, propertyId: h.fx.propA1 }, 'revenue')).body.data.id;
    await jobs.runDue();
    const link = (await acc.post(`/exports/${id}/link`)).body.data;
    const [file] = await filesOf(id);
    await h.admin.query(
      `UPDATE export_files SET created_at = now() - interval '2 days', expires_at = now() - interval '1 minute'
       WHERE job_id = $1`,
      [id],
    );
    const again = await acc.post(`/exports/${id}/link`);
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('LINK_EXPIRED');
    expect((await fetchFile(acc, link.url)).status).toBe(404);
    expect((await acc.get('/exports')).body.data.find((j: { id: string }) => j.id === id).file.expired).toBe(
      true,
    );

    await jobs.runPeriodic();
    const [after] = await filesOf(id);
    expect(after!.removed_at).not.toBeNull();
    expect(await s3.get(file!.object_key)).toBeNull();
    // Files that have not expired are left alone.
    const live = await h.admin.query(
      `SELECT count(*)::int AS n FROM export_files WHERE removed_at IS NULL AND expires_at > now()`,
    );
    expect(live.rows[0].n).toBeGreaterThan(0);
  });
});

describe('access at run time', () => {
  it('fails the job, with a message, when the permission was taken away after queueing', async () => {
    const m1 = await browser(h).loginActive(h.fx.users.managerA1);
    const id = (await queue(m1, { ...OCT, propertyId: h.fx.propA1 })).body.data.id;
    await h.admin.query('DELETE FROM user_roles WHERE user_id = $1', [h.fx.users.managerA1.id]);
    expect(await jobs.runDue()).toBe(1);
    const row = await job(id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/permission/i);
    expect(await filesOf(id)).toHaveLength(0);
  });
});
