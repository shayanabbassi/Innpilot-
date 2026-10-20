import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import {
  createFolioRequest,
  IDEMPOTENCY_HEADER,
  postAllowanceRequest,
  postChargeRequest,
  transferChargeRequest,
  voidChargeRequest,
  type CreateFolioRequest,
  type FolioDto,
  type OpenFolioDto,
  type PostAllowanceRequest,
  type PostChargeRequest,
  type TransferChargeRequest,
  type VoidChargeRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { FolioService } from './folio.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

/**
 * Guest folios. Reading needs `folio.read`; posting charges `folio.charge`; allowances, voids and transfers
 * `folio.adjust`. Every money route needs an Idempotency-Key header.
 */
@Controller('properties/:propertyId')
export class FolioController {
  constructor(private readonly folios: FolioService) {}

  @Get('reservations/:reservationId/folios')
  @RequirePermission('folio.read', P)
  forReservation(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('reservationId', uuid('reservation')) reservationId: string,
  ): Promise<FolioDto[]> {
    return this.folios.listForReservation(auth, propertyId, reservationId);
  }

  @Post('reservations/:reservationId/folios')
  @RequirePermission('folio.charge', P)
  create(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('reservationId', uuid('reservation')) reservationId: string,
    @Body(new ZodPipe(createFolioRequest)) body: CreateFolioRequest,
    @Req() req: AppRequest,
  ): Promise<FolioDto> {
    return this.folios.createFolio(auth, propertyId, reservationId, body, requestMeta(req));
  }

  @Get('folios')
  @RequirePermission('folio.read', P)
  open(@CurrentAuth() auth: AuthContext, @Param('propertyId') propertyId: string): Promise<OpenFolioDto[]> {
    return this.folios.listOpen(auth, propertyId);
  }

  @Get('folios/:id')
  @RequirePermission('folio.read', P)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('folio')) id: string,
  ): Promise<FolioDto> {
    return this.folios.get(auth, propertyId, id);
  }

  @Post('folios/:id/charges')
  @RequirePermission('folio.charge', P)
  async charge(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('folio')) id: string,
    @Body(new ZodPipe(postChargeRequest)) body: PostChargeRequest,
    @Req() req: AppRequest,
  ): Promise<FolioDto> {
    return (
      await this.folios.postCharge(auth, propertyId, id, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req))
    ).body;
  }

  @Post('folios/:id/allowances')
  @RequirePermission('folio.adjust', P)
  async allowance(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('folio')) id: string,
    @Body(new ZodPipe(postAllowanceRequest)) body: PostAllowanceRequest,
    @Req() req: AppRequest,
  ): Promise<FolioDto> {
    return (
      await this.folios.postAllowance(
        auth,
        propertyId,
        id,
        body,
        req.get(IDEMPOTENCY_HEADER),
        requestMeta(req),
      )
    ).body;
  }

  @Post('folio-charges/:id/void')
  @HttpCode(200)
  @RequirePermission('folio.adjust', P)
  async void(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('folio item')) id: string,
    @Body(new ZodPipe(voidChargeRequest)) body: VoidChargeRequest,
    @Req() req: AppRequest,
  ): Promise<FolioDto> {
    return (
      await this.folios.voidCharge(auth, propertyId, id, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req))
    ).body;
  }

  @Post('folio-charges/:id/transfer')
  @HttpCode(200)
  @RequirePermission('folio.adjust', P)
  async transfer(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('folio item')) id: string,
    @Body(new ZodPipe(transferChargeRequest)) body: TransferChargeRequest,
    @Req() req: AppRequest,
  ): Promise<FolioDto> {
    return (
      await this.folios.transferCharge(
        auth,
        propertyId,
        id,
        body,
        req.get(IDEMPOTENCY_HEADER),
        requestMeta(req),
      )
    ).body;
  }
}
