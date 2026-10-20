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
  createAccountRequest,
  IDEMPOTENCY_HEADER,
  journalDraftRequest,
  journalListQuery,
  ledgerQuery,
  periodMonth,
  reopenPeriodRequest,
  reverseJournalRequest,
  trialBalanceQuery,
  updateAccountRequest,
  type AccountDto,
  type CreateAccountRequest,
  type FiscalPeriodDto,
  type JournalDraftRequest,
  type JournalEntryDto,
  type JournalListDto,
  type JournalListQuery,
  type LedgerDto,
  type LedgerQuery,
  type ReopenPeriodRequest,
  type ReverseJournalRequest,
  type TrialBalanceDto,
  type TrialBalanceQuery,
  type UpdateAccountRequest,
} from '@innpilot/contracts';
import { CurrentAuth, RequirePermission } from '../auth/policy';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AccountsService } from './accounts.service';
import { JournalsService } from './journals.service';
import { PeriodsService } from './periods.service';
import { ReportsService } from './reports.service';

const uuid = (what: string) => new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound(what) });

/**
 * The general ledger. The chart and the trial balance span all properties, so every route needs its permission
 * from a tenant-wide role.
 */
@Controller('finance')
export class FinanceController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly journals: JournalsService,
    private readonly periods: PeriodsService,
    private readonly reports: ReportsService,
  ) {}

  // ------------------------------------------------------------------------------------------- accounts

  @Get('accounts')
  @RequirePermission('journal.read')
  listAccounts(@CurrentAuth() auth: AuthContext): Promise<AccountDto[]> {
    return this.accounts.list(auth);
  }

  @Post('accounts')
  @RequirePermission('account.manage')
  createAccount(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createAccountRequest)) body: CreateAccountRequest,
    @Req() req: AppRequest,
  ): Promise<AccountDto> {
    return this.accounts.create(auth, body, requestMeta(req));
  }

  @Patch('accounts/:id')
  @RequirePermission('account.manage')
  updateAccount(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('account')) id: string,
    @Body(new ZodPipe(updateAccountRequest)) body: UpdateAccountRequest,
    @Req() req: AppRequest,
  ): Promise<AccountDto> {
    return this.accounts.update(auth, id, body, requestMeta(req));
  }

  // ------------------------------------------------------------------------------------------- journals

  @Get('journal-entries')
  @RequirePermission('journal.read')
  listJournals(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(journalListQuery)) q: JournalListQuery,
  ): Promise<JournalListDto> {
    return this.journals.list(auth, q);
  }

  @Get('journal-entries/:id')
  @RequirePermission('journal.read')
  getJournal(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('journal entry')) id: string,
  ): Promise<JournalEntryDto> {
    return this.journals.get(auth, id);
  }

  /** Requires an Idempotency-Key header. */
  @Post('journal-entries/draft')
  @RequirePermission('journal.post')
  async createDraft(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(journalDraftRequest)) body: JournalDraftRequest,
    @Req() req: AppRequest,
  ): Promise<JournalEntryDto> {
    return (await this.journals.createDraft(auth, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req))).body;
  }

  @Put('journal-entries/:id')
  @RequirePermission('journal.post')
  updateDraft(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('journal entry')) id: string,
    @Body(new ZodPipe(journalDraftRequest)) body: JournalDraftRequest,
  ): Promise<JournalEntryDto> {
    return this.journals.updateDraft(auth, id, body);
  }

  @Delete('journal-entries/:id')
  @HttpCode(200)
  @RequirePermission('journal.post')
  deleteDraft(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('journal entry')) id: string,
    @Req() req: AppRequest,
  ): Promise<{ id: string }> {
    return this.journals.deleteDraft(auth, id, requestMeta(req));
  }

  /** Requires an Idempotency-Key header. */
  @Post('journal-entries/:id/post')
  @HttpCode(200)
  @RequirePermission('journal.post')
  async post(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('journal entry')) id: string,
    @Req() req: AppRequest,
  ): Promise<JournalEntryDto> {
    return (await this.journals.post(auth, id, req.get(IDEMPOTENCY_HEADER), requestMeta(req))).body;
  }

  /** Requires an Idempotency-Key header. Returns the reversal entry. */
  @Post('journal-entries/:id/reverse')
  @HttpCode(200)
  @RequirePermission('journal.reverse')
  async reverse(
    @CurrentAuth() auth: AuthContext,
    @Param('id', uuid('journal entry')) id: string,
    @Body(new ZodPipe(reverseJournalRequest)) body: ReverseJournalRequest,
    @Req() req: AppRequest,
  ): Promise<JournalEntryDto> {
    return (await this.journals.reverse(auth, id, body, req.get(IDEMPOTENCY_HEADER), requestMeta(req))).body;
  }

  // ------------------------------------------------------------------------------------------- reports

  @Get('ledger')
  @RequirePermission('journal.read')
  ledger(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(ledgerQuery)) q: LedgerQuery,
  ): Promise<LedgerDto> {
    return this.reports.ledger(auth, q);
  }

  @Get('trial-balance')
  @RequirePermission('journal.read')
  trialBalance(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodPipe(trialBalanceQuery)) q: TrialBalanceQuery,
  ): Promise<TrialBalanceDto> {
    return this.reports.trialBalance(auth, q);
  }

  // ------------------------------------------------------------------------------------------- periods

  @Get('periods')
  @RequirePermission('journal.read')
  listPeriods(@CurrentAuth() auth: AuthContext): Promise<FiscalPeriodDto[]> {
    return this.periods.list(auth);
  }

  @Post('periods/:month/close')
  @HttpCode(200)
  @RequirePermission('period.close')
  closePeriod(
    @CurrentAuth() auth: AuthContext,
    @Param('month', new ZodPipe(periodMonth)) month: string,
    @Req() req: AppRequest,
  ): Promise<FiscalPeriodDto[]> {
    return this.periods.close(auth, month, requestMeta(req));
  }

  @Post('periods/:month/reopen')
  @HttpCode(200)
  @RequirePermission('period.reopen')
  reopenPeriod(
    @CurrentAuth() auth: AuthContext,
    @Param('month', new ZodPipe(periodMonth)) month: string,
    @Body(new ZodPipe(reopenPeriodRequest)) body: ReopenPeriodRequest,
    @Req() req: AppRequest,
  ): Promise<FiscalPeriodDto[]> {
    return this.periods.reopen(auth, month, body, requestMeta(req));
  }
}
