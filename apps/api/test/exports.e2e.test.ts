/**
 * Phase 5 slice 5.6 — CSV and Excel exports (P5-14, D15). An export carries the same figures as the screen; it needs
 * `export.run` as well as the report's own permission (front desk, cashier and the read-only auditor are refused);
 * it is audited; it never crosses tenants or properties; text that a spreadsheet would run as a formula is
 * neutralised.
 */
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPORT_REPORTS } from '@innpilot/contracts';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

let h: Harness;
let owner: BrowserClient;
let acc: BrowserClient;
let base: string;
const account: Record<string, string> = {};
const cat: Record<string, string> = {};
const HOSTILE = '=HYPERLINK("http://x","click")';

const withKey = (c: BrowserClient, path: string, body: object = {}) =>
  c.agent
    .post(`/api/v1${path}`)
    .set('origin', ORIGIN)
    .set('x-csrf-token', c.csrf)
    .set('idempotency-key', randomUUID())
    .send(body);
async function ok(res: Promise<{ status: number; body: { data: Record<string, unknown> } }>, status = 201) {
  const r = await res;
  if (r.status !== status) throw new Error(`${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

/** Downloads a file response as raw bytes. */
function download(c: BrowserClient, path: string) {
  return c.agent
    .get(`/api/v1${path}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
}

/** The entries of a zip archive (enough to read back what toXlsx wrote). */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.toString('utf8', i + 30, i + 30 + nameLen);
    const start = i + 30 + nameLen + extra;
    out.set(name, inflateRawSync(buf.subarray(start, start + size)).toString('utf8'));
    i = start + size;
  }
  return out;
}

beforeAll(async () => {
  h = await startHarness();
  base = `/properties/${h.fx.propA1}`;
  owner = await browser(h).loginActive(h.fx.users.ownerA);
  acc = await browser(h).loginActive(h.fx.users.accountantA);
  const desk = await browser(h).loginActive(h.fx.users.deskA);
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  for (const c of (await acc.get(`${base}/charge-categories`)).body.data) cat[c.code] = c.id;
  const draft = await ok(
    withKey(acc, '/finance/journal-entries/draft', {
      propertyId: h.fx.propA1,
      narration: 'Room revenue for the export test',
      accountingDate: '2026-10-10',
      lines: [
        { accountId: account['1100'], debit: '12500.50' },
        { accountId: account['4000'], credit: '12500.50' },
      ],
    }),
  );
  await ok(withKey(acc, `/finance/journal-entries/${draft.id as string}/post`), 200);

  // A guest whose name is a spreadsheet formula, with a balance on an open folio.
  const std = (
    await owner.post(`${base}/room-types`, {
      code: 'STD',
      name: 'Standard',
      capacityAdults: 2,
      capacityChildren: 0,
      nightlyRate: '5000',
    })
  ).body.data.id;
  const rooms = (await owner.post(`${base}/rooms/bulk`, { from: '301', to: '301', roomTypeId: std })).body
    .data;
  const guestId = ((await desk.post('/guests', { fullName: HOSTILE })).body.data as { id: string }).id;
  const res = (await ok(
    withKey(desk, `${base}/reservations`, {
      guestId,
      source: 'phone',
      rooms: [
        { roomTypeId: std, roomId: rooms[0].id, arrival: '2026-10-19', departure: '2026-10-20', adults: 1 },
      ],
    }),
  )) as { id: string; rooms: { id: string }[] };
  await ok(withKey(desk, `${base}/reservations/${res.id}/rooms/${res.rooms[0]!.id}/check-in`), 200);
  const folioId = (await desk.get(`${base}/reservations/${res.id}/folios`)).body.data[0].id;
  await ok(
    withKey(desk, `${base}/folios/${folioId}/charges`, {
      categoryId: cat['fnb'],
      description: 'Dinner',
      unitPrice: '700',
    }),
  );
});

afterAll(async () => {
  await h?.close();
});

const P = () => `propertyId=${h.fx.propA1}`;
const OCT = 'from=2026-10-01&to=2026-10-31';
/** A valid query for each report. */
const query = (r: (typeof EXPORT_REPORTS)[number]) =>
  r === 'balance-sheet' || r === 'receivables-aging' || r === 'payables-aging'
    ? `asOf=2026-10-19&${P()}`
    : r === 'user-activity'
      ? 'from=2026-01-01&to=2030-12-31'
      : `${OCT}&${P()}`;

describe('CSV', () => {
  it('carries the same figures as the screen, with a clear file name', async () => {
    const res = await download(owner, `/reports/profit-loss/export?format=csv&${OCT}&${P()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="innpilot_profit-loss_a-one_2026-10-01_to_2026-10-31.csv"',
    );
    expect(res.headers['cache-control']).toBe('no-store');
    const body = res.body as Buffer;
    expect([...body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = body.toString('utf8').slice(1);
    const screen = (await owner.get(`/reports/profit-loss?${OCT}&${P()}`)).body.data;
    expect(text).toContain(`,,Net profit (loss),${screen.netProfit.amount}\r\n`);
    expect(text).toContain('Revenue,4000,Room revenue,12500.50');
    expect(text.split('\r\n').slice(0, 5)).toEqual([
      'Profit and loss',
      'A One',
      '2026-10-01 to 2026-10-31',
      'Amounts in PKR; time zone Asia/Karachi',
      expect.stringMatching(/^Generated \d{4}-/),
    ]);
  });

  it('neutralises text a spreadsheet would run as a formula', async () => {
    const res = await download(owner, `/reports/receivables-aging/export?format=csv&asOf=2026-10-19&${P()}`);
    const text = (res.body as Buffer).toString('utf8');
    expect(text).toContain(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(text).not.toMatch(/(^|,)"?=HYPERLINK/m);
    // Amounts are written as plain numbers, untouched by the formula guard.
    expect(text).toContain(',700.00');
  });

  it('exports every report', async () => {
    for (const r of EXPORT_REPORTS) {
      const res = await download(owner, `/reports/${r}/export?format=csv&${query(r)}`);
      expect(res.status, r).toBe(200);
      expect((res.body as Buffer).length, r).toBeGreaterThan(50);
    }
  });
});

describe('Excel', () => {
  it('is a workbook with one sheet per table and amounts as numbers', async () => {
    const res = await download(owner, `/reports/cashbook/export?format=xlsx&${OCT}&${P()}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toMatch(
      /innpilot_cashbook_a-one_2026-10-01_to_2026-10-31\.xlsx"$/,
    );
    const files = unzip(res.body as Buffer);
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ]);
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Check against the ledger"');
    // The bank's closing balance as a number cell with the amount style.
    expect(files.get('xl/worksheets/sheet1.xml')).toMatch(/<c r="G\d+" s="2"><v>12500.50<\/v><\/c>/);
  });

  it('escapes and neutralises guest text', async () => {
    const res = await download(owner, `/reports/receivables-aging/export?format=xlsx&asOf=2026-10-19&${P()}`);
    const sheet = unzip(res.body as Buffer).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain(
      '&apos;=HYPERLINK(&quot;http://x&quot;,&quot;click&quot;)'.replace('&apos;', "'"),
    );
  });
});

describe('permissions, audit and isolation', () => {
  it('needs export.run on top of the report permission', async () => {
    const desk = await browser(h).loginActive(h.fx.users.deskA);
    const cashier = await browser(h).loginActive(h.fx.users.cashierA);
    const auditor = await browser(h).loginActive(h.fx.users.auditorA);
    for (const c of [desk, cashier, auditor]) {
      expect((await download(c, `/reports/occupancy/export?format=csv&${OCT}&${P()}`)).status).toBe(403);
      expect((await download(c, `/reports/profit-loss/export?format=csv&${OCT}&${P()}`)).status).toBe(403);
    }
    // The auditor can still read the report on screen.
    expect((await auditor.get(`/reports/profit-loss?${OCT}&${P()}`)).status).toBe(200);
  });

  it('keeps a property-scoped manager to their property', async () => {
    const m1 = await browser(h).loginActive(h.fx.users.managerA1);
    expect((await download(m1, `/reports/profit-loss/export?format=csv&${OCT}&${P()}`)).status).toBe(200);
    expect(
      (await download(m1, `/reports/profit-loss/export?format=csv&${OCT}&propertyId=${h.fx.propA2}`)).status,
    ).toBe(404);
    expect((await download(m1, `/reports/profit-loss/export?format=csv&${OCT}`)).status).toBe(403);
    expect((await download(m1, `/reports/user-activity/export?format=csv&${OCT}`)).status).toBe(403);
  });

  it('records each export in the audit log', async () => {
    await download(acc, `/reports/balance-sheet/export?format=xlsx&asOf=2026-10-19&${P()}`);
    const { rows } = await h.admin.query<{ property_id: string; changes: Record<string, unknown> }>(
      `SELECT property_id, changes FROM audit_events
       WHERE tenant_id = $1 AND action = 'report.exported' AND actor_user_id = $2
       ORDER BY occurred_at DESC LIMIT 1`,
      [h.fx.tenantA, h.fx.users.accountantA.id],
    );
    expect(rows[0]).toMatchObject({
      property_id: h.fx.propA1,
      changes: {
        report: 'balance-sheet',
        format: 'xlsx',
        filters: { asOf: '2026-10-19', propertyId: h.fx.propA1 },
      },
    });
    expect(rows[0]!.changes.rows).toBeGreaterThan(5);
  });

  it('shows another tenant nothing', async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await download(ownerB, `/reports/profit-loss/export?format=csv&${OCT}&${P()}`)).status).toBe(404);
    const own = await download(ownerB, `/reports/cashbook/export?format=csv&${OCT}`);
    expect(own.status).toBe(200);
    expect((own.body as Buffer).toString('utf8')).not.toContain('12500.50');
  });

  it('refuses an unknown report, format or query', async () => {
    expect((await download(owner, `/reports/payroll/export?format=csv&${OCT}`)).status).toBe(404);
    const fmt = await owner.get(`/reports/profit-loss/export?format=pdf&${OCT}&${P()}`);
    expect(fmt.status).toBe(400);
    expect(fmt.body.error.details[0].path).toBe('format');
    expect(
      (await owner.get(`/reports/profit-loss/export?format=csv&from=2026-10-31&to=2026-10-01`)).status,
    ).toBe(400);
  });
});
