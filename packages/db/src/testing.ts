import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { migrate, provisionAppRole } from './migrate';

/** Loads the repository root .env (if present) without overriding variables already set, e.g. by CI. */
export function loadRootEnv(): void {
  const file = join(__dirname, '..', '..', '..', '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Integration tests need a running Postgres: copy .env.example to .env, fill it in, and run "pnpm db:up".`,
    );
  }
  return value;
}

function withDatabase(url: string, database: string, user?: { name: string; password: string }): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  if (user) {
    u.username = user.name;
    u.password = encodeURIComponent(user.password);
  }
  return u.toString();
}

/** Run once per test run (vitest globalSetup): ensures the application role exists. */
export async function provisionForTests(): Promise<void> {
  loadRootEnv();
  await provisionAppRole(requireEnv('DATABASE_ADMIN_URL'), requireEnv('APP_DB_PASSWORD'));
}

export interface TestDatabase {
  name: string;
  /** Owner connection: bypasses RLS. Use only for fixtures and assertions about raw state. */
  adminUrl: string;
  /** Restricted application connection: the same privileges the API runs with. */
  appUrl: string;
  drop(): Promise<void>;
}

/** Creates a fresh, fully migrated database for one test file. */
export async function createTestDatabase(): Promise<TestDatabase> {
  loadRootEnv();
  const adminUrl = requireEnv('DATABASE_ADMIN_URL');
  const appPassword = requireEnv('APP_DB_PASSWORD');
  const name = `innpilot_test_${randomBytes(5).toString('hex')}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const testAdminUrl = withDatabase(adminUrl, name);
  await migrate(testAdminUrl);

  return {
    name,
    adminUrl: testAdminUrl,
    appUrl: withDatabase(adminUrl, name, { name: 'innpilot_app', password: appPassword }),
    async drop() {
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await c.end();
      }
    },
  };
}
