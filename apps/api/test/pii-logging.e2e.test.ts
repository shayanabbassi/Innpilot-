/**
 * Phase 2 exit gate: guest identity numbers never reach the application log. The app runs with its real
 * pino logger at trace level, writing into memory, while every route that accepts or returns a number is used.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, ORIGIN, startHarness, type BrowserClient, type Harness } from './harness';

// Fictional identity numbers only.
const CNIC = '35202-7654321-9';
const CNIC_DIGITS = '3520276543219';
const PASSPORT = 'XK9081726';
const WALK_IN_CNIC = '42101-8877665-3';
const WALK_IN_DIGITS = '4210188776653';
const SECRETS = [CNIC, CNIC_DIGITS, '7654321', PASSPORT, '9081726', WALK_IN_CNIC, WALK_IN_DIGITS, '8877665'];

const lines: string[] = [];
let h: Harness;
let desk: BrowserClient;

beforeAll(async () => {
  h = await startHarness({ logStream: { write: (line: string) => void lines.push(line) } });
  desk = await browser(h).loginActive(h.fx.users.deskA);
});

afterAll(async () => {
  await h?.close();
});

const log = () => lines.join('');

describe('identity numbers in the application log', () => {
  it('stay out of the log on every route that accepts or returns them', async () => {
    const base = `/properties/${h.fx.propA1}`;
    const created = await desk.post('/guests', {
      fullName: 'Log Check Guest',
      document: { documentType: 'cnic', issuingCountry: 'PK', number: CNIC },
    });
    expect(created.status).toBe(201);
    const guestId = created.body.data.id;

    expect((await desk.get(`/guests?search=${CNIC_DIGITS}`)).status).toBe(200);
    const duplicate = await desk.post('/guests/duplicate-check', {
      document: { documentType: 'cnic', number: CNIC },
    });
    expect(duplicate.body.data[0].reasons).toContain('document');

    const added = await desk.post(`/guests/${guestId}/documents`, {
      documentType: 'passport',
      issuingCountry: 'GB',
      number: PASSPORT,
    });
    expect(added.status).toBe(201);
    const passportId = added.body.data.documents.find(
      (d: { documentType: string }) => d.documentType === 'passport',
    ).id;
    const revealed = await desk.post(`/guests/${guestId}/documents/${passportId}/reveal`, {
      reason: 'Log check',
    });
    expect(revealed.body.data.number).toBe(PASSPORT);

    const owner = await browser(h).loginActive(h.fx.users.ownerA);
    const type = await owner.post(`${base}/room-types`, {
      code: 'LOG',
      name: 'Log check',
      capacityAdults: 2,
      capacityChildren: 0,
      nightlyRate: '5000',
    });
    const room = await owner.post(`${base}/rooms`, { roomNumber: '901', roomTypeId: type.body.data.id });
    expect(room.status).toBe(201);
    const walkIn = await desk.agent
      .post(`/api/v1${base}/walk-ins`)
      .set('origin', ORIGIN)
      .set('x-csrf-token', desk.csrf)
      .set('idempotency-key', randomUUID())
      .send({
        guest: {
          fullName: 'Log Check Walk In',
          document: { documentType: 'cnic', issuingCountry: 'PK', number: WALK_IN_CNIC },
        },
        roomId: room.body.data.id,
        departure: '2026-10-20',
        adults: 1,
      });
    expect(walkIn.status).toBe(201);

    // Rejected requests: a number that fails validation, and a body that is not valid JSON.
    const invalid = await desk.post(`/guests/${guestId}/documents`, {
      documentType: 'cnic',
      issuingCountry: 'PK',
      number: `${CNIC_DIGITS}${'9'.repeat(40)}`,
    });
    expect(invalid.status).toBe(400);
    const broken = await desk.agent
      .post(`/api/v1/guests/${guestId}/documents`)
      .set('origin', ORIGIN)
      .set('x-csrf-token', desk.csrf)
      .set('content-type', 'application/json')
      .send(`{"documentType":"cnic","number":"${CNIC}"`);
    expect(broken.status).toBe(400);

    // A failed login, logged by AuthService through Nest's Logger rather than by the request logger.
    const failedLogin = await browser(h).login('nobody@a.test');
    expect(failedLogin.status).toBe(401);

    // An unexpected database failure while a number is being stored: ErrorFilter logs it at error level.
    await h.admin.query('ALTER TABLE guest_documents RENAME TO guest_documents_unavailable');
    try {
      const failed = await desk.post(`/guests/${guestId}/documents`, {
        documentType: 'cnic',
        issuingCountry: 'PK',
        number: CNIC,
      });
      expect(failed.status).toBe(500);
    } finally {
      await h.admin.query('ALTER TABLE guest_documents_unavailable RENAME TO guest_documents');
    }

    // The log is real and covers these requests, so an empty or disabled log cannot pass.
    const output = log();
    expect(output).toContain('/api/v1/guests/duplicate-check');
    expect(output).toContain('/walk-ins');
    expect(lines.length).toBeGreaterThan(10);
    // Nest Logger lines (services, the error filter) reach the same log as the request lines.
    const entries = lines.map(
      (line) => JSON.parse(line) as { level: number; context?: string; msg?: string },
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ level: 40, context: 'AuthService', msg: 'Login failed: unknown account' }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({ level: 50, context: 'ErrorReporter', msg: 'Unhandled error' }),
    );
    // The failed insert's parameters (encrypted number, guest id, names) never reach the error report (6.6).
    const report = JSON.stringify(entries.filter((e) => e.context === 'ErrorReporter'));
    expect(report).toContain('params: [removed]');

    for (const secret of SECRETS) expect(output, secret).not.toContain(secret);
  });

  it('never logs a download link or the name of an uploaded identity scan (slice 6.2)', async () => {
    const created = await desk.post('/guests', { fullName: 'Scan Log Guest' });
    const guestId = created.body.data.id;
    const scanName = 'Scan Log Guest CNIC 35202-7654321-9.jpg';
    const scan = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(randomUUID())]);
    const uploaded = await desk.upload(
      `/guests/${guestId}/scans?fileName=${encodeURIComponent(scanName)}`,
      scan,
    );
    expect(uploaded.status).toBe(200);
    const scanId = uploaded.body.data.scans[0].id;
    const link = await desk.post(`/guests/${guestId}/scans/${scanId}/link`, { reason: 'Log check' });
    const token = (link.body.data.url as string).split('/').pop()!;
    expect((await desk.agent.get(link.body.data.url)).status).toBe(200);

    const output = log();
    expect(output).toContain('/files/[link]');
    expect(output).not.toContain(token);
    expect(output).not.toContain(token.split('.')[1]!);
    expect(output).not.toMatch(/Scan Log Guest CNIC|35202-7654321-9/);
  });
});
