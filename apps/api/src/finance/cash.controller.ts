import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import {
  cashMovementsQuery,
  createCashAccountRequest,
  IDEMPOTENCY_HEADER,
  openingBalancesRequest,
  transferListQuery,
  transferRequest,
  updateCashAccountRequest,
  type CashAccountDto,
  type CashMovementsDto,
  type CashMovementsQuery,
  type CreateCashAccountRequest,
  type OpeningBalancesDto,
  type OpeningBalancesRequest,
  type TransferDto,
  type TransferListQuery,
  type TransferRequest,
  type UpdateCashAccountRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { CashService } from './cash.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

/**
 * Cash drawers and bank accounts, transfers between them, and the opening balances. Listing needs `folio.read`
 * (payment screens choose an account; balances only with `journal.read`), managing accounts `account.manage`,
 * movements `journal.read`, transfers `cash.transfer`, opening balances `journal.post`. Money routes need an
 * Idempotency-Key header.
 */
@Controller('properties/:propertyId')
export class CashController {
  constructor(private readonly cash: CashService) {}

  @Get('cash-accounts')
  @RequirePermission('folio.read', P)
  list(@CurrentAuth() auth: AuthContext, @Param('propertyId') propertyId: string): Promise<CashAccountDto[]> {
    return this.cash.list(auth, propertyId);
  }

  @Post('cash-accounts')
  @RequirePermission('account.manage', P)
  create(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(createCashAccountRequest)) body: CreateCashAccountRequest,
    @Req() req: AppRequest,
  ): Promise<CashAccountDto> {
    return this.cash.create(auth, propertyId, body, requestMeta(req));
  }

  @Patch('cash-accounts/:id')
  @RequirePermission('account.manage', P)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('cash account')) id: string,
    @Body(new ZodPipe(updateCashAccountRequest)) body: UpdateCashAccountRequest,
    @Req() req: AppRequest,
  ): Promise<CashAccountDto> {
    return this.cash.update(auth, propertyId, id, body, requestMeta(req));
  }

  @Get('cash-accounts/:id/movements')
  @RequirePermission('journal.read', P)
  movements(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('cash account')) id: string,
    @Query(new ZodPipe(cashMovementsQuery)) q: CashMovementsQuery,
  ): Promise<CashMovementsDto> {
    return this.cash.movements(auth, propertyId, id, q);
  }

  @Get('transfers')
  @RequirePermission('cash.transfer', P)
  listTransfers(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Query(new ZodPipe(transferListQuery)) q: TransferListQuery,
  ): Promise<TransferDto[]> {
    return this.cash.listTransfers(auth, propertyId, q);
  }

  @Post('transfers')
  @RequirePermission('cash.transfer', P)
  async transfer(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(transferRequest)) body: TransferRequest,
    @Req() req: AppRequest,
  ): Promise<TransferDto> {
    return (await this.cash.transfer(auth, propertyId, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req)))
      .body;
  }

  /** Null until the opening balances have been entered. */
  @Get('opening-balances')
  @RequirePermission('journal.read', P)
  openingBalances(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<OpeningBalancesDto | null> {
    return this.cash.openingBalances(auth, propertyId);
  }

  @Post('opening-balances')
  @RequirePermission('journal.post', P)
  async postOpeningBalances(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(openingBalancesRequest)) body: OpeningBalancesRequest,
    @Req() req: AppRequest,
  ): Promise<OpeningBalancesDto> {
    return (
      await this.cash.postOpeningBalances(
        auth,
        propertyId,
        body,
        req.get(IDEMPOTENCY_HEADER),
        requestMeta(req),
      )
    ).body;
  }
}
