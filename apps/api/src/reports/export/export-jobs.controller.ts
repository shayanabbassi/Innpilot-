import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  exportJobRequest,
  type ExportJobDto,
  type ExportJobRequest,
  type FileLinkDto,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../../auth/policy';
import { AppError } from '../../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../../common/request';
import { ZodPipe } from '../../common/zod.pipe';
import { ExportJobsService } from './export-jobs.service';

const uuid = new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound('export') });

/**
 * Background exports (slice 6.3). `export.run` on at least one property here; the report's own permission and
 * `export.run` for the filters asked for are checked when queueing and again when the job runs.
 */
@Controller('exports')
export class ExportJobsController {
  constructor(private readonly exportJobs: ExportJobsService) {}

  @Post()
  @RequirePermission('export.run', 'any')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  queue(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(exportJobRequest)) body: ExportJobRequest,
    @Req() req: AppRequest,
  ): Promise<ExportJobDto> {
    return this.exportJobs.queue(auth, body, requestMeta(req));
  }

  /** Your own background exports from the last seven days. */
  @Get()
  @RequirePermission('export.run', 'any')
  list(@CurrentAuth() auth: AuthContext): Promise<ExportJobDto[]> {
    return this.exportJobs.list(auth);
  }

  @Post(':id/link')
  @HttpCode(200)
  @RequirePermission('export.run', 'any')
  link(@CurrentAuth() auth: AuthContext, @Param('id', uuid) id: string): Promise<FileLinkDto> {
    return this.exportJobs.link(auth, id);
  }
}
