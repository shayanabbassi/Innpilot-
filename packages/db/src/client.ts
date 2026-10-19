import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;
/** A transaction handle. Tenant-owned tables are only visible through one opened by `withTenant`. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DbHandle {
  db: Database;
  pool: Pool;
  close(): Promise<void>;
}

export function createDb(connectionString: string, options: PoolConfig = {}): DbHandle {
  const pool = new Pool({ connectionString, max: 10, ...options });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in a transaction scoped to one tenant. Row-level security only exposes that tenant's rows,
 * and the setting is transaction-local, so a pooled connection can never carry it into another request.
 * The tenant id must come from the authenticated session, never from client input.
 */
export async function withTenant<T>(db: Database, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error('withTenant requires a tenant UUID');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
