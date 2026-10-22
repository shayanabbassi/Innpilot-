import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  changePasswordRequest,
  type ChangePasswordRequest,
  grantAccessRequest,
  platformCsrfCookieName,
  platformLoginRequest,
  platformSessionCookieName,
  updateTenantRequest,
  type AccessGrantDto,
  type GrantAccessRequest,
  type OperatorDto,
  type PlatformAuditEventDto,
  type PlatformLoginRequest,
  type PlatformTenantDetailDto,
  type PlatformTenantDto,
  type SupportViewDto,
  type UpdateTenantRequest,
} from '@innpilot/contracts';
import type { CookieOptions, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';
import { AppError } from '../common/app-error';
import { requestMeta, type AppRequest, type OperatorContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentOperator, PlatformOnly, Public } from '../auth/policy';
import { PlatformService } from './platform.service';

const LOGIN_LIMIT = { default: { limit: 5, ttl: 60_000 } };
const tenantId = new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound('hotel') });

/** Platform administration (slice 5.7). Every route but sign-in needs an operator session. */
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly platform: PlatformService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('auth/login')
  @HttpCode(200)
  @Public()
  @Throttle(LOGIN_LIMIT)
  async login(
    @Body(new ZodPipe(platformLoginRequest)) body: PlatformLoginRequest,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OperatorDto> {
    const { operator, session } = await this.platform.login(body, {
      ...requestMeta(req),
      userAgent: req.get('user-agent') ?? null,
    });
    const base: CookieOptions = {
      secure: this.config.COOKIE_SECURE,
      path: '/',
      expires: session.absoluteExpiresAt,
    };
    res.cookie(platformSessionCookieName(this.config.COOKIE_SECURE), session.token, {
      ...base,
      httpOnly: true,
      sameSite: 'strict',
    });
    res.cookie(platformCsrfCookieName(this.config.COOKIE_SECURE), session.csrfToken, {
      ...base,
      httpOnly: false,
      sameSite: 'strict',
    });
    return operator;
  }

  @Post('auth/logout')
  @HttpCode(200)
  @PlatformOnly()
  async logout(
    @CurrentOperator() operator: OperatorContext,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<null> {
    await this.platform.logout(operator, requestMeta(req));
    const opts: CookieOptions = { secure: this.config.COOKIE_SECURE, path: '/' };
    res.clearCookie(platformSessionCookieName(this.config.COOKIE_SECURE), opts);
    res.clearCookie(platformCsrfCookieName(this.config.COOKIE_SECURE), opts);
    return null;
  }

  @Post('auth/password')
  @HttpCode(200)
  @PlatformOnly()
  @Throttle(LOGIN_LIMIT)
  async changePassword(
    @CurrentOperator() operator: OperatorContext,
    @Body(new ZodPipe(changePasswordRequest)) body: ChangePasswordRequest,
    @Req() req: AppRequest,
  ): Promise<null> {
    await this.platform.changePassword(operator, body, requestMeta(req));
    return null;
  }

  @Get('me')
  @PlatformOnly()
  me(@CurrentOperator() operator: OperatorContext): OperatorDto {
    return { id: operator.operatorId, email: operator.email, fullName: operator.fullName };
  }

  @Get('tenants')
  @PlatformOnly()
  tenants(): Promise<PlatformTenantDto[]> {
    return this.platform.tenants();
  }

  @Get('tenants/:tenantId')
  @PlatformOnly()
  tenant(
    @CurrentOperator() operator: OperatorContext,
    @Param('tenantId', tenantId) id: string,
  ): Promise<PlatformTenantDetailDto> {
    return this.platform.tenant(operator, id);
  }

  @Patch('tenants/:tenantId')
  @PlatformOnly()
  update(
    @CurrentOperator() operator: OperatorContext,
    @Param('tenantId', tenantId) id: string,
    @Body(new ZodPipe(updateTenantRequest)) body: UpdateTenantRequest,
    @Req() req: AppRequest,
  ): Promise<PlatformTenantDto> {
    return this.platform.updateTenant(operator, id, body, requestMeta(req));
  }

  @Post('tenants/:tenantId/access')
  @PlatformOnly()
  grant(
    @CurrentOperator() operator: OperatorContext,
    @Param('tenantId', tenantId) id: string,
    @Body(new ZodPipe(grantAccessRequest)) body: GrantAccessRequest,
    @Req() req: AppRequest,
  ): Promise<AccessGrantDto> {
    return this.platform.grantAccess(operator, id, body, requestMeta(req));
  }

  @Post('tenants/:tenantId/access/end')
  @HttpCode(200)
  @PlatformOnly()
  async endAccess(
    @CurrentOperator() operator: OperatorContext,
    @Param('tenantId', tenantId) id: string,
    @Req() req: AppRequest,
  ): Promise<null> {
    await this.platform.endAccess(operator, id, requestMeta(req));
    return null;
  }

  @Get('tenants/:tenantId/support')
  @PlatformOnly()
  support(
    @CurrentOperator() operator: OperatorContext,
    @Param('tenantId', tenantId) id: string,
    @Req() req: AppRequest,
  ): Promise<SupportViewDto> {
    return this.platform.supportView(operator, id, requestMeta(req));
  }

  @Get('audit')
  @PlatformOnly()
  audit(): Promise<PlatformAuditEventDto[]> {
    return this.platform.auditLog();
  }
}
