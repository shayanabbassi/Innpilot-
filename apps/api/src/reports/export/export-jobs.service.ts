import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  BACKGROUND_EXPORT_ROW_LIMIT,
  EXPORT_FILE_HOURS,
  EXPORT_FORMATS,
  EXPORT_JOBS_PER_USER,
  EXPORT_REPORTS,
  type ExportFormat,
  type ExportJobDto,
  type ExportJobRequest,
  type ExportReport,
  type FileLinkDto,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { AuditService } from '../../audit/audit.service';
import { SessionService } from '../../auth/session.service';
import { AppError } from '../../common/app-error';
import type { AuthContext, RequestMeta } from '../../common/request';
import { Db } from '../../db/db.module';
import { JobsService, type ClaimedJob } from '../../jobs/jobs.service';
import { FileStore } from '../../storage/file-store.service';
import { StorageError } from '../../storage/s3';
import { ExportService, type ExportFile } from './export.service';

const j = schema.jobs;
const f = schema.exportFiles;

/** What a report_export job carries. The tenant and the person come from the job row itself. */
interface ExportPayload {
  report: ExportReport;
  format: ExportFormat;
  query: Record<string, string>;
}

/** Deleted expired files per clean-up pass. */
const CLEANUP_BATCH = 100;

/**
 * Exports prepared in the background (slice 6.3): for reports too big to make while you wait.
 *
 * - Queued from a request after the filters and `export.run` are checked, so most refusals are immediate.
 * - Run by the job worker as the person who asked, with their access as it is when the job runs: a permission
 *   taken away in the meantime fails the job.
 * - The file is encrypted into private storage under the job's own key, and its row is keyed by the job: a retry
 *   replaces the same file, never adds a second. The export is audited once, when its file is first stored.
 * - Only the person who asked sees the job and can download the file, through a five-minute link, until it expires
 *   after EXPORT_FILE_HOURS; then a periodic clean-up deletes it.
 */
@Injectable()
export class ExportJobsService implements OnModuleInit {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly jobs: JobsService,
    private readonly sessions: SessionService,
    private readonly files: FileStore,
    private readonly exports: ExportService,
  ) {}

  onModuleInit(): void {
    this.jobs.register('report_export', (job) => this.run(job));
    this.jobs.every('export-cleanup', 15 * 60_000, () => this.cleanup());
  }

  queue(auth: AuthContext, body: ExportJobRequest, meta: RequestMeta): Promise<ExportJobDto> {
    // Refuse now what would be refused later: unknown filters, no export.run for them.
    this.exports.check(auth, body.report, body.query);
    return this.db.tenant(auth.tenantId, async (tx) => {
      // Serialises one person's queueing, so the limit below holds under parallel requests.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`export-queue:${auth.userId}`}))`);
      const [active] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(j)
        .where(
          and(
            eq(j.createdBy, auth.userId),
            eq(j.kind, 'report_export'),
            inArray(j.status, ['queued', 'running']),
          ),
        );
      if (active!.n >= EXPORT_JOBS_PER_USER) {
        throw new AppError(
          'CONFLICT',
          `You already have ${EXPORT_JOBS_PER_USER} exports being prepared. Wait for one to finish.`,
        );
      }
      const payload: ExportPayload = { report: body.report, format: body.format, query: body.query };
      const id = await this.jobs.enqueue(tx, {
        tenantId: auth.tenantId,
        kind: 'report_export',
        payload: payload as unknown as Record<string, unknown>,
        createdBy: auth.userId,
      });
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          propertyId: body.query.propertyId ?? null,
          actor: { type: 'user', userId: auth.userId },
          action: 'report.export_queued',
          entityType: 'job',
          entityId: id,
          changes: { report: body.report, format: body.format, filters: body.query },
        },
        meta,
      );
      return (await this.dtos(tx, auth, [id]))[0]!;
    });
  }

  /** The caller's own background exports from the last week, newest first. */
  list(auth: AuthContext): Promise<ExportJobDto[]> {
    return this.db.tenant(auth.tenantId, (tx) => this.dtos(tx, auth, null));
  }

  /** A five-minute link to a prepared file, for the person who asked only. */
  link(auth: AuthContext, jobId: string): Promise<FileLinkDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [file] = await tx
        .select()
        .from(f)
        .where(and(eq(f.jobId, jobId), eq(f.userId, auth.userId)));
      if (!file) throw AppError.notFound('export');
      if (file.removedAt || file.expiresAt.getTime() <= Date.now()) {
        throw new AppError('LINK_EXPIRED', 'This export has expired and was deleted. Prepare it again.');
      }
      return this.files.link('e', file.id, auth);
    });
  }

  /** Serves a verified link (FileStore.verify): only the person who asked, only before expiry. */
  download(auth: AuthContext, fileId: string): Promise<ExportFile> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [file] = await tx
        .select()
        .from(f)
        .where(
          and(eq(f.id, fileId), eq(f.userId, auth.userId), isNull(f.removedAt), gt(f.expiresAt, new Date())),
        );
      if (!file) throw AppError.notFound('file');
      const body = await this.files.read(file.objectKey, file, file.jobId);
      if (!body) throw AppError.notFound('file');
      return { body, fileName: file.fileName, contentType: contentType(file.format) };
    });
  }

  /** The job handler. Safe to run again for the same job. */
  async run(job: ClaimedJob): Promise<void> {
    const payload = job.payload as unknown as ExportPayload;
    if (!EXPORT_REPORTS.includes(payload.report) || !EXPORT_FORMATS.includes(payload.format)) {
      throw new AppError('VALIDATION_ERROR', 'This export request is no longer valid.');
    }
    const auth = await this.sessions.accessFor(job.tenantId, job.createdBy);
    if (!auth) throw AppError.forbidden('Your account is no longer active, so the export was not prepared.');
    const built = await this.exports
      .build(auth, payload.report, payload.format, payload.query, BACKGROUND_EXPORT_ROW_LIMIT)
      .catch((err: unknown) => {
        // The report's own checks answer "not found" to hide what exists; the person who asked is owed a reason.
        if (err instanceof AppError && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND')) {
          throw AppError.forbidden('You no longer have permission to export this report with these filters.');
        }
        throw err;
      });
    // The job id is the file's id, key and encryption context: a second run overwrites the first.
    const objectKey = `t/${job.tenantId}/exports/${job.id}`;
    const stored = await this.files.put(objectKey, built.body, job.id);
    await this.db.tenant(job.tenantId, async (tx) => {
      const expiresAt = sql`now() + make_interval(hours => ${EXPORT_FILE_HOURS})`;
      const [row] = await tx
        .insert(f)
        .values({
          id: job.id,
          tenantId: job.tenantId,
          jobId: job.id,
          userId: job.createdBy,
          propertyId: built.propertyId,
          report: payload.report,
          format: payload.format,
          fileName: built.fileName,
          objectKey,
          sizeBytes: built.body.length,
          rowCount: built.rows,
          ...stored,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: f.jobId,
          set: {
            fileName: built.fileName,
            sizeBytes: built.body.length,
            rowCount: built.rows,
            ...stored,
            createdAt: sql`now()`,
            expiresAt,
          },
        })
        // xmax = 0 only for a freshly inserted row: audit the export once, not on every retry.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      if (row!.inserted) {
        await this.exports.audited(tx, auth, payload.report, payload.format, built, null, {
          background: true,
          jobId: job.id,
        });
      }
    });
  }

  /** Deletes expired files from storage, then marks them removed. Returns how many were removed. */
  async cleanup(): Promise<number> {
    const due = await this.db.unscoped.execute<{ id: string; tenant_id: string; object_key: string }>(
      sql`select * from export_files_expired(${CLEANUP_BATCH})`,
    );
    let removed = 0;
    for (const file of due.rows) {
      try {
        await this.files.delete(file.object_key);
      } catch (err) {
        // Storage down: leave it for the next pass rather than marking a file removed that still exists.
        if (err instanceof StorageError) continue;
        throw err;
      }
      await this.db.tenant(file.tenant_id, (tx) =>
        tx
          .update(f)
          .set({ removedAt: sql`now()` })
          .where(eq(f.id, file.id)),
      );
      removed++;
    }
    return removed;
  }

  private async dtos(tx: Tx, auth: AuthContext, ids: string[] | null): Promise<ExportJobDto[]> {
    const rows = await tx
      .select({ j, f })
      .from(j)
      .leftJoin(f, eq(f.jobId, j.id))
      .where(
        and(
          eq(j.createdBy, auth.userId),
          eq(j.kind, 'report_export'),
          ids ? inArray(j.id, ids) : gt(j.createdAt, sql`now() - interval '7 days'`),
        ),
      )
      .orderBy(desc(j.createdAt))
      .limit(50);
    return rows.map(({ j: job, f: file }) => {
      const p = job.payload as unknown as ExportPayload;
      return {
        id: job.id,
        report: p.report,
        format: p.format,
        query: p.query,
        status: job.status,
        createdAt: job.createdAt.toISOString(),
        finishedAt: job.finishedAt?.toISOString() ?? null,
        error: job.status === 'failed' ? job.lastError : null,
        file: file
          ? {
              fileName: file.fileName,
              sizeBytes: file.sizeBytes,
              rowCount: file.rowCount,
              expiresAt: file.expiresAt.toISOString(),
              expired: !!file.removedAt || file.expiresAt.getTime() <= Date.now(),
            }
          : null,
      };
    });
  }
}

function contentType(format: ExportFormat): string {
  return format === 'csv'
    ? 'text/csv; charset=utf-8'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}
