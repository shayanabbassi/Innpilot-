import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import {
  approveClosingRequest,
  IDEMPOTENCY_HEADER,
  openShiftRequest,
  reopenClosingRequest,
  shiftListQuery,
  submitClosingRequest,
  type ApproveClosingRequest,
  type CashierShiftDetailDto,
  type CashierShiftDto,
  type OpenShiftRequest,
  type ReopenClosingRequest,
  type ShiftListQuery,
  type SubmitClosingRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { CashierService } from './cashier.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound('shift') });

/**
 * Cashier shifts and closings (CASH-001). Opening and closing your own shift needs `cashier.operate`, approving a
 * closing `cashier.approve` (never your own), reopening one `cashier.reopen`. Lists and details need `folio.read`;
 * they show everyone's shifts only to holders of `cashier.approve` or `journal.read`, otherwise only your own.
 * Commands need an Idempotency-Key header.
 */
@Controller('properties/:propertyId/cashier-shifts')
export class CashierController {
  constructor(private readonly cashier: CashierService) {}

  /** The caller's open shift, or null. */
  @Get('current')
  @RequirePermission('cashier.operate', P)
  current(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<CashierShiftDto | null> {
    return this.cashier.current(auth, propertyId);
  }

  @Get()
  @RequirePermission('folio.read', P)
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Query(new ZodPipe(shiftListQuery)) q: ShiftListQuery,
  ): Promise<CashierShiftDto[]> {
    return this.cashier.list(auth, propertyId, q);
  }

  @Get(':id')
  @RequirePermission('folio.read', P)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid) id: string,
  ): Promise<CashierShiftDetailDto> {
    return this.cashier.get(auth, propertyId, id);
  }

  @Post('open')
  @RequirePermission('cashier.operate', P)
  async open(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(openShiftRequest)) body: OpenShiftRequest,
    @Req() req: AppRequest,
  ): Promise<CashierShiftDto> {
    return (await this.cashier.open(auth, propertyId, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req)))
      .body;
  }

  @Post(':id/submit-closing')
  @HttpCode(200)
  @RequirePermission('cashier.operate', P)
  async submit(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(submitClosingRequest)) body: SubmitClosingRequest,
    @Req() req: AppRequest,
  ): Promise<CashierShiftDto> {
    return (
      await this.cashier.submitClosing(
        auth,
        propertyId,
        id,
        body,
        req.get(IDEMPOTENCY_HEADER),
        requestMeta(req),
      )
    ).body;
  }

  @Post(':id/approve-closing')
  @HttpCode(200)
  @RequirePermission('cashier.approve', P)
  async approve(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(approveClosingRequest)) body: ApproveClosingRequest,
    @Req() req: AppRequest,
  ): Promise<CashierShiftDto> {
    return (
      await this.cashier.approveClosing(
        auth,
        propertyId,
        id,
        body,
        req.get(IDEMPOTENCY_HEADER),
        requestMeta(req),
      )
    ).body;
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermission('cashier.reopen', P)
  async reopen(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(reopenClosingRequest)) body: ReopenClosingRequest,
    @Req() req: AppRequest,
  ): Promise<CashierShiftDto> {
    return (
      await this.cashier.reopen(auth, propertyId, id, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req))
    ).body;
  }
}
