import { Controller, Get, Query } from '@nestjs/common';
import { dashboardQuery, type DashboardDto, type DashboardQuery } from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import type { AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { DashboardService } from './dashboard.service';

/** 04 API §3. Needs `report.operational` on the property; financial figures need `report.financial` there too. */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequirePermission('report.operational', 'any')
  get(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(dashboardQuery)) q: DashboardQuery,
  ): Promise<DashboardDto> {
    return this.dashboard.dashboard(auth, q);
  }
}
