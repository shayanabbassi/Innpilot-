/**
 * Phase 6 slice 6.5 — backups and the restore drill, against real PostgreSQL and object storage.
 *
 * A backup is a pg_dump plus row counts from the same snapshot, encrypted to the backup public key and stored in
 * its own bucket with a monthly copy and latest.json; retention deletes what is no longer kept. The drill restores
 * it into a new database, runs the integrity checks and a real sign-in, and drops it. The checks catch damage; a
 * changed backup or the wrong key stops the drill.
 */
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBackup } from '../src/ops/backup';
import { generateBackupKeys, openBackup, readManifest } from '../src/ops/backup-format';
import { runIntegrityChecks } from '../src/ops/integrity';
import { runRestoreDrill, type DrillOptions } from '../src/ops/restore';
import { dailyKey, LATEST_KEY } from '../src/ops/retention';
import { S3Client } from '../src/storage/s3';
import { readMigrations } from '@innpilot/db';
import { browser, MFA_KEY, ORIGIN, PASSWORD, PII_KEY, startHarness, type Harness } from './harness';

let h: Harness;
const keys = generateBackupKeys();
const storage = new S3Client(
  {
    endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:7070',
    region: 'us-east-1',
    bucket: 'innpilot-test-backups',
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
  },
  120_000,
);

const drillOptions = (over: Partial<DrillOptions> = {}): DrillOptions => ({
  adminUrl: h.db.adminUrl,
  storage,
  privateKey: keys.privateKey,
  appUrl: h.db.appUrl,
  signIn: { email: h.fx.users.ownerA.email, password: PASSWORD },
  appEnv: {
    MFA_ENCRYPTION_KEY: MFA_KEY.toString('base64url'),
    PII_ENCRYPTION_KEY: PII_KEY.toString('base64url'),
    RATE_LIMIT_ENABLED: 'false',
    STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:7070',
    STORAGE_BUCKET: 'innpilot-test',
    STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID,
    STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY,
  },
  ...over,
});

const databases = async () =>
  (
    await h.admin.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'innpilot_restore_%'`,
    )
  ).rows.map((r) => r.datname);

beforeAll(async () => {
  h = await startHarness();
  if (!(await storage.bucketExists())) await storage.createBucket();
  for (const o of await storage.list('')) await storage.delete(o.key);
  // Some real activity in tenant A: a posted journal through the API.
  const acc = await browser(h).loginActive(h.fx.users.accountantA);
  const account: Record<string, string> = {};
  for (const a of (await acc.get('/finance/accounts')).body.data) account[a.code] = a.id;
  const post = (path: string, body: object = {}) =>
    acc.agent
      .post(`/api/v1${path}`)
      .set('origin', ORIGIN)
      .set('x-csrf-token', acc.csrf)
      .set('idempotency-key', randomUUID())
      .send(body);
  const draft = await post('/finance/journal-entries/draft', {
    propertyId: h.fx.propA1,
    narration: 'Backup test revenue',
    accountingDate: '2026-10-10',
    lines: [
      { accountId: account['1100'], debit: '4321.00' },
      { accountId: account['4000'], credit: '4321.00' },
    ],
  });
  if (draft.status !== 201) throw new Error(JSON.stringify(draft.body));
  await post(`/finance/journal-entries/${draft.body.data.id}/post`);
}, 120_000);

afterAll(async () => {
  for (const d of await databases()) await h.admin.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
  await h?.close();
});

describe('backup', () => {
  it('stores an encrypted dump with its manifest, a monthly copy and latest.json', async () => {
    const r = await runBackup({ adminUrl: h.db.adminUrl, storage, publicKey: keys.publicKey });
    expect(r.key).toMatch(/^daily\/\d{8}T\d{6}Z\.ipbk$/);
    expect(r.monthlyCopy).toMatch(/^monthly\/\d{4}-\d{2}\.ipbk$/);
    const file = (await storage.get(r.key))!;
    expect(file.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(file.toString('latin1')).not.toMatch(/Backup test revenue|owner@a\.test/);
    const manifest = readManifest(file);
    expect(manifest.database).toBe(h.db.name);
    expect(manifest.migrations).toEqual(readMigrations().map((m) => m.name));
    expect(manifest.rowCounts).toMatchObject({ tenants: 2, properties: 3 });
    expect(manifest.rowCounts.journal_lines).toBeGreaterThan(0);
    const { dump } = openBackup(file, keys.privateKey);
    expect(dump.subarray(0, 5).toString()).toBe('PGDMP');
    const latest = JSON.parse((await storage.get(LATEST_KEY))!.toString());
    expect(latest).toMatchObject({ key: r.key, bytes: file.length, migrations: manifest.migrations.length });
    // The second backup of the month does not replace the monthly copy.
    const again = await runBackup({
      adminUrl: h.db.adminUrl,
      storage,
      publicKey: keys.publicKey,
      now: new Date(Date.now() + 1000),
    });
    expect(again.monthlyCopy).toBeNull();
  });

  it('deletes nightly backups older than 35 days, never the newest', async () => {
    const old = dailyKey(new Date(Date.now() - 40 * 86_400_000));
    const recent = dailyKey(new Date(Date.now() - 5 * 86_400_000));
    await storage.put(old, Buffer.from('old'), 'application/octet-stream');
    await storage.put(recent, Buffer.from('recent'), 'application/octet-stream');
    const r = await runBackup({
      adminUrl: h.db.adminUrl,
      storage,
      publicKey: keys.publicKey,
      now: new Date(Date.now() + 2000),
    });
    expect(r.deleted).toEqual([old]);
    const keysLeft = (await storage.list('daily/')).map((o) => o.key);
    expect(keysLeft).toContain(recent);
    expect(keysLeft).toContain(r.key);
  });
});

describe('restore drill', () => {
  it('restores into a new database, passes every check, signs in, and drops it', async () => {
    const report = await runRestoreDrill(drillOptions());
    expect(report.checks.map((c) => [c.name, c.ok])).toEqual([
      ['Migrations at the expected version', true],
      ['Every table has the rows it had when backed up', true],
      ["Every tenant's trial balance balances", true],
      ['Folio balances equal their ledger lines', true],
      ['Cash and bank accounts equal their ledger accounts', true],
      ['Audit log intact and append-only', true],
      ['Row-level security on every tenant table', true],
      ['A user can sign in to the restored copy', true],
    ]);
    expect(report.ok).toBe(true);
    expect(report.steps.map((s) => s.name)).toEqual([
      'Download the backup',
      'Check and decrypt',
      'Create an isolated database',
      'Restore',
      'Integrity checks',
      'Sign-in check',
      'Drop the restored database',
    ]);
    expect(report.restoredDatabase).not.toBe(h.db.name);
    expect(await databases()).toEqual([]);
  });

  it('catches damage in a restored database', async () => {
    // No sign-in: it writes a session and an audit event into the copy, which would blur exact row counts here.
    const report = await runRestoreDrill(drillOptions({ keep: true, signIn: undefined }));
    expect(report.checks.slice(0, -1).every((c) => c.ok)).toBe(true);
    const restored = new Client({ connectionString: withDb(h.db.adminUrl, report.restoredDatabase) });
    await restored.connect();
    try {
      // Damage that bypasses the application's guards: an unbalanced line, and a lost audit event.
      await restored.query('SET session_replication_role = replica');
      await restored.query(
        `INSERT INTO journal_lines (tenant_id, journal_entry_id, line_no, account_id, debit, credit)
         SELECT tenant_id, journal_entry_id, 99, account_id, 1, 0 FROM journal_lines
         WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE status = 'posted') LIMIT 1`,
      );
      await restored.query(`DELETE FROM audit_events WHERE ctid = (SELECT ctid FROM audit_events LIMIT 1)`);
      await restored.query('SET session_replication_role = origin');
      const file = (await storage.get(report.backupKey))!;
      const checks = await runIntegrityChecks(
        restored,
        readManifest(file),
        readMigrations().map(({ name, checksum }) => ({ name, checksum })),
      );
      const failed = checks.filter((c) => !c.ok).map((c) => c.name);
      expect(failed).toEqual([
        'Every table has the rows it had when backed up',
        "Every tenant's trial balance balances",
        // The injected line is on the bank's ledger account without the bank account: caught too.
        'Cash and bank accounts equal their ledger accounts',
        'Audit log intact and append-only',
      ]);
    } finally {
      await restored.end();
      await h.admin.query(`DROP DATABASE "${report.restoredDatabase}" WITH (FORCE)`);
    }
  });

  it('refuses a backup that was changed, or the wrong key', async () => {
    const latest = JSON.parse((await storage.get(LATEST_KEY))!.toString()) as { key: string };
    const file = (await storage.get(latest.key))!;
    await expect(
      runRestoreDrill(drillOptions({ privateKey: generateBackupKeys().privateKey })),
    ).rejects.toThrow();
    const changed = Buffer.from(file);
    changed[changed.length - 50]! ^= 1;
    await storage.put(latest.key, changed, 'application/octet-stream');
    try {
      await expect(runRestoreDrill(drillOptions())).rejects.toThrow(/does not match the checksum/);
    } finally {
      await storage.put(latest.key, file, 'application/octet-stream');
    }
    expect(await databases()).toEqual([]);
  });

  it('reports the sign-in check as not run without an account', async () => {
    const report = await runRestoreDrill(drillOptions({ signIn: undefined }));
    expect(report.ok).toBe(false);
    expect(report.checks.at(-1)).toMatchObject({ ok: false, detail: expect.stringMatching(/^not run/) });
  });
});

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
