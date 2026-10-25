import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  changePasswordRequest,
  type ChangePasswordRequest,
  type SessionDto,
  csrfCookieName,
  loginRequest,
  mfaCodeRequest,
  sessionCookieName,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type MfaCodeRequest,
  type MfaSetupResponse,
} from '@innpilot/contracts';
import type { CookieOptions, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../config';
import { requestMeta, type AppRequest, type AuthContext } from '../common/request';
import { ZodPipe } from '../common/zod.pipe';
import { AuthService } from './auth.service';
import { CurrentAuth, Public, SessionOnly } from './policy';
import { AppError } from '../common/app-error';

/** Brute-force limits per client IP, on top of the per-account lockout. */
const LOGIN_LIMIT = { default: { limit: 10, ttl: 60_000 } };
const MFA_LIMIT = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  @Throttle(LOGIN_LIMIT)
  async login(
    @Body(new ZodPipe(loginRequest)) body: LoginRequest,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const { session, sessionState } = await this.auth.login(body, {
      ...requestMeta(req),
      userAgent: req.get('user-agent') ?? null,
    });
    const base: CookieOptions = {
      secure: this.config.COOKIE_SECURE,
      path: '/',
      expires: session.absoluteExpiresAt,
    };
    res.cookie(sessionCookieName(this.config.COOKIE_SECURE), session.token, {
      ...base,
      httpOnly: true,
      sameSite: 'lax',
    });
    res.cookie(csrfCookieName(this.config.COOKIE_SECURE), session.csrfToken, {
      ...base,
      httpOnly: false,
      sameSite: 'strict',
    });
    return { sessionState };
  }

  @Post('logout')
  @HttpCode(200)
  @SessionOnly(['active', 'mfa_verify', 'mfa_enroll', 'password_change'])
  async logout(
    @CurrentAuth() auth: AuthContext,
    @Req() req: AppRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<null> {
    await this.auth.logout(auth, requestMeta(req));
    this.clearCookies(res);
    return null;
  }

  @Get('me')
  @SessionOnly(['active', 'mfa_verify', 'mfa_enroll', 'password_change'])
  me(@CurrentAuth() auth: AuthContext): Promise<MeResponse> {
    return this.auth.me(auth);
  }

  @Post('mfa/setup')
  @HttpCode(200)
  @SessionOnly(['active', 'mfa_enroll'])
  setupMfa(@CurrentAuth() auth: AuthContext): Promise<MfaSetupResponse> {
    return this.auth.setupMfa(auth);
  }

  @Post('mfa/enable')
  @HttpCode(200)
  @SessionOnly(['active', 'mfa_enroll'])
  @Throttle(MFA_LIMIT)
  async enableMfa(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(mfaCodeRequest)) body: MfaCodeRequest,
    @Req() req: AppRequest,
  ): Promise<null> {
    await this.auth.enableMfa(auth, body.code, requestMeta(req));
    return null;
  }

  @Post('mfa/verify')
  @HttpCode(200)
  @SessionOnly(['mfa_verify'])
  @Throttle(MFA_LIMIT)
  async verifyMfa(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(mfaCodeRequest)) body: MfaCodeRequest,
    @Req() req: AppRequest,
  ): Promise<null> {
    await this.auth.verifyMfa(auth, body.code, requestMeta(req));
    return null;
  }

  /** Change your own password; also the way out of a manager-issued reset (state `password_change`). */
  @Post('password')
  @HttpCode(200)
  @SessionOnly(['active', 'password_change'])
  @Throttle(MFA_LIMIT)
  changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(changePasswordRequest)) body: ChangePasswordRequest,
    @Req() req: AppRequest,
  ): Promise<{ sessionsEnded: number }> {
    return this.auth.changePassword(auth, body, requestMeta(req));
  }

  @Get('sessions')
  @SessionOnly(['active'])
  sessions(@CurrentAuth() auth: AuthContext): Promise<SessionDto[]> {
    return this.auth.listSessions(auth);
  }

  @Post('sessions/end-others')
  @HttpCode(200)
  @SessionOnly(['active'])
  endOthers(@CurrentAuth() auth: AuthContext, @Req() req: AppRequest): Promise<{ sessionsEnded: number }> {
    return this.auth.endSessions(auth, null, requestMeta(req));
  }

  @Post('sessions/:id/end')
  @HttpCode(200)
  @SessionOnly(['active'])
  endSession(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => AppError.notFound('session') })) id: string,
    @Req() req: AppRequest,
  ): Promise<{ sessionsEnded: number }> {
    return this.auth.endSessions(auth, id, requestMeta(req));
  }

  private clearCookies(res: Response): void {
    const opts: CookieOptions = { secure: this.config.COOKIE_SECURE, path: '/' };
    res.clearCookie(sessionCookieName(this.config.COOKIE_SECURE), opts);
    res.clearCookie(csrfCookieName(this.config.COOKIE_SECURE), opts);
  }
}
