/* eslint-disable no-console -- command-line entry point */
import { writeFileSync } from 'node:fs';
import { loadRootEnv } from '@innpilot/db';
import { z } from 'zod';
import { S3Client } from '../storage/s3';
import { recordBackupRun, runBackup } from './backup';
import { generateBackupKeys, keyId } from './backup-format';
import { drillMarkdown, runRestoreDrill } from './restore';

/**
 * Backup and restore commands (slice 6.5). In the API image: `node dist/ops/cli.js <command>`.
 *
 *   keygen          print a new backup key pair (public key to the backup job, private key kept offline)
 *   backup          one encrypted backup now, then retention
 *   schedule        run `backup` every day at BACKUP_AT_UTC (HH:MM), forever
 *   restore-drill   restore the latest (or --key) backup into a new database, check it, drop it
 *                   [--key daily/...] [--keep] [--report drill.md]
 *   ensure-buckets  create the application bucket (STORAGE_*) and the backup bucket (BACKUP_*) if missing: first
 *                   set-up where the provider has not made them already
 */

const storageSettings = z.object({
  BACKUP_STORAGE_ENDPOINT: z.string().url(),
  BACKUP_STORAGE_REGION: z.string().min(1).default('us-east-1'),
  BACKUP_BUCKET: z.string().min(3),
  BACKUP_ACCESS_KEY_ID: z.string().min(3),
  BACKUP_SECRET_ACCESS_KEY: z.string().min(8),
  DATABASE_ADMIN_URL: z.string().url(),
});

function settings<T extends z.ZodRawShape>(extra: T) {
  const parsed = storageSettings.extend(extra).safeParse(process.env);
  if (!parsed.success) {
    console.error(
      `Missing or invalid settings:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`,
    );
    process.exit(2);
  }
  return parsed.data;
}

function bucket(s: z.infer<typeof storageSettings>): S3Client {
  return new S3Client(
    {
      endpoint: s.BACKUP_STORAGE_ENDPOINT.replace(/\/+$/, ''),
      region: s.BACKUP_STORAGE_REGION,
      bucket: s.BACKUP_BUCKET,
      accessKeyId: s.BACKUP_ACCESS_KEY_ID,
      secretAccessKey: s.BACKUP_SECRET_ACCESS_KEY,
    },
    // Large objects: minutes, not seconds.
    15 * 60_000,
  );
}

const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...data }));

async function backupOnce(): Promise<void> {
  const s = settings({ BACKUP_PUBLIC_KEY: z.string().min(100) });
  const storage = bucket(s);
  if (!(await storage.bucketExists())) {
    // Production buckets are created with the provider (separate account, locked down); only the local stack
    // asks for one to be made.
    if (process.env.BACKUP_CREATE_BUCKET !== 'true') {
      throw new Error(`Backup bucket ${s.BACKUP_BUCKET} does not exist.`);
    }
    await storage.createBucket();
  }
  log('backup.started');
  const startedAt = new Date();
  try {
    const r = await runBackup({
      adminUrl: s.DATABASE_ADMIN_URL,
      storage,
      publicKey: s.BACKUP_PUBLIC_KEY,
      now: startedAt,
    });
    await recordBackupRun(s.DATABASE_ADMIN_URL, { startedAt, ok: true, key: r.key, bytes: r.bytes }).catch(
      (err: unknown) =>
        log('backup.record_failed', { error: err instanceof Error ? err.message : String(err) }),
    );
    log('backup.finished', { ...r });
  } catch (err) {
    // The reason is recorded for the backup-failure alert; connection strings never reach it (pg-tools strips the
    // password, and the URL itself is never part of an error message here).
    const reason = err instanceof Error ? err.message : String(err);
    await recordBackupRun(s.DATABASE_ADMIN_URL, { startedAt, ok: false, error: reason }).catch(
      () => undefined,
    );
    throw err;
  }
}

async function ensureBuckets(): Promise<void> {
  const app = z
    .object({
      STORAGE_ENDPOINT: z.string().url(),
      STORAGE_REGION: z.string().default('us-east-1'),
      STORAGE_BUCKET: z.string().min(3),
      STORAGE_ACCESS_KEY_ID: z.string().min(3),
      STORAGE_SECRET_ACCESS_KEY: z.string().min(8),
    })
    .parse(process.env);
  const targets: [string, S3Client][] = [
    [
      app.STORAGE_BUCKET,
      new S3Client({
        endpoint: app.STORAGE_ENDPOINT.replace(/\/+$/, ''),
        region: app.STORAGE_REGION,
        bucket: app.STORAGE_BUCKET,
        accessKeyId: app.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: app.STORAGE_SECRET_ACCESS_KEY,
      }),
    ],
  ];
  if (process.env.BACKUP_BUCKET) {
    const s = settings({});
    targets.push([s.BACKUP_BUCKET, bucket(s)]);
  }
  for (const [name, client] of targets) {
    if (await client.bucketExists()) {
      log('bucket.exists', { bucket: name });
    } else {
      await client.createBucket();
      log('bucket.created', { bucket: name });
    }
  }
}

/** Milliseconds until the next HH:MM UTC. */
function untilNext(at: string, now = new Date()): number {
  const [h, m] = at.split(':').map(Number) as [number, number];
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

async function schedule(): Promise<void> {
  const s = settings({
    BACKUP_PUBLIC_KEY: z.string().min(100),
    // 21:00 UTC is 02:00 in Pakistan: after the night audit, before the morning.
    BACKUP_AT_UTC: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .default('21:00'),
  });
  for (;;) {
    const wait = untilNext(s.BACKUP_AT_UTC);
    log('backup.scheduled', { at: new Date(Date.now() + wait).toISOString() });
    await new Promise((r) => setTimeout(r, wait));
    // A failed night is logged and retried the next night; the backup-age alert (6.6) catches a gap.
    await backupOnce().catch((err: unknown) =>
      log('backup.failed', { error: err instanceof Error ? err.message : String(err) }),
    );
  }
}

async function drill(args: string[]): Promise<void> {
  const s = settings({
    BACKUP_PRIVATE_KEY: z.string().min(100),
    DATABASE_URL: z.string().url(),
    APP_DB_PASSWORD: z.string().optional(),
    DRILL_SIGNIN_EMAIL: z.string().optional(),
    DRILL_SIGNIN_PASSWORD: z.string().optional(),
  });
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? (args[i + 1] ?? '') : undefined;
  };
  const report = await runRestoreDrill({
    adminUrl: s.DATABASE_ADMIN_URL,
    storage: bucket(s),
    privateKey: s.BACKUP_PRIVATE_KEY,
    key: flag('--key'),
    keep: args.includes('--keep'),
    appUrl: s.DATABASE_URL,
    appPassword: s.APP_DB_PASSWORD,
    signIn:
      s.DRILL_SIGNIN_EMAIL && s.DRILL_SIGNIN_PASSWORD
        ? { email: s.DRILL_SIGNIN_EMAIL, password: s.DRILL_SIGNIN_PASSWORD }
        : undefined,
    appEnv: process.env,
  });
  const md = drillMarkdown(report, `Restore drill ${new Date().toISOString()}`);
  console.log(md);
  const out = flag('--report');
  if (out) writeFileSync(out, md);
  process.exit(report.ok ? 0 : 1);
}

async function main(command: string | undefined, rest: string[]): Promise<void> {
  loadRootEnv();
  switch (command) {
    case 'keygen': {
      const keys = generateBackupKeys();
      console.log('# Backup key pair. BACKUP_PUBLIC_KEY goes to the backup job.');
      console.log(
        '# BACKUP_PRIVATE_KEY restores backups: store it offline (password manager, printed copy in a',
      );
      console.log(
        '# safe). Without it no backup can be restored; with it anyone holding a backup can read it.',
      );
      console.log(`# Key id: ${keyId(keys.publicKey)}`);
      console.log(`BACKUP_PUBLIC_KEY=${keys.publicKey}`);
      console.log(`BACKUP_PRIVATE_KEY=${keys.privateKey}`);
      return;
    }
    case 'ensure-buckets':
      return ensureBuckets();
    case 'backup':
      return backupOnce();
    case 'schedule':
      return schedule();
    case 'restore-drill':
      return drill(rest);
    default:
      console.error('Usage: node dist/ops/cli.js <keygen|backup|schedule|restore-drill>');
      process.exit(2);
  }
}

main(process.argv[2], process.argv.slice(3)).catch((err: unknown) => {
  log('ops.failed', { command: process.argv[2], error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
