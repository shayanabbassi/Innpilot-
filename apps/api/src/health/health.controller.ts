import { Controller, Get } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Public } from '../auth/policy';
import { AppError } from '../common/app-error';
import { Db } from '../db/db.module';
import { MetricsService } from '../monitoring/metrics.service';

/** Health endpoints for uptime checks and orchestrators. They reveal nothing about tenants or configuration. */
@Controller('health')
export class HealthController {
  constructor(
    private readonly db: Db,
    private readonly metrics: MetricsService,
  ) {}

  /** Liveness plus database reachability (the release smoke test and earlier checks use this one). */
  @Get()
  @Public()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.db.unscoped.execute(sql`select 1`);
    } catch {
      throw new AppError('INTERNAL_ERROR', 'Database unavailable.');
    }
    return { status: 'ok' };
  }

  /** The process is running. No dependency is checked, so a database outage never causes restarts. */
  @Get('live')
  @Public()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Ready to serve: the database answers, file storage answers, and every migration this release ships is applied.
   * 503 NOT_READY names the dependency that failed (slice 6.6).
   */
  @Get('ready')
  @Public()
  async ready(): Promise<{ status: 'ok'; checks: Record<string, 'ok'> }> {
    const checks = await this.metrics.readiness();
    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    if (failed.length) throw new AppError('NOT_READY', `Not ready: ${failed.join(', ')}.`);
    return { status: 'ok', checks: { database: 'ok', storage: 'ok', migrations: 'ok' } };
  }
}
