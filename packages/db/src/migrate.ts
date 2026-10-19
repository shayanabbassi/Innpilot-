import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

export const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;
// Arbitrary constant so concurrent deploys never apply migrations at the same time.
const LOCK_ID = 7_202_610_19;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  return names.map((name) => {
    if (!FILE_PATTERN.test(name))
      throw new Error(`Migration file name "${name}" must look like 0001_name.sql`);
    // Normalise line endings so a Windows checkout produces the same checksum as CI.
    const sql = readFileSync(join(dir, name), 'utf8').replace(/\r\n/g, '\n');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

/**
 * Applies pending migrations in order, each in its own transaction. Already-applied migrations
 * must be unchanged: editing a shipped migration is an error, write a new one instead.
 */
export async function migrate(adminUrl: string, dir = MIGRATIONS_DIR): Promise<MigrationResult> {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(rows.map((r) => [r.name, r.checksum]));
    const result: MigrationResult = { applied: [], alreadyApplied: [] };

    for (const m of readMigrations(dir)) {
      const previous = done.get(m.name);
      if (previous) {
        if (previous !== m.checksum) {
          throw new Error(
            `Migration ${m.name} was modified after it was applied. Add a new migration instead.`,
          );
        }
        result.alreadyApplied.push(m.name);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          m.name,
          m.checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
      }
      result.applied.push(m.name);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }
}

/**
 * Creates or updates the restricted application login role. Cluster-wide, so it is not a migration.
 * In production the platform team runs this once per environment with a secret-managed password.
 */
export async function provisionAppRole(adminUrl: string, appPassword: string): Promise<void> {
  if (appPassword.length < 16) throw new Error('APP_DB_PASSWORD must be at least 16 characters.');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const pw = client.escapeLiteral(appPassword);
    const { rowCount } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'innpilot_app'");
    const verb = rowCount ? 'ALTER' : 'CREATE';
    await client.query(
      `${verb} ROLE innpilot_app WITH LOGIN PASSWORD ${pw} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION`,
    );
  } finally {
    await client.end();
  }
}
