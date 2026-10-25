import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import {
  checkOutRequest,
  IDEMPOTENCY_HEADER,
  type CheckOutRequest,
  type CheckOutResultDto,
  type CheckoutPreviewDto,
  type InvoiceDto,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { InvoiceService } from '../finance/invoice.service';
import { CheckoutService } from './checkout.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

/** Check-out needs `stay.checkout`; the settlement choices check their own permissions. */
@Controller('properties/:propertyId')
export class CheckoutController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly invoices: InvoiceService,
  ) {}

  @Get('stays/:stayId/checkout-preview')
  @RequirePermission('stay.checkout', P)
  preview(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('stayId', uuid('stay')) stayId: string,
  ): Promise<CheckoutPreviewDto> {
    return this.checkout.preview(auth, propertyId, stayId);
  }

  /** Requires an Idempotency-Key header. */
  @Post('stays/:stayId/check-out')
  @HttpCode(200)
  @RequirePermission('stay.checkout', P)
  async checkOut(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('stayId', uuid('stay')) stayId: string,
    @Body(new ZodPipe(checkOutRequest)) body: CheckOutRequest,
    @Req() req: AppRequest,
  ): Promise<CheckOutResultDto> {
    return (
      await this.checkout.checkOut(
        auth,
        propertyId,
        stayId,
        body,
        req.get(IDEMPOTENCY_HEADER),
        requestMeta(req),
      )
    ).body;
  }

  @Get('invoices/:id')
  @RequirePermission('folio.read', P)
  invoice(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('invoice')) id: string,
  ): Promise<InvoiceDto> {
    return this.invoices.get(auth, propertyId, id);
  }
}
