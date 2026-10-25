/**
 * Phase 6 slice 6.5 (P6-8): the restore drill on the 100-room year. Backs the seeded database up the way the
 * nightly job does, then runs the full drill (download, decrypt, restore into a new database, integrity checks,
 * sign-in, drop) and prints the timed report for docs/backup-and-restore.md. Run with
 * `pnpm --filter @innpilot/api test:perf restore-drill`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runBackup } from '../src/ops/backup';
import { generateBackupKeys } from '../src/ops/backup-format';
import { drillMarkdown, runRestoreDrill } from '../src/ops/restore';
import { S3Client } from '../src/storage/s3';
import { browser, MFA_KEY, PASSWORD, PII_KEY, startHarness, type Harness } from '../test/harness';
import { seedHundredRoomYear, type Seeded } from './hundred-rooms';

let h: Harness;
let seeded: Seeded;
const keys = generateBackupKeys();
const storage = new S3Client(
  {
    endpoint: process.env.STORAGE_ENDPOINT ?? 'http://localhost:7070',
    region: 'us-east-1',
    bucket: 'innpilot-perf-backups',
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
  },
  15 * 60_000,
);

beforeAll(async () => {
  h = await startHarness();
  seeded = await seedHundredRoomYear(h, await browser(h).loginActive(h.fx.users.ownerA));
  if (!(await storage.bucketExists())) await storage.createBucket();
  for (const o of await storage.list('')) await storage.delete(o.key);
}, 900_000);

afterAll(async () => {
  await h?.close();
});

describe('restore drill, 100 rooms and a year of activity', () => {
  it('backs up, restores into a new database, passes every check and signs in', async () => {
    const backup = await runBackup({ adminUrl: h.db.adminUrl, storage, publicKey: keys.publicKey });
    const report = await runRestoreDrill({
      adminUrl: h.db.adminUrl,
      storage,
      privateKey: keys.privateKey,
      appUrl: h.db.appUrl,
      signIn: { email: h.fx.users.ownerA.email, password: PASSWORD },
      appEnv: {
        MFA_ENCRYPTION_KEY: MFA_KEY.toString('base64url'),
        PII_ENCRYPTION_KEY: PII_KEY.toString('base64url'),
        STORAGE_ENDPOINT: process.env.STORAGE_ENDPOINT ?? 'http://localhost:7070',
        STORAGE_BUCKET: 'innpilot-test',
        STORAGE_ACCESS_KEY_ID: process.env.STORAGE_ACCESS_KEY_ID,
        STORAGE_SECRET_ACCESS_KEY: process.env.STORAGE_SECRET_ACCESS_KEY,
      },
    });
    const md = [
      `Dataset: ${seeded.reservations.toLocaleString('en')} reservations, ${seeded.roomNights.toLocaleString('en')} room nights, ` +
        `${seeded.journals.toLocaleString('en')} journals (${seeded.lines.toLocaleString('en')} lines), ` +
        `${seeded.auditEvents.toLocaleString('en')} audit events.`,
      `Backup: ${(backup.bytes / 1024 / 1024).toFixed(1)} MB encrypted, ${backup.rows.toLocaleString('en')} rows, ` +
        `made in ${(backup.durationMs / 1000).toFixed(1)} s.`,
      '',
      drillMarkdown(report, 'Restore drill, 100-room year'),
    ].join('\n');
    process.stdout.write(`${md}\n`);
    writeFileSync(join(__dirname, 'restore-drill.last.md'), md);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
