import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import {
  IDEMPOTENCY_HEADER,
  paymentListQuery,
  recordPaymentRequest,
  refundRequest,
  voidChargeRequest,
  type PaymentDto,
  type PaymentListQuery,
  type ReceiptDto,
  type RecordPaymentRequest,
  type RefundRequest,
  type VoidChargeRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { PaymentService } from './payment.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

/**
 * Payments, deposits and refunds. Receiving needs `payment.receive`, refunding `payment.refund`, keeping a deposit as
 * a fee `folio.adjust`. Every money route needs an Idempotency-Key header.
 */
@Controller('properties/:propertyId')
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Get('payments')
  @RequirePermission('folio.read', P)
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Query(new ZodPipe(paymentListQuery)) q: PaymentListQuery,
  ): Promise<PaymentDto[]> {
    return this.payments.list(auth, propertyId, q);
  }

  @Get('payments/:id')
  @RequirePermission('folio.read', P)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('payment')) id: string,
  ): Promise<PaymentDto> {
    return this.payments.get(auth, propertyId, id);
  }

  @Get('payments/:id/receipt')
  @RequirePermission('folio.read', P)
  receipt(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('payment')) id: string,
  ): Promise<ReceiptDto> {
    return this.payments.receipt(auth, propertyId, id);
  }

  @Post('payments')
  @RequirePermission('payment.receive', P)
  async record(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(recordPaymentRequest)) body: RecordPaymentRequest,
    @Req() req: AppRequest,
  ): Promise<PaymentDto> {
    return (await this.payments.record(auth, propertyId, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req)))
      .body;
  }

  @Post('payments/:id/refunds')
  @RequirePermission('payment.refund', P)
  async refund(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('payment')) id: string,
    @Body(new ZodPipe(refundRequest)) body: RefundRequest,
    @Req() req: AppRequest,
  ): Promise<PaymentDto> {
    return (
      await this.payments.refund(auth, propertyId, id, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req))
    ).body;
  }

  /** Keeps the deposit of a cancelled or no-show booking as a fee. */
  @Post('reservations/:reservationId/forfeit-deposit')
  @HttpCode(200)
  @RequirePermission('folio.adjust', P)
  async forfeit(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('reservationId', uuid('reservation')) reservationId: string,
    @Body(new ZodPipe(voidChargeRequest)) body: VoidChargeRequest,
    @Req() req: AppRequest,
  ): Promise<{ amount: string }> {
    return (
      await this.payments.forfeitForReservation(
        auth,
        propertyId,
        reservationId,
        body.reason,
        req.get(IDEMPOTENCY_HEADER),
        requestMeta(req),
      )
    ).body;
  }
}
