import { Controller, Get, Query } from '@nestjs/common';
import {
  operationalQuery,
  userActivityQuery,
  type CashierClosingsDto,
  type DiscrepanciesDto,
  type ExpensesReportDto,
  type MovementsDto,
  type OccupancyDto,
  type OperationalQuery,
  type UserActivityDto,
  type UserActivityQuery,
  agingQuery,
  type AgingQuery,
  type PayablesAgingDto,
  type ReceivablesAgingDto,
  cashbookQuery,
  cashFlowQuery,
  revenueQuery,
  taxSummaryQuery,
  type CashbookDto,
  type CashbookQuery,
  type CashFlowDto,
  type CashFlowQuery,
  type RevenueDto,
  type RevenueQuery,
  type TaxSummaryDto,
  type TaxSummaryQuery,
  balanceSheetQuery,
  profitLossQuery,
  trialBalanceQuery,
  type BalanceSheetDto,
  type BalanceSheetQuery,
  type ProfitLossDto,
  type ProfitLossQuery,
  type TrialBalanceDto,
  type TrialBalanceQuery,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import type { AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AgingService } from './aging.service';
import { CashReportsService } from './cash-reports.service';
import { OperationalReportsService } from './operational.service';
import { StatementsService } from './statements.service';

/**
 * Financial reports (P5-15). The guard lets through anyone holding `report.financial` on some property; the
 * service then checks the property asked for, or a tenant-wide role for all properties.
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly statements: StatementsService,
    private readonly cash: CashReportsService,
    private readonly aging: AgingService,
    private readonly ops: OperationalReportsService,
  ) {}

  @Get('trial-balance')
  @RequirePermission('report.financial', 'any')
  trialBalance(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(trialBalanceQuery)) q: TrialBalanceQuery,
  ): Promise<TrialBalanceDto> {
    return this.statements.trialBalance(auth, q);
  }

  @Get('profit-loss')
  @RequirePermission('report.financial', 'any')
  profitLoss(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(profitLossQuery)) q: ProfitLossQuery,
  ): Promise<ProfitLossDto> {
    return this.statements.profitLoss(auth, q);
  }

  @Get('balance-sheet')
  @RequirePermission('report.financial', 'any')
  balanceSheet(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(balanceSheetQuery)) q: BalanceSheetQuery,
  ): Promise<BalanceSheetDto> {
    return this.statements.balanceSheet(auth, q);
  }

  @Get('cashbook')
  @RequirePermission('report.financial', 'any')
  cashbook(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(cashbookQuery)) q: CashbookQuery,
  ): Promise<CashbookDto> {
    return this.cash.cashbook(auth, q);
  }

  @Get('cash-flow')
  @RequirePermission('report.financial', 'any')
  cashFlow(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(cashFlowQuery)) q: CashFlowQuery,
  ): Promise<CashFlowDto> {
    return this.cash.cashFlow(auth, q);
  }

  @Get('tax-summary')
  @RequirePermission('report.financial', 'any')
  taxSummary(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(taxSummaryQuery)) q: TaxSummaryQuery,
  ): Promise<TaxSummaryDto> {
    return this.cash.taxSummary(auth, q);
  }

  @Get('revenue')
  @RequirePermission('report.financial', 'any')
  revenue(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(revenueQuery)) q: RevenueQuery,
  ): Promise<RevenueDto> {
    return this.cash.revenue(auth, q);
  }

  @Get('receivables-aging')
  @RequirePermission('report.financial', 'any')
  receivablesAging(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(agingQuery)) q: AgingQuery,
  ): Promise<ReceivablesAgingDto> {
    return this.aging.receivables(auth, q);
  }

  @Get('payables-aging')
  @RequirePermission('report.financial', 'any')
  payablesAging(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(agingQuery)) q: AgingQuery,
  ): Promise<PayablesAgingDto> {
    return this.aging.payables(auth, q);
  }

  @Get('occupancy')
  @RequirePermission('report.operational', 'any')
  occupancy(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(operationalQuery)) q: OperationalQuery,
  ): Promise<OccupancyDto> {
    return this.ops.occupancy(auth, q);
  }

  @Get('arrivals-departures')
  @RequirePermission('report.operational', 'any')
  movements(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(operationalQuery)) q: OperationalQuery,
  ): Promise<MovementsDto> {
    return this.ops.movements(auth, q);
  }

  @Get('cashier-closings')
  @RequirePermission('report.operational', 'any')
  cashierClosings(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(operationalQuery)) q: OperationalQuery,
  ): Promise<CashierClosingsDto> {
    return this.ops.cashierClosings(auth, q);
  }

  @Get('expenses')
  @RequirePermission('report.financial', 'any')
  expenses(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(operationalQuery)) q: OperationalQuery,
  ): Promise<ExpensesReportDto> {
    return this.ops.expenses(auth, q);
  }

  @Get('discrepancies')
  @RequirePermission('report.financial', 'any')
  discrepancies(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(operationalQuery)) q: OperationalQuery,
  ): Promise<DiscrepanciesDto> {
    return this.ops.discrepancies(auth, q);
  }

  @Get('user-activity')
  @RequirePermission('audit.read', 'tenant')
  userActivity(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(userActivityQuery)) q: UserActivityQuery,
  ): Promise<UserActivityDto> {
    return this.ops.userActivity(auth, q);
  }
}
