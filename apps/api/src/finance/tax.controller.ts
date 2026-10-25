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
  Req,
} from '@nestjs/common';
import {
  createChargeCategoryRequest,
  createTaxCodeRequest,
  invoiceProfileRequest,
  taxPreviewRequest,
  taxRateInput,
  updateChargeCategoryRequest,
  updateTaxCodeRequest,
  type ChargeCategoryDto,
  type CreateChargeCategoryRequest,
  type CreateTaxCodeRequest,
  type InvoiceProfileDto,
  type InvoiceProfileRequest,
  type TaxCodeDto,
  type TaxPreviewDto,
  type TaxPreviewRequest,
  type TaxRateInput,
  type UpdateChargeCategoryRequest,
  type UpdateTaxCodeRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { TaxService } from './tax.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

/**
 * Per-property tax setup. Everyone who works with the property can read it (front desk needs the categories to
 * post charges); only `tax.configure` changes it.
 */
@Controller('properties/:propertyId')
export class TaxController {
  constructor(private readonly tax: TaxService) {}

  @Get('tax-codes')
  @RequirePermission('property.read', P)
  listTaxCodes(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<TaxCodeDto[]> {
    return this.tax.listTaxCodes(auth, propertyId);
  }

  @Post('tax-codes')
  @RequirePermission('tax.configure', P)
  createTaxCode(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(createTaxCodeRequest)) body: CreateTaxCodeRequest,
    @Req() req: AppRequest,
  ): Promise<TaxCodeDto> {
    return this.tax.createTaxCode(auth, propertyId, body, requestMeta(req));
  }

  @Patch('tax-codes/:id')
  @RequirePermission('tax.configure', P)
  updateTaxCode(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('tax code')) id: string,
    @Body(new ZodPipe(updateTaxCodeRequest)) body: UpdateTaxCodeRequest,
    @Req() req: AppRequest,
  ): Promise<TaxCodeDto> {
    return this.tax.updateTaxCode(auth, propertyId, id, body, requestMeta(req));
  }

  @Post('tax-codes/:id/rates')
  @RequirePermission('tax.configure', P)
  addRate(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('tax code')) id: string,
    @Body(new ZodPipe(taxRateInput)) body: TaxRateInput,
    @Req() req: AppRequest,
  ): Promise<TaxCodeDto> {
    return this.tax.addRate(auth, propertyId, id, body, requestMeta(req));
  }

  @Delete('tax-codes/:id/rates/:rateId')
  @HttpCode(200)
  @RequirePermission('tax.configure', P)
  removeRate(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('tax code')) id: string,
    @Param('rateId', uuid('tax rate')) rateId: string,
    @Req() req: AppRequest,
  ): Promise<TaxCodeDto> {
    return this.tax.removeRate(auth, propertyId, id, rateId, requestMeta(req));
  }

  @Get('charge-categories')
  @RequirePermission('property.read', P)
  listCategories(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<ChargeCategoryDto[]> {
    return this.tax.listCategories(auth, propertyId);
  }

  @Post('charge-categories')
  @RequirePermission('tax.configure', P)
  createCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(createChargeCategoryRequest)) body: CreateChargeCategoryRequest,
    @Req() req: AppRequest,
  ): Promise<ChargeCategoryDto> {
    return this.tax.createCategory(auth, propertyId, body, requestMeta(req));
  }

  @Patch('charge-categories/:id')
  @RequirePermission('tax.configure', P)
  updateCategory(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('charge category')) id: string,
    @Body(new ZodPipe(updateChargeCategoryRequest)) body: UpdateChargeCategoryRequest,
    @Req() req: AppRequest,
  ): Promise<ChargeCategoryDto> {
    return this.tax.updateCategory(auth, propertyId, id, body, requestMeta(req));
  }

  @Post('tax-preview')
  @HttpCode(200)
  @RequirePermission('property.read', P)
  preview(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(taxPreviewRequest)) body: TaxPreviewRequest,
  ): Promise<TaxPreviewDto> {
    return this.tax.preview(auth, propertyId, body);
  }

  @Get('invoice-profile')
  @RequirePermission('property.read', P)
  getInvoiceProfile(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<InvoiceProfileDto> {
    return this.tax.getInvoiceProfile(auth, propertyId);
  }

  @Put('invoice-profile')
  @RequirePermission('tax.configure', P)
  putInvoiceProfile(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(invoiceProfileRequest)) body: InvoiceProfileRequest,
    @Req() req: AppRequest,
  ): Promise<InvoiceProfileDto> {
    return this.tax.putInvoiceProfile(auth, propertyId, body, requestMeta(req));
  }
}
