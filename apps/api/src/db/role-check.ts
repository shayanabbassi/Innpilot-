import type { Database } from '@innpilot/db';
import { sql } from 'drizzle-orm';

/**
 * Refuses to run against a database role that row-level security does not bind: a superuser, a role with
 * BYPASSRLS, or the owner of the tables (owners are exempt from their tables' policies). Any of these would
 * silently switch off tenant isolation, so a production start-up fails instead (P6-5).
 */
export async function assertRestrictedDatabaseRole(db: Database): Promise<void> {
  const res = await db.execute<{ role: string; superuser: boolean; bypass: boolean; owned: number }>(sql`
    select r.rolname as role, r.rolsuper as superuser, r.rolbypassrls as bypass,
           (select count(*)::int from pg_tables t where t.schemaname = 'public' and t.tableowner = current_user)
             as owned
      from pg_roles r where r.rolname = current_user`);
  const r = res.rows[0];
  if (!r) throw new Error('Could not read the database role.');
  const problems = [
    r.superuser && 'it is a superuser',
    r.bypass && 'it can bypass row-level security',
    r.owned > 0 && `it owns ${r.owned} tables`,
  ].filter(Boolean);
  if (problems.length) {
    throw new Error(
      `DATABASE_URL connects as "${r.role}", which row-level security does not bind (${problems.join(', ')}). ` +
        'Use the restricted application role created by "db provision".',
    );
  }
}
