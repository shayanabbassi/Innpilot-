import { Controller, Get, Inject } from '@nestjs/common';
import type { SystemWarningsDto } from '@innpilot/contracts';
import { sql } from 'drizzle-orm';
import { RequirePermission } from '../auth/policy';
import { APP_CONFIG, type AppConfig } from '../config';
import { Db } from '../db/db.module';
import { systemWarnings } from './system-warnings';

/**
 * System warnings for the owner and manager (slice 7.2): backups and background work, read from the same sources as
 * the metrics. Nothing tenant-specific is read or returned. When IN_APP_SYSTEM_WARNINGS is off (a hosted
 * multi-hotel service), the answer is always an empty list.
 */
@Controller('system')
export class SystemWarningsController {
  constructor(
    private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('warnings')
  // Any property will do: a manager may be assigned to one property, and the warnings concern the whole install.
  @RequirePermission('system.warnings', 'any')
  async warnings(): Promise<SystemWarningsDto> {
    const now = new Date();
    if (!this.config.IN_APP_SYSTEM_WARNINGS) {
      return { enabled: false, checkedAt: now.toISOString(), warnings: [] };
    }
    const backups = (
      await this.db.unscoped.execute<{ runs: number; last_ok: string | null; last_run_ok: boolean | null }>(
        sql`select (select count(*)::int from backup_runs) as runs,
                   (select max(finished_at) from backup_runs where ok) as last_ok,
                   (select ok from backup_runs order by finished_at desc limit 1) as last_run_ok`,
      )
    ).rows[0]!;
    const jobs = (
      await this.db.unscoped.execute<{ failed_24h: number; oldest_queued_seconds: number }>(
        sql`select failed_24h, oldest_queued_seconds from ops_job_stats()`,
      )
    ).rows[0]!;
    return {
      enabled: true,
      checkedAt: now.toISOString(),
      warnings: systemWarnings(
        {
          backupRuns: backups.runs,
          lastGoodBackupAt: backups.last_ok ? new Date(backups.last_ok) : null,
          lastBackupOk: backups.last_run_ok,
          jobsFailed24h: jobs.failed_24h,
          oldestQueuedSeconds: Number(jobs.oldest_queued_seconds),
        },
        now,
      ),
    };
  }
}
