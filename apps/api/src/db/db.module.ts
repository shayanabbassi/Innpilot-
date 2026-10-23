import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, withTenant, type Database, type DbHandle, type Tx } from '@innpilot/db';
import { APP_CONFIG, type AppConfig } from '../config';

export const DB_HANDLE = Symbol('DB_HANDLE');

/** Database access. Tenant-owned data is only reachable through `tenant()`. */
@Injectable()
export class Db implements OnApplicationShutdown {
  constructor(@Inject(DB_HANDLE) private readonly handle: DbHandle) {}

  /** Runs `fn` in a transaction scoped to `tenantId` (row-level security applies). */
  tenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenant(this.handle.db, tenantId, fn);
  }

  /** Unscoped access for the pre-tenant SECURITY DEFINER lookups and health checks only. */
  get unscoped(): Database {
    return this.handle.db;
  }

  /** Connection pool usage, for the database-capacity metric. */
  poolStats(): { total: number; idle: number; waiting: number; max: number } {
    const p = this.handle.pool;
    return { total: p.totalCount, idle: p.idleCount, waiting: p.waitingCount, max: p.options.max ?? 10 };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.handle.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DB_HANDLE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createDb(config.DATABASE_URL),
    },
    Db,
  ],
  exports: [Db],
})
export class DbModule {}
