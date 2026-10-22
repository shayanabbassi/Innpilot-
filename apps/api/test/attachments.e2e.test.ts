/**
 * Phase 6 slice 6.2 — attachments in private object storage (SEC-003, D12).
 *
 * Receipts on expenses and identity scans on guests: only PDF, JPEG and PNG recognised from content, at most 5 MB,
 * PDFs with scripts refused; stored encrypted under keys that hold no names or guest data; downloads only through
 * a link bound to one user, one tenant and five minutes, re-checked against permissions; identity scans need a
 * reason and every download is audited; files stay with submitted or posted expenses. Runs against the real local
 * storage container.
 */
import { randomUUID } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/bootstrap';
import { loadConfig } from '../src/config';
import { S3Client } from '../src/storage/s3';
import { browser, MFA_KEY, ORIGIN, PII_KEY, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let acc: BrowserClient;
let cashier: BrowserClient;
let desk: BrowserClient;
let auditor: BrowserClient;
let housekeeping: BrowserClient;
let ownerB: BrowserClient;
let base: string;
const cash: Record<string, string> = {};
const account: Record<string, string> = {};

const s3 = new S3Client({
  endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:7070',
  region: 'us-east-1',
  bucket: 'innpilot-test',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
});

/** A small but real-looking PDF; `tag` makes each one a different file. */
const pdf = (tag = randomUUID()) =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n% ${tag}\n%%EOF\n`);
const jpeg = (tag = randomUUID()) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
    Buffer.from(tag),
    Buffer.from([0xff, 0xd9]),
  ]);

const withKey = (c: BrowserClient, path: string, body: object = {}) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', randomUUID())
    .send(body);

async function cashExpense(c: BrowserClient, description = 'Printer paper') {
  const res = await withKey(c, `${base}/expenses`, {
    kind: 'cash',
    expenseDate: '2026-10-19',
    description,
    cashAccountId: cash['Front desk cash'],
    lines: [{ accountId: account['6900'], amount: '400' }],
  });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.data.id as string;
}

const upload = (c: BrowserClient, expenseId: string, file: Buffer, fileName = 'receipt.pdf', type?: string) =>
  c.upload(`${base}/expenses/${expenseId}/attachments?fileName=${encodeURIComponent(fileName)}`, file, type);

async function rowsFor(column: 'expense_id' | 'guest_id', id: string) {
  const { rows } = await h.admin.query<{
    id: string;
    object_key: string;
    file_name: string;
    content_type: string;
    size_bytes: number;
    removed_at: Date | null;
  }>(`SELECT * FROM attachments WHERE ${column} = $1 ORDER BY created_at`, [id]);
  return rows;
}

async function audits(action: string, entityId: string) {
  const { rows } = await h.admin.query<{ reason: string | null; changes: Record<string, unknown> }>(
    'SELECT reason, changes FROM audit_events WHERE action = $1 AND entity_id = $2 ORDER BY occurred_at',
    [action, entityId],
  );
  return rows;
}

beforeAll(async () => {
  h = await startHarness();
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  cashier = await browser(h).loginActive(h.fx.users.cashierA);
  desk = await browser(h).loginActive(h.fx.users.deskA);
  auditor = await browser(h).loginActive(h.fx.users.auditorA);
  housekeeping = await browser(h).loginActive(h.fx.users.housekeepingA);
  ownerB = await browser(h).loginActive(h.fx.users.ownerB);
  base = `/properties/${h.fx.propA1}`;
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  for (const c of (await acc.get(`${base}/cash-accounts`)).body.data) cash[c.name] = c.id;
  const ob = await withKey(acc, `${base}/opening-balances`, {
    asOf: '2026-10-18',
    lines: [
      { accountId: account['1000'], debit: '20000' },
      { accountId: account['3000'], credit: '20000' },
    ],
  });
  if (ob.status !== 201) throw new Error(JSON.stringify(ob.body));
});

afterAll(async () => {
  vi.useRealTimers();
  await h?.close();
});

describe('expense attachments', () => {
  let expenseId: string;
  let file: Buffer;

  it('stores a receipt encrypted, under a key with no name in it', async () => {
    expenseId = await cashExpense(cashier);
    file = pdf();
    const res = await upload(cashier, expenseId, file, 'March bill.pdf', 'application/pdf');
    expect(res.status).toBe(200);
    expect(res.body.data.attachments).toEqual([
      expect.objectContaining({
        fileName: 'March bill.pdf',
        contentType: 'application/pdf',
        sizeBytes: file.length,
        removable: true,
      }),
    ]);
    const [row] = await rowsFor('expense_id', expenseId);
    expect(row!.object_key).toMatch(new RegExp(`^t/${h.fx.tenantA}/p/${h.fx.propA1}/[0-9a-f-]{36}$`));
    expect(row!.object_key).not.toMatch(/march|bill|pdf/i);
    const stored = await s3.get(row!.object_key);
    expect(stored).not.toBeNull();
    expect(stored!.includes(Buffer.from('%PDF'))).toBe(false);
    expect(stored!.equals(file)).toBe(false);
    const [audit] = await audits('expense.attachment_added', expenseId);
    expect(audit!.changes).toMatchObject({ fileName: 'March bill.pdf', contentType: 'application/pdf' });
  });

  it('keeps one copy when the same file is sent again', async () => {
    const again = await upload(cashier, expenseId, file, 'other name.pdf');
    expect(again.status).toBe(200);
    expect(again.body.data.attachments).toHaveLength(1);
    expect(await rowsFor('expense_id', expenseId)).toHaveLength(1);
    expect(await audits('expense.attachment_added', expenseId)).toHaveLength(1);
  });

  it('downloads through a five-minute link for the person who asked', async () => {
    const attachmentId = (await cashier.get(`${base}/expenses/${expenseId}`)).body.data.attachments[0].id;
    const link = await cashier.post(`${base}/expenses/${expenseId}/attachments/${attachmentId}/link`);
    expect(link.status).toBe(200);
    expect(link.body.data.url).toMatch(/^\/api\/v1\/files\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const ttl = Date.parse(link.body.data.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThanOrEqual(300_000);

    const res = await cashier.agent.get(link.body.data.url).buffer(true);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).equals(file)).toBe(true);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toBe(
      `inline; filename="March bill.pdf"; filename*=UTF-8''March%20bill.pdf`,
    );
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('SEC-003: a link is useless to anyone else, tampered with, or signed out', async () => {
    const attachmentId = (await cashier.get(`${base}/expenses/${expenseId}`)).body.data.attachments[0].id;
    const { url } = (await cashier.post(`${base}/expenses/${expenseId}/attachments/${attachmentId}/link`))
      .body.data;
    // Same tenant, allowed to see the expense, but not the person the link was issued to.
    expect((await acc.agent.get(url)).status).toBe(404);
    const other = await ownerB.agent.get(url);
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toMatch(/March|receipt|pdf/i);
    expect((await browser(h).agent.get(url)).status).toBe(401);
    const token = url.split('/').pop()!;
    const [payload, mac] = token.split('.');
    const flipped = `${payload!.slice(0, -1)}${payload!.endsWith('A') ? 'B' : 'A'}.${mac}`;
    expect((await cashier.get(`/files/${flipped}`)).status).toBe(404);
    expect((await cashier.get(`/files/${payload}.${'A'.repeat(43)}`)).status).toBe(404);
    expect((await cashier.get('/files/not-a-link')).status).toBe(404);
  });

  it('SEC-003: a link stops working when it expires', async () => {
    const attachmentId = (await cashier.get(`${base}/expenses/${expenseId}`)).body.data.attachments[0].id;
    const { url } = (await cashier.post(`${base}/expenses/${expenseId}/attachments/${attachmentId}/link`))
      .body.data;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 301_000);
      const res = await cashier.agent.get(url);
      expect(res.status).toBe(410);
      expect(res.body.error.code).toBe('LINK_EXPIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses unsafe files, whatever they are called, and stores nothing', async () => {
    const id = await cashExpense(cashier, 'Unsafe files');
    const cases: [Buffer, string, number, string][] = [
      [Buffer.from('MZ\x90\x00\x03 windows program'), 'invoice.exe', 415, 'FILE_REJECTED'],
      [Buffer.from('MZ\x90\x00\x03 windows program'), 'receipt.pdf', 415, 'FILE_REJECTED'],
      [
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
        'logo.png',
        415,
        'FILE_REJECTED',
      ],
      [Buffer.from('<html><script>alert(1)</script></html>'), 'bill.pdf', 415, 'FILE_REJECTED'],
      [
        Buffer.from('%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>'),
        'a.pdf',
        415,
        'FILE_REJECTED',
      ],
      [Buffer.alloc(0), 'empty.pdf', 415, 'FILE_REJECTED'],
      [Buffer.concat([pdf(), Buffer.alloc(5 * 1024 * 1024)]), 'huge.pdf', 413, 'FILE_TOO_LARGE'],
    ];
    for (const [body, name, status, code] of cases) {
      const res = await upload(cashier, id, body, name);
      expect([name, res.status, res.body.error?.code]).toEqual([name, status, code]);
    }
    const json = await cashier.post(`${base}/expenses/${id}/attachments?fileName=x.pdf`, { file: 'x' });
    expect(json.status).toBe(415);
    const pathName = await upload(cashier, id, pdf(), '../../etc/passwd');
    expect(pathName.status).toBe(400);
    expect(await rowsFor('expense_id', id)).toHaveLength(0);
  });

  it('names a file by what it really is', async () => {
    const id = await cashExpense(cashier, 'Renamed file');
    const res = await upload(cashier, id, pdf(), 'bill.exe');
    expect(res.status).toBe(200);
    expect(res.body.data.attachments[0]).toMatchObject({
      fileName: 'bill.exe.pdf',
      contentType: 'application/pdf',
    });
  });

  it('follows the expense visibility, role and tenant rules', async () => {
    const accountantsOwn = await cashExpense(acc, 'Accountant expense');
    await upload(acc, accountantsOwn, pdf());
    const attachmentId = (await acc.get(`${base}/expenses/${accountantsOwn}`)).body.data.attachments[0].id;
    // The cashier sees only their own expenses.
    expect((await upload(cashier, accountantsOwn, pdf())).status).toBe(404);
    expect(
      (await cashier.post(`${base}/expenses/${accountantsOwn}/attachments/${attachmentId}/link`)).status,
    ).toBe(404);
    // Another attachment id under this expense, or this attachment under another expense: not found.
    expect(
      (await acc.post(`${base}/expenses/${accountantsOwn}/attachments/${randomUUID()}/link`)).status,
    ).toBe(404);
    expect((await acc.post(`${base}/expenses/${expenseId}/attachments/${attachmentId}/link`)).status).toBe(
      404,
    );
    // No expense permission at all.
    expect((await upload(housekeeping, accountantsOwn, pdf())).status).toBe(403);
    // Another tenant, using tenant A's ids.
    const cross = await upload(ownerB, accountantsOwn, pdf());
    expect([403, 404]).toContain(cross.status);
    expect(
      [403, 404].includes(
        (await ownerB.post(`${base}/expenses/${accountantsOwn}/attachments/${attachmentId}/link`)).status,
      ),
    ).toBe(true);
    const crossOwnProperty = await ownerB.post(
      `/properties/${h.fx.propB1}/expenses/${accountantsOwn}/attachments/${attachmentId}/link`,
    );
    expect(crossOwnProperty.status).toBe(404);
    expect(await rowsFor('expense_id', accountantsOwn)).toHaveLength(1);
  });

  it('removes a file from a draft: the row stays, the stored file goes, old links stop working', async () => {
    const id = await cashExpense(cashier, 'To be removed');
    const added = await upload(cashier, id, pdf());
    const attachmentId = added.body.data.attachments[0].id;
    const { url } = (await cashier.post(`${base}/expenses/${id}/attachments/${attachmentId}/link`)).body.data;
    const [before] = await rowsFor('expense_id', id);

    const res = await cashier.delete(`${base}/expenses/${id}/attachments/${attachmentId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.attachments).toEqual([]);
    const [after] = await rowsFor('expense_id', id);
    expect(after!.removed_at).not.toBeNull();
    expect(await s3.get(before!.object_key)).toBeNull();
    expect(await audits('expense.attachment_removed', id)).toHaveLength(1);
    expect((await cashier.agent.get(url)).status).toBe(404);
    expect((await cashier.delete(`${base}/expenses/${id}/attachments/${attachmentId}`)).status).toBe(404);
    // The database refuses to edit or un-remove an attachment, even for the owner role.
    await expect(
      h.admin.query(`UPDATE attachments SET file_name = 'x.pdf' WHERE id = $1`, [attachmentId]),
    ).rejects.toThrow();
  });

  it('keeps files with a posted expense, still accepts late receipts, refuses files on a void one', async () => {
    const id = await cashExpense(cashier, 'Posted with receipt');
    const first = await upload(cashier, id, pdf());
    const firstId = first.body.data.attachments[0].id;
    const posted = await withKey(cashier, `${base}/expenses/${id}/submit`);
    expect(posted.body.data.status).toBe('paid');
    expect(posted.body.data.attachments[0].removable).toBe(false);

    const removal = await cashier.delete(`${base}/expenses/${id}/attachments/${firstId}`);
    expect(removal.status).toBe(409);
    const late = await upload(cashier, id, jpeg(), 'photo.jpg');
    expect(late.status).toBe(200);
    expect(late.body.data.attachments.map((x: { contentType: string }) => x.contentType)).toEqual([
      'application/pdf',
      'image/jpeg',
    ]);

    const voidId = await cashExpense(cashier, 'Voided');
    await withKey(cashier, `${base}/expenses/${voidId}/void`, { reason: 'Entered twice' });
    expect((await upload(cashier, voidId, pdf())).status).toBe(409);
  });
});

describe('guest identity scans', () => {
  let guestId: string;
  let scanId: string;
  let scan: Buffer;

  beforeAll(async () => {
    const res = await desk.post('/guests', { fullName: 'Scan Check Guest', phone: '0300 1112223' });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    guestId = res.body.data.id;
  });

  it('stores a scan under a neutral name and a key without guest data', async () => {
    scan = jpeg();
    const res = await desk.upload(
      `/guests/${guestId}/scans?fileName=${encodeURIComponent('Scan Check Guest CNIC 35202-1234567-1.jpg')}`,
      scan,
      'image/jpeg',
    );
    expect(res.status).toBe(200);
    expect(res.body.data.scans).toEqual([
      expect.objectContaining({ fileName: 'identity-scan.jpg', contentType: 'image/jpeg', removable: true }),
    ]);
    scanId = res.body.data.scans[0].id;
    const [row] = await rowsFor('guest_id', guestId);
    expect(row!.object_key).toMatch(new RegExp(`^t/${h.fx.tenantA}/shared/[0-9a-f-]{36}$`));
    expect(JSON.stringify(row)).not.toMatch(/Scan Check|35202|CNIC/i);
    const [audit] = await audits('guest.scan_added', guestId);
    expect(JSON.stringify(audit)).not.toMatch(/Scan Check|35202|CNIC/i);
  });

  it('hides scans from roles without identity access and refuses them everything', async () => {
    const res = await auditor.get(`/guests/${guestId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.scans).toBeNull();
    expect(
      (await auditor.post(`/guests/${guestId}/scans/${scanId}/link`, { reason: 'curious' })).status,
    ).toBe(403);
    expect((await auditor.upload(`/guests/${guestId}/scans?fileName=a.jpg`, jpeg())).status).toBe(403);
    expect((await auditor.delete(`/guests/${guestId}/scans/${scanId}`)).status).toBe(403);
  });

  it('needs a reason for a link, and audits the link and every download', async () => {
    expect((await desk.post(`/guests/${guestId}/scans/${scanId}/link`, {})).status).toBe(400);
    const link = await desk.post(`/guests/${guestId}/scans/${scanId}/link`, {
      reason: 'Police register check',
    });
    expect(link.status).toBe(200);
    const [issued] = await audits('guest.scan_link_issued', guestId);
    expect(issued).toMatchObject({ reason: 'Police register check', changes: { attachmentId: scanId } });

    for (let i = 0; i < 2; i++) {
      const res = await desk.agent.get(link.body.data.url).buffer(true);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body).equals(scan)).toBe(true);
      expect(res.headers['content-disposition']).toContain('identity-scan.jpg');
    }
    expect(await audits('guest.scan_downloaded', guestId)).toHaveLength(2);
  });

  it('is not reachable from another tenant', async () => {
    expect((await ownerB.get(`/guests/${guestId}`)).status).toBe(404);
    expect((await ownerB.post(`/guests/${guestId}/scans/${scanId}/link`, { reason: 'probe' })).status).toBe(
      404,
    );
    expect((await ownerB.upload(`/guests/${guestId}/scans?fileName=a.jpg`, jpeg())).status).toBe(404);
    expect((await ownerB.delete(`/guests/${guestId}/scans/${scanId}`)).status).toBe(404);
  });

  it('removes a scan and deletes the stored file', async () => {
    const [row] = await rowsFor('guest_id', guestId);
    const res = await desk.delete(`/guests/${guestId}/scans/${scanId}`);
    expect(res.status).toBe(200);
    expect(res.body.data.scans).toEqual([]);
    expect(await s3.get(row!.object_key)).toBeNull();
    expect(await audits('guest.scan_removed', guestId)).toHaveLength(1);
  });
});

describe('storage outage', () => {
  let broken: INestApplication;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: h.db.appUrl,
      WEB_ORIGINS: ORIGIN,
      COOKIE_SECURE: 'false',
      MFA_ENCRYPTION_KEY: MFA_KEY.toString('base64url'),
      PII_ENCRYPTION_KEY: PII_KEY.toString('base64url'),
      LOG_LEVEL: 'silent',
      RATE_LIMIT_ENABLED: 'false',
      // Jobs are run by the tests themselves, not by a timer.
      JOBS_POLL_SECONDS: '0',
      STORAGE_ENDPOINT: 'http://127.0.0.1:1',
      STORAGE_BUCKET: 'innpilot-test',
      STORAGE_ACCESS_KEY_ID: 'nobody',
      STORAGE_SECRET_ACCESS_KEY: 'nothing-here',
    });
    broken = await createApp(config, { logger: false });
    await broken.init();
  });

  afterAll(async () => {
    await broken?.close();
  });

  it('answers with a clear error and stores nothing', async () => {
    const id = await cashExpense(cashier, 'Storage down');
    // The same session cookie works against the second app: it shares the database.
    const { default: request } = await import('supertest');
    const cookies = (await cashier.agent.get('/api/v1/auth/me')).request.cookies;
    const res = await request(broken.getHttpServer())
      .post(`/api/v1${base}/expenses/${id}/attachments?fileName=r.pdf`)
      .set('origin', ORIGIN)
      .set('x-csrf-token', cashier.csrf)
      .set('cookie', cookies)
      .set('content-type', 'application/pdf')
      .send(pdf());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STORAGE_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|fetch/);
    expect(await rowsFor('expense_id', id)).toHaveLength(0);
  });
});
