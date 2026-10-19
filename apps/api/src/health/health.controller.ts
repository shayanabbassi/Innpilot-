import { Controller, Get } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Public } from '../auth/policy';
import { AppError } from '../common/app-error';
import { Db } from '../db/db.module';

@Controller('health')
export class HealthController {
  constructor(private readonly db: Db) {}

  /** Liveness plus database reachability. Reveals nothing about tenants or configuration. */
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
}
