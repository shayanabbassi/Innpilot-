import { Controller, Get, Param, Req, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentAuth, SessionOnly } from '../auth/policy';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ExportJobsService } from '../reports/export/export-jobs.service';
import { AttachmentsService } from './attachments.service';
import { FileStore } from './file-store.service';
import { contentDisposition } from './files';

/**
 * `GET /files/{link}`: serves a download link issued for an attachment (SEC-003) or a prepared export (6.3). The
 * link alone is not enough: it also needs the signed-in session of the person it was issued to, and expires after
 * five minutes. Attachments open in the browser; exports are saved.
 */
@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FileStore,
    private readonly attachments: AttachmentsService,
    private readonly exportJobs: ExportJobsService,
  ) {}

  @Get(':token')
  @SessionOnly(['active'])
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param('token') token: string,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const link = this.files.verify(token, auth);
    const file =
      link.kind === 'a'
        ? await this.attachments.download(auth, link.id, requestMeta(req))
        : await this.exportJobs.download(auth, link.id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader(
      'Content-Disposition',
      contentDisposition(file.fileName, link.kind === 'a' ? 'inline' : 'attachment'),
    );
    res.setHeader('Content-Length', String(file.body.length));
    // Personal and financial documents: never kept by a browser or proxy cache.
    res.setHeader('Cache-Control', 'private, no-store');
    // Shown as a document of its own, never framed by another site, with nothing it could run.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    return new StreamableFile(file.body);
  }
}
