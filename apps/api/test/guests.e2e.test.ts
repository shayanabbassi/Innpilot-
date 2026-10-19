import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser, startHarness, type BrowserClient, type Harness } from './harness';

// Fictional identity data only.
const CNIC = '35202-1234567-1';
const CNIC_DIGITS = '3520212345671';

let h: Harness;
let desk: BrowserClient;
let guestId: string;
let documentId: string;

beforeAll(async () => {
  h = await startHarness();
  desk = await browser(h).loginActive(h.fx.users.deskA);
});

afterAll(async () => {
  await h?.close();
});

const del = (c: BrowserClient, path: string) =>
  c.agent.delete(`/api/v1${path}`).set('origin', 'http://localhost:3000').set('x-csrf-token', c.csrf);

describe('guest profiles', () => {
  it('creates a guest with an identity document, returning only the last 4 characters', async () => {
    const res = await desk.post('/guests', {
      fullName: 'Muhammad Ali Demo',
      phone: '0300 1234567',
      email: 'Ali.Demo@Example.TEST',
      nationality: 'pk',
      document: { documentType: 'cnic', issuingCountry: 'PK', number: CNIC },
    });
    expect(res.status).toBe(201);
    guestId = res.body.data.id;
    documentId = res.body.data.documents[0].id;
    expect(res.body.data).toMatchObject({
      email: 'ali.demo@example.test',
      nationality: 'PK',
      documentCount: 1,
      documents: [{ documentType: 'cnic', issuingCountry: 'PK', last4: '5671' }],
    });
    expect(JSON.stringify(res.body)).not.toContain(CNIC_DIGITS);
  });

  it('stores the number only encrypted, with a lookup hash', async () => {
    const { rows } = await h.admin.query(
      'SELECT number_enc, number_hmac, number_last4 FROM guest_documents WHERE id = $1',
      [documentId],
    );
    expect(rows[0].number_enc).toMatch(/^v1\./);
    expect(rows[0].number_enc).not.toContain(CNIC_DIGITS);
    expect(rows[0].number_hmac).toHaveLength(32);
    expect(rows[0].number_hmac.toString('hex')).not.toContain(Buffer.from(CNIC_DIGITS).toString('hex'));
  });

  it('finds the guest by fuzzy name, any phone format and email — without document data', async () => {
    for (const search of ['Mohammad Ali', '+92 300 1234567', '3001234567', 'ali.demo@example.test']) {
      const res = await desk.get(`/guests?search=${encodeURIComponent(search)}`);
      expect(res.status, search).toBe(200);
      expect(
        res.body.data.map((g: { id: string }) => g.id),
        search,
      ).toContain(guestId);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/last4|documents|number/);
    }
  });

  it('treats LIKE wildcards in a search as plain text', async () => {
    const res = await desk.get(`/guests?search=${encodeURIComponent('%')}`);
    expect(res.body.data).toEqual([]);
  });

  it('flags likely duplicates by phone, document and similar name', async () => {
    const byPhone = await desk.post('/guests/duplicate-check', { phone: '+923001234567' });
    expect(byPhone.body.data[0]).toMatchObject({ id: guestId, reasons: ['phone'] });

    const byDocument = await desk.post('/guests/duplicate-check', {
      document: { documentType: 'cnic', number: '3520212345671' },
    });
    expect(byDocument.body.data[0].reasons).toContain('document');

    const byName = await desk.post('/guests/duplicate-check', { fullName: 'Muhamad Ali Demo' });
    expect(byName.body.data[0]).toMatchObject({ id: guestId, reasons: ['name'] });

    const self = await desk.post('/guests/duplicate-check', {
      phone: '03001234567',
      excludeGuestId: guestId,
    });
    expect(self.body.data).toEqual([]);
  });

  it('records which fields changed, never their values', async () => {
    const res = await desk.patch(`/guests/${guestId}`, { phone: '0321 7654321', city: 'Lahore' });
    expect(res.status).toBe(200);
    const audit = await h.admin.query(
      `SELECT changes FROM audit_events WHERE entity_id = $1 AND action = 'guest.updated'`,
      [guestId],
    );
    expect(audit.rows[0].changes).toEqual({ fields: ['phone', 'city'] });
    expect(JSON.stringify(audit.rows)).not.toContain('7654321');
  });
});

describe('identity document access', () => {
  it('hides documents from roles without identity access, and refuses reveal and add', async () => {
    const auditor = await browser(h).loginActive(h.fx.users.auditorA);
    const res = await auditor.get(`/guests/${guestId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ documentCount: 1, documents: null });
    expect(
      (await auditor.post(`/guests/${guestId}/documents/${documentId}/reveal`, { reason: 'curious' })).status,
    ).toBe(403);
    expect(
      (
        await auditor.post(`/guests/${guestId}/documents`, {
          documentType: 'passport',
          issuingCountry: 'GB',
          number: 'AB1234567',
        })
      ).status,
    ).toBe(403);
  });

  it('reveals one number with a reason and audits the reveal without the number', async () => {
    const noReason = await desk.post(`/guests/${guestId}/documents/${documentId}/reveal`, {});
    expect(noReason.status).toBe(400);

    const res = await desk.post(`/guests/${guestId}/documents/${documentId}/reveal`, {
      reason: 'Verifying identity at check-in',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: documentId, number: CNIC_DIGITS });

    const audit = await h.admin.query(
      `SELECT reason, changes FROM audit_events WHERE entity_id = $1 AND action = 'guest.document_revealed'`,
      [guestId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].reason).toBe('Verifying identity at check-in');
    const everything = await h.admin.query('SELECT changes, reason FROM audit_events WHERE tenant_id = $1', [
      h.fx.tenantA,
    ]);
    expect(JSON.stringify(everything.rows)).not.toContain(CNIC_DIGITS);
  });

  it('removes a document with an audit event', async () => {
    const res = await del(desk, `/guests/${guestId}/documents/${documentId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ documentCount: 0, documents: [] });
    const { rows } = await h.admin.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND action = 'guest.document_removed'`,
      [guestId],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('guest permissions and isolation', () => {
  it('keeps housekeeping out of guest data entirely', async () => {
    const hk = await browser(h).loginActive(h.fx.users.housekeepingA);
    expect((await hk.get('/guests')).status).toBe(403);
    expect((await hk.get(`/guests/${guestId}`)).status).toBe(403);
  });

  it("hides one tenant's guests from another, including via duplicate checks", async () => {
    const ownerB = await browser(h).loginActive(h.fx.users.ownerB);
    expect((await ownerB.get(`/guests/${guestId}`)).status).toBe(404);
    expect((await ownerB.patch(`/guests/${guestId}`, { city: 'X' })).status).toBe(404);
    expect((await ownerB.get('/guests?search=Muhammad')).body.data).toEqual([]);
    expect((await ownerB.post('/guests/duplicate-check', { phone: '03217654321' })).body.data).toEqual([]);
  });
});
