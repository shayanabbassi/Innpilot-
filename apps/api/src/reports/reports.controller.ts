import { Controller, Get, Query } from '@nestjs/common';
import {
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
import { StatementsService } from './statements.service';

/**
 * Financial statements (P5-15). The guard lets through anyone holding `report.financial` on some property; the
 * service then checks the property asked for, or a tenant-wide role for all properties.
 */
@Controller('reports')
export class ReportsController {
  constructor(private readonly statements: StatementsService) {}

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
}
