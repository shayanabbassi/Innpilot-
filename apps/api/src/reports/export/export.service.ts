import { Injectable } from '@nestjs/common';
import {
  agingQuery,
  balanceSheetQuery,
  cashbookQuery,
  cashFlowQuery,
  EXPORT_REPORTS,
  EXPORT_ROW_LIMIT,
  operationalQuery,
  profitLossQuery,
  revenueQuery,
  taxSummaryQuery,
  trialBalanceQuery,
  userActivityQuery,
  type ExportFormat,
  type ExportReport,
  type TrialBalanceDto,
} from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { eq } from 'drizzle-orm';
import type { ZodTypeAny } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { AppError } from '../../common/app-error';
import type { AuthContext, RequestMeta } from '../../common/request';
import { ZodPipe } from '../../common/zod.pipe';
import { Db } from '../../db/db.module';
import { AgingService } from '../aging.service';
import { CashReportsService } from '../cash-reports.service';
import { OperationalReportsService } from '../operational.service';
import { reportScope } from '../report-scope';
import { StatementsService } from '../statements.service';
import { toCsv } from './csv';
import { rowCount, type ExportTable, type Sheet } from './table';
import * as tables from './tables';
import { toXlsx } from './xlsx';

/** What every report response carries, used for the title lines. */
interface Context {
  propertyId: string | null;
  currencyCode: string;
  timezone: string | null;
  generatedAt: string;
}

interface Definition {
  title: string;
  query: ZodTypeAny;
  /** Runs the report through its own service, which checks the report's own permission. */
  run: (auth: AuthContext, q: never) => Promise<{ context: Context; sheets: Sheet[]; period: string }>;
}

export interface ExportFile {
  body: Buffer;
  fileName: string;
  contentType: string;
}

/** A built export and what the audit record and a stored copy need to know about it. */
export interface BuiltExport extends ExportFile {
  rows: number;
  propertyId: string | null;
  filters: unknown;
}

const range = (q: { from: string; to: string }) => `${q.from}_to_${q.to}`;

/**
 * Exports (P5-14, D15): the same report service and query as the screen, plus `export.run`. Each export is audited
 * (who, report, filters, rows). Up to EXPORT_ROW_LIMIT rows the file is made while you wait and not stored; bigger
 * ones are prepared in the background (slice 6.3, ExportJobsService) up to BACKGROUND_EXPORT_ROW_LIMIT.
 */
@Injectable()
export class ExportService {
  private readonly reports: Record<ExportReport, Definition>;

  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    statements: StatementsService,
    cash: CashReportsService,
    aging: AgingService,
    ops: OperationalReportsService,
  ) {
    const def = <Q, D extends Context>(
      title: string,
      query: ZodTypeAny,
      call: (auth: AuthContext, q: Q) => Promise<D>,
      toSheets: (d: D) => Sheet[],
      period: (q: Q) => string,
    ): Definition => ({
      title,
      query,
      run: async (auth, q: Q) => {
        const d = await call(auth, q);
        return { context: d, sheets: toSheets(d), period: period(q) };
      },
    });
    type R = { from: string; to: string };
    type A = { asOf: string };
    this.reports = {
      'trial-balance': def(
        'Trial balance',
        trialBalanceQuery,
        async (a, q: R & { propertyId?: string }) => ({
          ...(await statements.trialBalance(a, q)),
          propertyId: q.propertyId ?? null,
          timezone: null,
          generatedAt: new Date().toISOString(),
        }),
        (d) => tables.trialBalance(d as unknown as TrialBalanceDto),
        range,
      ),
      'profit-loss': def(
        'Profit and loss',
        profitLossQuery,
        (a, q) => statements.profitLoss(a, q as never),
        tables.profitLoss,
        range,
      ),
      'balance-sheet': def(
        'Balance sheet',
        balanceSheetQuery,
        (a, q) => statements.balanceSheet(a, q as never),
        tables.balanceSheet,
        (q: A) => `as_of_${q.asOf}`,
      ),
      cashbook: def(
        'Cashbook',
        cashbookQuery,
        (a, q) => cash.cashbook(a, q as never),
        tables.cashbook,
        range,
      ),
      'cash-flow': def(
        'Cash flow',
        cashFlowQuery,
        (a, q) => cash.cashFlow(a, q as never),
        tables.cashFlow,
        range,
      ),
      'tax-summary': def(
        'Tax summary',
        taxSummaryQuery,
        (a, q) => cash.taxSummary(a, q as never),
        tables.taxSummary,
        range,
      ),
      revenue: def(
        'Revenue summary',
        revenueQuery,
        (a, q) => cash.revenue(a, q as never),
        tables.revenue,
        range,
      ),
      'receivables-aging': def(
        'Guest balances',
        agingQuery,
        (a, q) => aging.receivables(a, q as never),
        tables.receivablesAging,
        (q: A) => `as_of_${q.asOf}`,
      ),
      'payables-aging': def(
        'Supplier balances',
        agingQuery,
        (a, q) => aging.payables(a, q as never),
        tables.payablesAging,
        (q: A) => `as_of_${q.asOf}`,
      ),
      occupancy: def(
        'Occupancy',
        operationalQuery,
        (a, q) => ops.occupancy(a, q as never),
        tables.occupancy,
        range,
      ),
      'arrivals-departures': def(
        'Arrivals and departures',
        operationalQuery,
        (a, q) => ops.movements(a, q as never),
        tables.movements,
        range,
      ),
      'cashier-closings': def(
        'Cash closings',
        operationalQuery,
        (a, q) => ops.cashierClosings(a, q as never),
        tables.cashierClosings,
        range,
      ),
      expenses: def(
        'Expenses',
        operationalQuery,
        (a, q) => ops.expenses(a, q as never),
        tables.expenses,
        range,
      ),
      discrepancies: def(
        'Discrepancies',
        operationalQuery,
        (a, q) => ops.discrepancies(a, q as never),
        tables.discrepancies,
        range,
      ),
      'user-activity': def(
        'User activity',
        userActivityQuery,
        (a, q) => ops.userActivity(a, q as never),
        tables.userActivity,
        range,
      ),
    };
  }

  isReport(name: string): name is ExportReport {
    return (EXPORT_REPORTS as readonly string[]).includes(name);
  }

  /** On-screen export: made while you wait, refused above EXPORT_ROW_LIMIT (prepare it in the background). */
  async export(
    auth: AuthContext,
    report: ExportReport,
    format: ExportFormat,
    raw: Record<string, unknown>,
    meta: RequestMeta,
  ): Promise<ExportFile> {
    const built = await this.build(auth, report, format, raw, EXPORT_ROW_LIMIT);
    await this.db.tenant(auth.tenantId, (tx) => this.audited(tx, auth, report, format, built, meta, {}));
    return built;
  }

  /**
   * Parses the report's filters and checks `export.run` for them: on the property asked for (or tenant-wide for all
   * properties); user activity is tenant-wide only, with audit.read. Used before queueing a background export too.
   */
  check(auth: AuthContext, report: ExportReport, raw: Record<string, unknown>): { propertyId?: string } {
    const q = new ZodPipe(this.reports[report]!.query).transform(raw) as { propertyId?: string };
    if (report === 'user-activity') {
      if (!auth.tenantWidePermissions.has('export.run') || !auth.tenantWidePermissions.has('audit.read')) {
        throw AppError.forbidden();
      }
    } else {
      reportScope(auth, 'export.run', q.propertyId);
    }
    return q;
  }

  /** Writes the `report.exported` audit record in the caller's transaction. */
  audited(
    tx: Tx,
    auth: AuthContext,
    report: ExportReport,
    format: ExportFormat,
    built: BuiltExport,
    meta: RequestMeta | null,
    extra: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record(
      tx,
      {
        tenantId: auth.tenantId,
        propertyId: built.propertyId,
        actor: { type: 'user', userId: auth.userId },
        action: 'report.exported',
        entityType: 'report',
        changes: { report, format, filters: built.filters, rows: built.rows, ...extra },
      },
      meta,
    );
  }

  /** Runs the report through its own service and writes the file. Refuses more than `rowLimit` rows. */
  async build(
    auth: AuthContext,
    report: ExportReport,
    format: ExportFormat,
    raw: Record<string, unknown>,
    rowLimit: number,
  ): Promise<BuiltExport> {
    const def = this.reports[report]!;
    const q = this.check(auth, report, raw);
    const { context, sheets, period } = await def.run(auth, q as never);

    const propertyName = await this.db.tenant(auth.tenantId, async (tx) => {
      if (!context.propertyId) return null;
      const [p] = await tx
        .select({ name: schema.properties.name })
        .from(schema.properties)
        .where(eq(schema.properties.id, context.propertyId));
      return p?.name ?? null;
    });
    const table: ExportTable = {
      title: [
        def.title,
        report === 'user-activity' ? 'All properties (audit log)' : (propertyName ?? 'All properties'),
        period.replace(/_/g, ' '),
        `Amounts in ${context.currencyCode}${context.timezone ? `; time zone ${context.timezone}` : ''}`,
        `Generated ${context.generatedAt}`,
      ],
      sheets,
    };
    const rows = rowCount(table);
    if (rows > rowLimit) {
      throw new AppError(
        'EXPORT_TOO_LARGE',
        rowLimit === EXPORT_ROW_LIMIT
          ? `This export has ${rows} rows, more than ${EXPORT_ROW_LIMIT} can be made while you wait. Prepare it in the background instead.`
          : `This export has ${rows} rows, more than ${rowLimit}. Choose a shorter period or one property.`,
      );
    }
    const done = { rows, propertyId: context.propertyId, filters: q };

    const scope = slug(propertyName ?? (report === 'user-activity' ? 'audit-log' : 'all-properties'));
    const fileName = `innpilot_${report}_${scope}_${period}.${format}`;
    return format === 'csv'
      ? { ...done, body: toCsv(table), fileName, contentType: 'text/csv; charset=utf-8' }
      : {
          ...done,
          body: toXlsx(table),
          fileName,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
  }
}

/** File names in plain ASCII: letters, digits and dashes. */
function slug(v: string): string {
  return (
    v
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .slice(0, 40) || 'property'
  );
}
