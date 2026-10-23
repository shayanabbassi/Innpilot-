import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { provisionAppRole, readMigrations } from '@innpilot/db';
import { Client } from 'pg';
import { createApp } from '../bootstrap';
import { loadConfig } from '../config';
import type { S3Client } from '../storage/s3';
import { openBackup, type BackupManifest } from './backup-format';
import type { LatestBackup } from './backup';
import { runIntegrityChecks, type CheckResult } from './integrity';
import { runPgTool } from './pg-tools';
import { LATEST_KEY, stamp } from './retention';

export interface DrillReport {
  ok: boolean;
  backupKey: string;
  backupCreatedAt: string;
  restoredDatabase: string;
  kept: boolean;
  steps: { name: string; ms: number }[];
  checks: CheckResult[];
  totalMs: number;
}

export interface DrillOptions {
  /** Database owner on the server to restore into (needs CREATEDB). */
  adminUrl: string;
  storage: S3Client;
  privateKey: string;
  /** A specific backup object; default: the one latest.json names. */
  key?: string;
  /**
   * The application's connection, used for the sign-in check against the restored copy (its database name is
   * replaced). If the role does not exist on the server yet, it is created with appPassword.
   */
  appUrl: string;
  appPassword?: string;
  /** An account in the backup to sign in with; without one the sign-in check is reported as not run. */
  signIn?: { email: string; password: string };
  /** The application's other settings (keys, storage) for the in-process API; DATABASE_URL is replaced. */
  appEnv: NodeJS.ProcessEnv;
  /** Keep the restored database for inspection instead of dropping it. */
  keep?: boolean;
}

/**
 * The restore drill (P6-8): "a backup is not proven until restoration has been tested". Takes a backup from the
 * backup bucket, checks and decrypts it, restores it into a new, isolated database (never over a live one), runs
 * the integrity checks and a real sign-in through the API against it, then drops it. Every step is timed for the
 * RTO record (target 4 hours).
 */
export async function runRestoreDrill(opts: DrillOptions): Promise<DrillReport> {
  const t0 = Date.now();
  const steps: DrillReport['steps'] = [];
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const s = Date.now();
    const out = await fn();
    steps.push({ name, ms: Date.now() - s });
    return out;
  };

  const { file, key, expectedSha } = await timed('Download the backup', async () => {
    const latestRaw = await opts.storage.get(LATEST_KEY);
    const latest = latestRaw ? (JSON.parse(latestRaw.toString('utf8')) as LatestBackup) : null;
    const key = opts.key ?? latest?.key;
    if (!key) throw new Error('No backup to restore: latest.json is missing and no key was given.');
    const file = await opts.storage.get(key);
    if (!file) throw new Error(`Backup ${key} is not in the bucket.`);
    return { file, key, expectedSha: latest?.key === key ? latest.sha256 : null };
  });

  const { dump, manifest } = await timed('Check and decrypt', async () => {
    if (expectedSha && createHash('sha256').update(file).digest('hex') !== expectedSha) {
      throw new Error(`Backup ${key} does not match the checksum recorded when it was made.`);
    }
    return openBackup(file, opts.privateKey);
  });

  const target = `innpilot_restore_${stamp(new Date()).toLowerCase()}`;
  const admin = new Client({ connectionString: opts.adminUrl });
  await admin.connect();
  let checks: CheckResult[] = [];
  try {
    await timed('Create an isolated database', async () => {
      // Only on a server without the role (e.g. a fresh drill server): never change a live role's password.
      const role = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = 'innpilot_app'`);
      if (role.rowCount === 0) {
        if (!opts.appPassword) throw new Error('The innpilot_app role is missing: give APP_DB_PASSWORD.');
        await provisionAppRole(opts.adminUrl, opts.appPassword);
      }
      await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(target)}`);
    });
    const targetAdminUrl = withDatabase(opts.adminUrl, target);
    await timed('Restore', () =>
      runPgTool('pg_restore', ['--exit-on-error', '--no-owner', `--dbname=${target}`], targetAdminUrl, dump),
    );
    checks = await timed('Integrity checks', async () => {
      const db = new Client({ connectionString: targetAdminUrl });
      await db.connect();
      try {
        const release = readMigrations().map(({ name, checksum }) => ({ name, checksum }));
        return await runIntegrityChecks(db, manifest, release);
      } finally {
        await db.end();
      }
    });
    checks.push(
      await timed('Sign-in check', () =>
        signInCheck(withDatabase(opts.appUrl, target), opts.appEnv, opts.signIn, manifest),
      ),
    );
  } finally {
    if (!opts.keep) {
      await timed('Drop the restored database', async () => {
        await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(target)} WITH (FORCE)`);
      });
    }
    await admin.end();
  }
  return {
    ok: checks.length > 0 && checks.every((c) => c.ok),
    backupKey: key,
    backupCreatedAt: manifest.createdAt,
    restoredDatabase: target,
    kept: !!opts.keep,
    steps,
    checks,
    totalMs: Date.now() - t0,
  };
}

/** Starts the real API against the restored database and signs in, as a user would. */
async function signInCheck(
  appUrl: string,
  env: NodeJS.ProcessEnv,
  account: DrillOptions['signIn'],
  manifest: BackupManifest,
): Promise<CheckResult> {
  const name = 'A user can sign in to the restored copy';
  if (!account) {
    return { name, ok: false, detail: 'not run: no sign-in account given (DRILL_SIGNIN_EMAIL / _PASSWORD)' };
  }
  const config = loadConfig({
    ...env,
    DATABASE_URL: appUrl,
    // Local http to an in-process server; the drill never serves anyone else.
    NODE_ENV: 'test',
    COOKIE_SECURE: 'false',
    WEB_ORIGINS: 'http://drill.invalid',
    LOG_LEVEL: 'silent',
    JOBS_POLL_SECONDS: '0',
  });
  const app = await createApp(config, { logger: false });
  await app.listen(0, '127.0.0.1');
  try {
    const port = (app.getHttpServer().address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://drill.invalid' },
      body: JSON.stringify({ email: account.email, password: account.password }),
    });
    const body = (await res.json()) as { data?: { sessionState?: string }; error?: { code?: string } };
    return res.status === 200
      ? {
          name,
          ok: true,
          detail: `signed in (session state ${body.data?.sessionState}), ${manifest.database} copy`,
        }
      : { name, ok: false, detail: `sign-in answered ${res.status} ${body.error?.code ?? ''}`.trim() };
  } finally {
    await app.close();
  }
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** The drill report as Markdown, for the drill record. */
export function drillMarkdown(r: DrillReport, title: string): string {
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  return [
    `### ${title}`,
    '',
    `Backup \`${r.backupKey}\` (made ${r.backupCreatedAt}) restored into \`${r.restoredDatabase}\`` +
      `${r.kept ? ' (kept)' : ' (dropped afterwards)'}. **${r.ok ? 'Passed' : 'FAILED'}** in ${sec(r.totalMs)}.`,
    '',
    '| Step | Time |',
    '| --- | --- |',
    ...r.steps.map((s) => `| ${s.name} | ${sec(s.ms)} |`),
    '',
    '| Check | Result | Detail |',
    '| --- | --- | --- |',
    ...r.checks.map((c) => `| ${c.name} | ${c.ok ? 'ok' : '**failed**'} | ${c.detail} |`),
    '',
  ].join('\n');
}
