import {
  Body,
  Controller,
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
  createSupplierRequest,
  expenseDraftRequest,
  expenseListQuery,
  IDEMPOTENCY_HEADER,
  payExpenseRequest,
  submitExpenseRequest,
  updateSupplierRequest,
  voidExpenseRequest,
  type CreateSupplierRequest,
  type ExpenseAccountDto,
  type ExpenseDraftRequest,
  type ExpenseDto,
  type ExpenseListQuery,
  type PayExpenseRequest,
  type SubmitExpenseRequest,
  type SupplierDto,
  type UpdateSupplierRequest,
  type VoidExpenseRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { ExpenseService } from './expense.service';
import { SuppliersService } from './suppliers.service';

const P = { propertyParam: 'propertyId' } as const;
const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

/** Suppliers are shared by the tenant's properties. Listing needs `expense.write` on a property, changes `supplier.manage`. */
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  @RequirePermission('expense.write', 'any')
  list(@CurrentAuth() auth: AuthContext): Promise<SupplierDto[]> {
    return this.suppliers.list(auth);
  }

  @Post()
  @RequirePermission('supplier.manage', 'any')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createSupplierRequest)) body: CreateSupplierRequest,
    @Req() req: AppRequest,
  ): Promise<SupplierDto> {
    return this.suppliers.create(auth, body, requestMeta(req));
  }

  @Patch(':id')
  @RequirePermission('supplier.manage', 'any')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('supplier')) id: string,
    @Body(new ZodPipe(updateSupplierRequest)) body: UpdateSupplierRequest,
    @Req() req: AppRequest,
  ): Promise<SupplierDto> {
    return this.suppliers.update(auth, id, body, requestMeta(req));
  }
}

/**
 * Expenses and supplier bills. Recording, editing drafts and submitting need `expense.write` (people without
 * `expense.approve`, `expense.pay` or `journal.read` see only their own); approving `expense.approve` (never your
 * own); paying a bill `expense.pay`. Commands need an Idempotency-Key header.
 */
@Controller('properties/:propertyId/expenses')
export class ExpenseController {
  constructor(private readonly expenses: ExpenseService) {}

  @Get()
  @RequirePermission('expense.write', P)
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Query(new ZodPipe(expenseListQuery)) q: ExpenseListQuery,
  ): Promise<ExpenseDto[]> {
    return this.expenses.list(auth, propertyId, q);
  }

  /** Declared before ':id' so the path is not taken for an id. */
  @Get('accounts')
  @RequirePermission('expense.write', P)
  accounts(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
  ): Promise<ExpenseAccountDto[]> {
    return this.expenses.accounts(auth, propertyId);
  }

  @Get(':id')
  @RequirePermission('expense.write', P)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('expense')) id: string,
  ): Promise<ExpenseDto> {
    return this.expenses.get(auth, propertyId, id);
  }

  @Post()
  @RequirePermission('expense.write', P)
  async create(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Body(new ZodPipe(expenseDraftRequest)) body: ExpenseDraftRequest,
    @Req() req: AppRequest,
  ): Promise<ExpenseDto> {
    return (await this.expenses.create(auth, propertyId, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req)))
      .body;
  }

  @Put(':id')
  @RequirePermission('expense.write', P)
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('expense')) id: string,
    @Body(new ZodPipe(expenseDraftRequest)) body: ExpenseDraftRequest,
    @Req() req: AppRequest,
  ): Promise<ExpenseDto> {
    return this.expenses.update(auth, propertyId, id, body, requestMeta(req));
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermission('expense.write', P)
  async submit(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('expense')) id: string,
    @Body(new ZodPipe(submitExpenseRequest)) body: SubmitExpenseRequest,
    @Req() req: AppRequest,
  ): Promise<ExpenseDto> {
    return (
      await this.expenses.submit(auth, propertyId, id, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req))
    ).body;
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('expense.approve', P)
  async approve(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('expense')) id: string,
    @Req() req: AppRequest,
  ): Promise<ExpenseDto> {
    return (await this.expenses.approve(auth, propertyId, id, req.get(IDEMPOTENCY_HEADER), requestMeta(req)))
      .body;
  }

  @Post(':id/pay')
  @RequirePermission('expense.pay', P)
  async pay(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('expense')) id: string,
    @Body(new ZodPipe(payExpenseRequest)) body: PayExpenseRequest,
    @Req() req: AppRequest,
  ): Promise<ExpenseDto> {
    return (
      await this.expenses.pay(auth, propertyId, id, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req))
    ).body;
  }

  @Post(':id/void')
  @HttpCode(200)
  @RequirePermission('expense.write', P)
  async void(
    @CurrentAuth() auth: AuthContext,
    @Param('propertyId') propertyId: string,
    @Param('id', uuid('expense')) id: string,
    @Body(new ZodPipe(voidExpenseRequest)) body: VoidExpenseRequest,
    @Req() req: AppRequest,
  ): Promise<ExpenseDto> {
    return (
      await this.expenses.void(auth, propertyId, id, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req))
    ).body;
  }
}
