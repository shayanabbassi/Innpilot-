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

    // The log is real and covers these requests, so an empty or disabled log cannot pass.
    const output = log();
    expect(output).toContain('/api/v1/guests/duplicate-check');
    expect(output).toContain('/walk-ins');
    expect(lines.length).toBeGreaterThan(10);

    for (const secret of SECRETS) expect(output, secret).not.toContain(secret);
  });
});
