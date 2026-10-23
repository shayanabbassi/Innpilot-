import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  cardSettlementRequest,
  completeReconciliationRequest,
  IDEMPOTENCY_HEADER,
  reconciliationItemsRequest,
  reconciliationListQueryObject,
  startReconciliationRequest,
  updateReconciliationRequest,
  type CardSettlementDto,
  type CardSettlementRequest,
  type CompleteReconciliationRequest,
  type ReconciliationDetailDto,
  type ReconciliationDto,
  type ReconciliationItemsRequest,
  type ReconciliationListQuery,
  type StartReconciliationRequest,
  type UpdateReconciliationRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { ReconciliationService } from './reconciliation.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound('reconciliation') });

/**
 * Bank reconciliation: reading needs `journal.read`, starting, ticking, finishing and abandoning `bank.reconcile`.
 * Card settlements need `cash.transfer` and an Idempotency-Key.
 */
@Controller('properties/:propertyId')
export class ReconciliationController {
  constructor(private readonly reconciliations: ReconciliationService) {}

  @Get('reconciliations')
  @RequirePermission('journal.read', P)
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Query(new ZodPipe(reconciliationListQueryObject)) q: ReconciliationListQuery,
  ): Promise<ReconciliationDto[]> {
    return this.reconciliations.list(auth, propertyId, q);
  }

  @Get('reconciliations/:id')
  @RequirePermission('journal.read', P)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid) id: string,
  ): Promise<ReconciliationDetailDto> {
    return this.reconciliations.get(auth, propertyId, id);
  }

  @Post('reconciliations')
  @RequirePermission('bank.reconcile', P)
  start(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(startReconciliationRequest)) body: StartReconciliationRequest,
    @Req() req: AppRequest,
  ): Promise<ReconciliationDetailDto> {
    return this.reconciliations.start(auth, propertyId, body, requestMeta(req));
  }

  @Patch('reconciliations/:id')
  @RequirePermission('bank.reconcile', P)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(updateReconciliationRequest)) body: UpdateReconciliationRequest,
  ): Promise<ReconciliationDetailDto> {
    return this.reconciliations.update(auth, propertyId, id, body);
  }

  @Put('reconciliations/:id/items')
  @RequirePermission('bank.reconcile', P)
  setItems(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(reconciliationItemsRequest)) body: ReconciliationItemsRequest,
  ): Promise<ReconciliationDetailDto> {
    return this.reconciliations.setItems(auth, propertyId, id, body);
  }

  @Post('reconciliations/:id/complete')
  @HttpCode(200)
  @RequirePermission('bank.reconcile', P)
  async complete(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(completeReconciliationRequest)) body: CompleteReconciliationRequest,
    @Req() req: AppRequest,
  ): Promise<ReconciliationDetailDto> {
    return (
      await this.reconciliations.complete(
        auth,
        propertyId,
        id,
        body,
        req.get(IDEMPOTENCY_HEADER),
        requestMeta(req),
      )
    ).body;
  }

  @Delete('reconciliations/:id')
  @HttpCode(200)
  @RequirePermission('bank.reconcile', P)
  abandon(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid) id: string,
    @Req() req: AppRequest,
  ): Promise<{ id: string }> {
    return this.reconciliations.abandon(auth, propertyId, id, requestMeta(req));
  }

  @Get('card-settlements')
  @RequirePermission('cash.transfer', P)
  listSettlements(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<CardSettlementDto[]> {
    return this.reconciliations.listSettlements(auth, propertyId);
  }

  @Post('card-settlements')
  @RequirePermission('cash.transfer', P)
  async settle(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(cardSettlementRequest)) body: CardSettlementRequest,
    @Req() req: AppRequest,
  ): Promise<CardSettlementDto> {
    return (
      await this.reconciliations.settle(auth, propertyId, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req))
    ).body;
  }
}
