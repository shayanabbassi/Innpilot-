import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import {
  dayCloseRequest,
  IDEMPOTENCY_HEADER,
  type DayCloseDto,
  type DayClosePreviewDto,
  type DayCloseRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { DayCloseService } from './day-close.service';

const P = { propertyParam: 'propertyId' } as const;

@Controller('properties/:propertyId/day-close')
export class DayCloseController {
  constructor(private readonly dayClose: DayCloseService) {}

  @Get('preview')
  @RequirePermission('night_audit.run', P)
  preview(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<DayClosePreviewDto> {
    return this.dayClose.preview(auth, propertyId);
  }

  @Get('history')
  @RequirePermission('night_audit.run', P)
  history(@CurrentAuth() auth: AuthContext, @Param('propertyId') propertyId: string): Promise<DayCloseDto[]> {
    return this.dayClose.history(auth, propertyId);
  }

  /** Requires an Idempotency-Key header. Closes exactly the business date given in the body, once. */
  @Post()
  @HttpCode(200)
  @RequirePermission('night_audit.run', P)
  async close(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(dayCloseRequest)) body: DayCloseRequest,
    @Req() req: AppRequest,
  ): Promise<DayCloseDto> {
    const result = await this.dayClose.close(
      auth,
      propertyId,
      body,
      req.get(IDEMPOTENCY_HEADER),
      requestMeta(req),
    );
    return result.body;
  }
}
