import { Controller, Get, Param, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { EXPORT_FORMATS, type ExportFormat } from '@innpilot/contracts';
import type { Response } from 'express';
import { CurrentAuth, RequirePermission } from '../../auth/policy';
import { AppError } from '../../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../../common/request';
import { ExportService } from './export.service';

/**
 * `GET /reports/{report}/export?format=csv|xlsx&…`: the report's own query and permission, plus `export.run`
 * (P5-14). The file is produced on request, sent once and not stored.
 */
@Controller('reports')
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  @Get(':report/export')
  @RequirePermission('export.run', 'any')
  async export(
    @CurrentAuth() auth: AuthContext,
    @Param('report') report: string,
    @Query() query: Record<string, unknown>,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    if (!this.exports.isReport(report)) throw AppError.notFound('report');
    const { format, ...rest } = query;
    if (!(EXPORT_FORMATS as readonly unknown[]).includes(format)) {
      throw AppError.validation('Choose CSV or Excel.', [{ path: 'format', message: 'Use csv or xlsx.' }]);
    }
    const file = await this.exports.export(auth, report, format as ExportFormat, rest, requestMeta(req));
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(file.body);
  }
}
