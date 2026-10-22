import { createHash } from 'node:crypto';
import { Client } from 'pg';
import type { S3Client } from '../storage/s3';
import { keyId, sealBackup, type BackupManifest } from './backup-format';
import { runPgTool } from './pg-tools';
import { dailyKey, expired, LATEST_KEY, monthlyKey } from './retention';

/** What the last successful backup wrote to latest.json: the backup-age check (6.6) reads it. */
export interface LatestBackup {
  key: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  bytes: number;
  sha256: string;
  keyId: string;
  database: string;
  migrations: number;
  rows: number;
}

export interface BackupResult extends LatestBackup {
  monthlyCopy: string | null;
  deleted: string[];
}

/**
 * One backup (P6-7): a pg_dump of the whole database and the row count of every table, taken in the same
 * snapshot, encrypted (backup-format.ts) and stored in the backup bucket, which is separate from the application's
 * storage. Keeps a monthly copy of the month's first backup, records latest.json, then deletes what retention no
 * longer needs. Read-only on the database.
 */
export async function runBackup(opts: {
  adminUrl: string;
  storage: S3Client;
  publicKey: string;
  now?: Date;
}): Promise<BackupResult> {
  const startedAt = opts.now ?? new Date();
  const t0 = Date.now();
  const client = new Client({ connectionString: opts.adminUrl });
  await client.connect();
  let dump: Buffer;
  let manifest: Omit<BackupManifest, 'dumpBytes' | 'dumpSha256'>;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query<{ s: string }>('SELECT pg_export_snapshot() AS s')).rows[0]!.s;
    const info = (
      await client.query<{ db: string; version: string }>(
        'SELECT current_database() AS db, current_setting($1) AS version',
        ['server_version'],
      )
    ).rows[0]!;
    const tables = (
      await client.query<{ t: string }>(
        `SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      )
    ).rows.map((r) => r.t);
    const rowCounts: Record<string, number> = {};
    for (const t of tables) {
      const r = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM public.${client.escapeIdentifier(t)}`,
      );
      rowCounts[t] = Number(r.rows[0]!.n);
    }
    // Before the very first release there is nothing migrated yet; the backup is still taken.
    const migrated = (await client.query(`SELECT to_regclass('public.schema_migrations') IS NOT NULL AS t`))
      .rows[0].t as boolean;
    const migrations = migrated
      ? (await client.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map(
          (r) => r.name,
        )
      : [];
    // Same snapshot as the counts above, so the restore can check every table against them.
    dump = await runPgTool('pg_dump', ['--format=custom', `--snapshot=${snapshot}`], opts.adminUrl);
    manifest = {
      database: info.db,
      createdAt: startedAt.toISOString(),
      serverVersion: info.version,
      migrations,
      rowCounts,
    };
    await client.query('COMMIT');
  } finally {
    await client.end();
  }

  const file = sealBackup(
    dump,
    {
      ...manifest,
      dumpBytes: dump.length,
      dumpSha256: createHash('sha256').update(dump).digest('hex'),
    },
    opts.publicKey,
  );
  const key = dailyKey(startedAt);
  await opts.storage.put(key, file, 'application/octet-stream');

  // The month's first backup is also its monthly copy.
  const month = monthlyKey(startedAt);
  let monthlyCopy: string | null = null;
  if ((await opts.storage.list(month)).length === 0) {
    await opts.storage.put(month, file, 'application/octet-stream');
    monthlyCopy = month;
  }

  const latest: LatestBackup = {
    key,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    bytes: file.length,
    sha256: createHash('sha256').update(file).digest('hex'),
    keyId: keyId(opts.publicKey),
    database: manifest.database,
    migrations: manifest.migrations.length,
    rows: Object.values(manifest.rowCounts).reduce((a, b) => a + b, 0),
  };
  await opts.storage.put(LATEST_KEY, Buffer.from(JSON.stringify(latest, null, 2)), 'application/json');

  const all = (await opts.storage.list('')).map((o) => o.key);
  const deleted = expired(all, startedAt);
  for (const k of deleted) await opts.storage.delete(k);
  return { ...latest, monthlyCopy, deleted };
}
