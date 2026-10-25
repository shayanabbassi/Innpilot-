/**
 * Phase 6 slice 6.7 (P6-10, QA §5): load test on the 100-room year. Seeds the year, creates front desk and cashier
 * users with real sessions, serves the API, runs apps/api/load/hotel.k6.js with k6 (Docker), then checks the
 * database: no room type sold beyond its rooms on any night, exactly one winner of the last-room burst, one
 * payment per idempotency key, receipt numbers unique and gapless, the ledger intact. Writes the results for
 * docs/phase-6-load-test.md. Run with `pnpm --filter @innpilot/api test:perf load`.
 *
 * The API runs in this process with the test settings (plain http, rate limits off: one load generator would
 * otherwise be throttled as a single client). Everything else, database role and row-level security included, is
 * the production code path.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { hashPassword, readMigrations } from '@innpilot/db';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIntegrityChecks } from '../src/ops/integrity';
import {
  browser,
  ORIGIN,
  PASSWORD,
  startHarness,
  totp,
  type FixtureUser,
  type Harness,
} from '../test/harness';
import { seedHundredRoomYear, type Seeded } from './hundred-rooms';

const K6_IMAGE = 'grafana/k6:2.2.0';
const loadDir = join(__dirname, '..', 'load');
const outDir = join(loadDir, 'out');

let h: Harness;
let seeded: Seeded;
let port: number;

interface Session {
  cookie: string;
  csrf: string;
}

/** Signs in through the API (completing two-step verification for fixture users that have it). */
async function signIn(user: Pick<FixtureUser, 'email' | 'mfaSecret' | 'id'>): Promise<Session> {
  const server = h.app.getHttpServer();
  const login = await request(server).post('/api/v1/auth/login').set('origin', ORIGIN).send({
    email: user.email,
    password: PASSWORD,
  });
  if (login.status !== 200)
    throw new Error(`sign-in failed for ${user.email}: ${JSON.stringify(login.body)}`);
  const jar = new Map<string, string>();
  const take = (res: request.Response) => {
    for (const c of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) {
      const [pair] = c.split(';');
      const i = pair!.indexOf('=');
      jar.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
  };
  take(login);
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrf = () => decodeURIComponent([...jar].find(([k]) => k.endsWith('ip_csrf'))![1]);
  if (login.body.data.sessionState === 'mfa_verify') {
    const verify = await request(server)
      .post('/api/v1/auth/mfa/verify')
      .set('origin', ORIGIN)
      .set('cookie', cookie())
      .set('x-csrf-token', csrf())
      .send({ code: totp(user.mfaSecret!) });
    if (verify.status !== 200) throw new Error(`verify failed: ${JSON.stringify(verify.body)}`);
    take(verify);
    await h.admin.query('UPDATE users SET mfa_last_used_step = NULL WHERE id = $1', [user.id]);
  }
  return { cookie: cookie(), csrf: csrf() };
}

function runK6(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function addUsers(prefix: string, role: string, count: number) {
  const hash = await hashPassword(PASSWORD);
  const users: { id: string; email: string }[] = [];
  for (let i = 1; i <= count; i++) {
    const email = `${prefix}${i}@load.test`;
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, full_name, password_hash) VALUES ($1, $2::text, $2::text, $3) RETURNING id`,
      [h.fx.tenantA, email, hash],
    );
    await h.admin.query(
      `INSERT INTO user_roles (tenant_id, user_id, property_id, role_code) VALUES ($1, $2, NULL, $3)`,
      [h.fx.tenantA, rows[0]!.id, role],
    );
    users.push({ id: rows[0]!.id, email });
  }
  return users;
}

beforeAll(async () => {
  h = await startHarness();
  const owner = await browser(h).loginActive(h.fx.users.ownerA);
  seeded = await seedHundredRoomYear(h, owner);
  await h.app.listen(0, '0.0.0.0');
  port = (h.app.getHttpServer().address() as AddressInfo).port;
}, 900_000);

afterAll(async () => {
  await h?.close();
});

describe('load: 100 rooms, 32 staff at once, booking and payment bursts', () => {
  it('meets the latency targets and keeps every booking and payment consistent', async () => {
    const base = `/properties/${h.fx.propA1}`;
    const owner = await browser(h).loginActive(h.fx.users.ownerA);
    const { rows: prop } = await h.admin.query<{ d: string }>(
      `SELECT business_date::text AS d FROM properties WHERE id = $1`,
      [h.fx.propA1],
    );
    const businessDate = prop[0]!.d;
    const std = (
      await h.admin.query<{ id: string }>(
        `SELECT id FROM room_types WHERE property_id = $1 AND code = 'STD'`,
        [h.fx.propA1],
      )
    ).rows[0]!.id;

    // The last free room: a room type with one room, which the burst all tries to book.
    const last = await owner.post(`${base}/room-types`, {
      code: 'LAST',
      name: 'Last room',
      capacityAdults: 2,
      capacityChildren: 0,
      nightlyRate: '9000',
    });
    await owner.post(`${base}/rooms/bulk`, { from: '901', to: '901', roomTypeId: last.body.data.id });

    const frontDesk = await addUsers('desk', 'front_desk', 20);
    const cashiers = await addUsers('cashier', 'cashier', 8);
    const sessions = {
      front_desk: await Promise.all(frontDesk.map((u) => signIn(u))),
      cashier: await Promise.all(cashiers.map((u) => signIn(u))),
      reporting: [
        await signIn(h.fx.users.ownerA),
        await signIn(h.fx.users.accountantA),
        await signIn(h.fx.users.managerA),
      ],
    };

    const guestIds = (
      await h.admin.query<{ id: string }>(`SELECT id FROM guests WHERE tenant_id = $1 LIMIT 200`, [
        h.fx.tenantA,
      ])
    ).rows.map((r) => r.id);
    const folioIds = (
      await h.admin.query<{ id: string }>(
        `SELECT id FROM folios WHERE property_id = $1 ORDER BY random() LIMIT 300`,
        [h.fx.propA1],
      )
    ).rows.map((r) => r.id);

    // The reservation whose deposit is retried 20 times at once.
    const deskClient = browser(h);
    expect((await deskClient.login(frontDesk[0]!.email)).status).toBe(200);
    const burstReservation = await deskClient.agent
      .post(`/api/v1${base}/reservations`)
      .set('origin', ORIGIN)
      .set('x-csrf-token', deskClient.csrf)
      .set('idempotency-key', randomUUID())
      .send({
        guestId: guestIds[0],
        source: 'phone',
        rooms: [{ roomTypeId: std, arrival: '2027-02-01', departure: '2027-02-03', adults: 1 }],
      });
    expect(burstReservation.status).toBe(201);

    const config = {
      baseUrl: `http://host.docker.internal:${port}`,
      origin: ORIGIN,
      propertyId: h.fx.propA1,
      roomTypeId: std,
      firstFutureDate: businessDate,
      monthFrom: '2026-10-01',
      monthTo: '2026-10-18',
      guestIds,
      folioIds,
      searches: ['Perf Guest 01', 'Perf Guest 2', 'Perf Guest 15', 'PAAA', 'Perf'],
      sessions,
      burst: {
        lastRoomTypeId: last.body.data.id,
        arrival: '2026-12-24',
        departure: '2026-12-26',
        reservationId: burstReservation.body.data.id,
        paymentKey: randomUUID(),
      },
    };
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'config.json'), JSON.stringify(config));

    const started = Date.now();
    // Asynchronous on purpose: the API under test runs in this process and must keep answering.
    const k6 = await runK6([
      'run',
      '--rm',
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      `${loadDir.replace(/\\/g, '/')}:/load`,
      K6_IMAGE,
      'run',
      '--quiet',
      '--summary-export',
      '/load/out/summary.json',
      '-e',
      'CONFIG=/load/out/config.json',
      '/load/hotel.k6.js',
    ]);
    const elapsed = Math.trunc((Date.now() - started) / 1000);
    // The sessions in the config are live test sessions: never leave them on disk.
    writeFileSync(join(outDir, 'config.json'), '{}');
    process.stdout.write(`${k6.stdout}\n${k6.stderr.slice(-4000)}\n`);
    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8')) as {
      metrics: Record<string, Record<string, number> & { values?: Record<string, number> }>;
    };
    const metric = (name: string) => {
      const m = summary.metrics[name];
      return (m?.values ?? m ?? {}) as Record<string, number>;
    };

    // ---- What the database says after the run ----
    const q = async <T>(text: string, values: unknown[] = []) =>
      (await h.admin.query(text, values)).rows as T[];
    const overbooked = await q<{ room_type: string; night: string; booked: number; rooms: number }>(
      `WITH nights AS (SELECT generate_series($2::date, $2::date + 120, interval '1 day')::date AS night),
            rooms AS (SELECT room_type_id, count(*)::int AS n FROM rooms WHERE property_id = $1 GROUP BY room_type_id)
       SELECT t.code AS room_type, n.night::text, count(rr.id)::int AS booked, rooms.n AS rooms
       FROM nights n
       CROSS JOIN room_types t
       JOIN rooms ON rooms.room_type_id = t.id
       LEFT JOIN reservation_rooms rr ON rr.room_type_id = t.id AND rr.status = 'active'
            AND rr.arrival <= n.night AND rr.departure > n.night
       WHERE t.property_id = $1
       GROUP BY t.code, n.night, rooms.n
       HAVING count(rr.id) > rooms.n`,
      [h.fx.propA1, businessDate],
    );
    const lastRoom = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM reservation_rooms WHERE room_type_id = $1 AND status = 'active'`,
      [config.burst.lastRoomTypeId],
    );
    const burstPayments = await q<{ n: number; journals: number }>(
      `SELECT count(*)::int AS n, count(DISTINCT journal_entry_id)::int AS journals FROM payments WHERE reservation_id = $1`,
      [config.burst.reservationId],
    );
    const duplicates = await q<{ payments: number; keys: number }>(
      `SELECT count(*)::int AS payments, count(DISTINCT idempotency_key)::int AS keys
       FROM payments WHERE property_id = $1 AND idempotency_key IS NOT NULL`,
      [h.fx.propA1],
    );
    const receipts = await q<{ n: number; distinct_n: number; max_n: number }>(
      `SELECT count(*)::int AS n, count(DISTINCT receipt_number)::int AS distinct_n,
              coalesce(max(substring(receipt_number FROM '[0-9]+$')::int) FILTER (WHERE receipt_number LIKE 'RCT-%'), 0) AS max_n
       FROM payments WHERE property_id = $1 AND receipt_number LIKE 'RCT-%'`,
      [h.fx.propA1],
    );
    const tables = (
      await q<{ t: string }>(`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`)
    ).map((r) => r.t);
    const rowCounts: Record<string, number> = {};
    for (const t of tables)
      rowCounts[t] = Number((await q<{ n: string }>(`SELECT count(*) AS n FROM "${t}"`))[0]!.n);
    const checks = await runIntegrityChecks(
      h.admin,
      {
        database: h.db.name,
        createdAt: new Date().toISOString(),
        serverVersion: '',
        migrations: readMigrations().map((m) => m.name),
        rowCounts,
        dumpBytes: 0,
        dumpSha256: '',
      },
      readMigrations().map(({ name, checksum }) => ({ name, checksum })),
    );
    const ledgerChecks = checks.filter((c) => /trial balance|Folio balances|Cash and bank/.test(c.name));

    const dur = (tag: string) => metric(`http_req_duration{kind:${tag}}`);
    const fmt = (v: number | undefined) => (v === undefined ? 'n/a' : `${Math.trunc(v)} ms`);
    const reqs = metric('http_reqs');
    const results = [
      `Run ${new Date().toISOString().slice(0, 16)}Z, ${elapsed} s of load against the 100-room year`,
      `(${seeded.reservations.toLocaleString('en')} reservations, ${seeded.journals.toLocaleString('en')} journals, ` +
        `${seeded.auditEvents.toLocaleString('en')} audit events), API on one Node process, database pool of 10.`,
      '',
      '| Requests | Kind | p50 | p95 | p99 | max |',
      '| --- | --- | --- | --- | --- | --- |',
      ...(['read', 'write', 'report'] as const).map((k) => {
        const d = dur(k);
        return `| ${k === 'read' ? 'Common reads' : k === 'write' ? 'Bookings and payments' : 'Dashboard and reports'} | ${k} | ${fmt(d.med)} | ${fmt(d['p(95)'])} | ${fmt(d['p(99)'])} | ${fmt(d.max)} |`;
      }),
      '',
      `${Math.trunc(reqs.count ?? 0).toLocaleString('en')} requests (${(reqs.rate ?? 0).toFixed(1)} per second); ` +
        `failed (unexpected status): ${((metric('http_req_failed').value ?? metric('http_req_failed').rate ?? 0) * 100).toFixed(2)}%; ` +
        `checks passed: ${((metric('checks').value ?? metric('checks').rate ?? 0) * 100).toFixed(2)}%.`,
      '',
      '| Consistency check | Result |',
      '| --- | --- |',
      `| No room type sold beyond its rooms on any night | ${overbooked.length === 0 ? 'ok' : `**${overbooked.length} nights over**`} |`,
      `| Last-room burst: 30 at once, one confirmed | ${lastRoom[0]!.n} confirmed; k6 saw ${metric('booking_burst_confirmed').count ?? 0} confirmed, ${metric('booking_burst_refused').count ?? 0} refused |`,
      `| Deposit retried 20 times with one key | ${burstPayments[0]!.n} payment, ${burstPayments[0]!.journals} journal |`,
      `| One payment per idempotency key | ${duplicates[0]!.payments} payments, ${duplicates[0]!.keys} keys |`,
      `| Receipt numbers unique and gapless | ${receipts[0]!.n} receipts, ${receipts[0]!.distinct_n} distinct, highest RCT-${receipts[0]!.max_n} |`,
      ...ledgerChecks.map((c) => `| ${c.name} | ${c.ok ? 'ok' : '**failed**'}: ${c.detail} |`),
      '',
    ].join('\n');
    writeFileSync(join(outDir, 'results.md'), results);
    process.stdout.write(`${results}\n`);

    expect(overbooked).toEqual([]);
    expect(lastRoom[0]!.n).toBe(1);
    expect(burstPayments[0]).toEqual({ n: 1, journals: 1 });
    expect(duplicates[0]!.payments).toBe(duplicates[0]!.keys);
    expect(receipts[0]!.distinct_n).toBe(receipts[0]!.n);
    expect(receipts[0]!.max_n).toBe(receipts[0]!.n);
    expect(ledgerChecks.filter((c) => !c.ok)).toEqual([]);
    // k6 exits non-zero when a latency or error threshold is missed.
    expect(k6.status, 'k6 thresholds').toBe(0);
  });
});
