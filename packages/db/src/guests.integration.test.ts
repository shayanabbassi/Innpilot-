import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let admin: Client;
const ids = { a: '', b: '', guestB: '' };

beforeAll(async () => {
  testDb = await createTestDatabase();
  admin = new Client({ connectionString: testDb.adminUrl });
  await admin.connect();
  const tenant = async (slug: string) =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO tenants (slug, legal_name, display_name) VALUES ($1::text, $1::text, $1::text) RETURNING id`,
        [slug],
      )
    ).rows[0]!.id;
  ids.a = await tenant('guests-a');
  ids.b = await tenant('guests-b');
  ids.guestB = (
    await admin.query<{ id: string }>(
      `INSERT INTO guests (tenant_id, full_name) VALUES ($1, 'Guest B') RETURNING id`,
      [ids.b],
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await admin?.end();
  await testDb?.drop();
});

const doc = (tenantId: string, guestId: string, enc = 'v1.a.b.c') =>
  admin.query(
    `INSERT INTO guest_documents (tenant_id, guest_id, document_type, issuing_country, number_enc, number_hmac, number_last4)
     VALUES ($1, $2, 'cnic', 'PK', $3, $4, '4567') RETURNING id`,
    [tenantId, guestId, enc, Buffer.alloc(32, 1)],
  );

describe('guest schema', () => {
  it("refuses a document attached to another tenant's guest", async () => {
    await expect(doc(ids.a, ids.guestB)).rejects.toThrow(/foreign key/);
  });

  it('refuses a document number that is not in the encrypted format', async () => {
    await expect(doc(ids.b, ids.guestB, '3520212345671')).rejects.toThrow(/check constraint/);
  });

  it('never updates a document row in place', async () => {
    const { rows } = await doc(ids.b, ids.guestB);
    await expect(
      admin.query(`UPDATE guest_documents SET number_last4 = '0000' WHERE id = $1`, [rows[0].id]),
    ).rejects.toThrow(/not allowed/);
  });

  it('keeps phone and its normalised key together', async () => {
    await expect(
      admin.query(`INSERT INTO guests (tenant_id, full_name, phone) VALUES ($1, 'X', '0300 1234567')`, [
        ids.a,
      ]),
    ).rejects.toThrow(/check constraint/);
  });
});
