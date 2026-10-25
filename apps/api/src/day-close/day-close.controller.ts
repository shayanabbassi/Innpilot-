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

/** The night audit (P4-9, OPS-004). */
@Controller('properties/:propertyId/night-audit')
export class NightAuditController {
  constructor(private readonly audit: DayCloseService) {}

  @Get('preview')
  @RequirePermission('night_audit.run', P)
  preview(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<DayClosePreviewDto> {
    return this.audit.preview(auth, propertyId);
  }

  @Get('history')
  @RequirePermission('night_audit.run', P)
  history(@CurrentAuth() auth: AuthContext, @Param('propertyId') propertyId: string): Promise<DayCloseDto[]> {
    return this.audit.history(auth, propertyId);
  }

  /** Requires an Idempotency-Key header. Runs exactly the business date given in the body, once. */
  @Post()
  @HttpCode(200)
  @RequirePermission('night_audit.run', P)
  async run(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(dayCloseRequest)) body: DayCloseRequest,
    @Req() req: AppRequest,
  ): Promise<DayCloseDto> {
    return (await this.audit.close(auth, propertyId, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req)))
      .body;
  }
}

/**
 * The interim day close's routes, kept for one release as an alias of the night audit (P4-9). Same checks, same
 * once-per-date record; a retry with the same Idempotency-Key is the same request on either path.
 */
@Controller('properties/:propertyId/day-close')
export class DayCloseController {
  constructor(private readonly audit: DayCloseService) {}

  @Get('preview')
  @RequirePermission('night_audit.run', P)
  preview(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<DayClosePreviewDto> {
    return this.audit.preview(auth, propertyId);
  }

  @Get('history')
  @RequirePermission('night_audit.run', P)
  history(@CurrentAuth() auth: AuthContext, @Param('propertyId') propertyId: string): Promise<DayCloseDto[]> {
    return this.audit.history(auth, propertyId);
  }

  /** Requires an Idempotency-Key header. */
  @Post()
  @HttpCode(200)
  @RequirePermission('night_audit.run', P)
  async close(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(dayCloseRequest)) body: DayCloseRequest,
    @Req() req: AppRequest,
  ): Promise<DayCloseDto> {
    return (await this.audit.close(auth, propertyId, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req)))
      .body;
  }
}
