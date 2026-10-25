import { type CanActivate, type ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_HEADER, platformSessionCookieName, sessionCookieName } from '@innpilot/contracts';
import { APP_CONFIG, type AppConfig } from '../config';
import { AppError } from '../common/app-error';
import type { AppRequest, AuthContext } from '../common/request';
import { safeEqual, sha256 } from './crypto';
import { POLICY_KEY, type RoutePolicy } from './policy';
import { PlatformSessionService } from '../platform/platform-session.service';
import { SessionService } from './session.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global guard. For every route it: requires a declared policy, checks the Origin of state-changing
 * requests, resolves the session from its cookie, checks the CSRF token, gates on MFA state and
 * finally checks the permission in the declared scope.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger('AuthGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly platformSessions: PlatformSessionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AppRequest>();
    const policy = this.reflector.getAllAndOverride<RoutePolicy | undefined>(POLICY_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) {
      this.logger.error(`Route ${req.method} ${req.path} has no access policy; denying.`);
      throw AppError.forbidden();
    }

    const unsafe = !SAFE_METHODS.has(req.method);
    if (unsafe) this.checkOrigin(req);
    if (policy.kind === 'public') return true;
    if (policy.kind === 'platform') return this.checkOperator(req, unsafe);

    const token: unknown = req.cookies?.[sessionCookieName(this.config.COOKIE_SECURE)];
    const resolved = typeof token === 'string' ? await this.sessions.resolve(token) : null;
    if (!resolved) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');

    if (unsafe) {
      const header = req.get(CSRF_HEADER);
      if (!header || !safeEqual(sha256(header), resolved.csrfTokenHash)) {
        throw new AppError(
          'CSRF_FAILED',
          'This request could not be verified. Reload the page and try again.',
        );
      }
    }

    const auth = resolved.auth;
    req.auth = auth;

    const allowedStates = policy.kind === 'session' ? policy.states : ['active'];
    if (!allowedStates.includes(auth.sessionState)) {
      if (auth.sessionState === 'mfa_verify') {
        throw new AppError('MFA_REQUIRED', 'Enter the code from your authenticator app to continue.');
      }
      if (auth.sessionState === 'mfa_enroll') {
        throw new AppError(
          'MFA_ENROLLMENT_REQUIRED',
          'Your role requires two-step verification. Set it up to continue.',
        );
      }
      if (auth.sessionState === 'password_change') {
        throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Choose a new password to continue.');
      }
      throw AppError.forbidden();
    }

    if (policy.kind === 'permission') this.checkPermission(req, auth, policy);
    return true;
  }

  private checkPermission(
    req: AppRequest,
    auth: AuthContext,
    policy: Extract<RoutePolicy, { kind: 'permission' }>,
  ) {
    const { permission, scope } = policy;
    if (scope === 'tenant') {
      if (!auth.tenantWidePermissions.has(permission)) throw AppError.forbidden();
      return;
    }
    if (scope === 'any') {
      for (const perms of auth.permissionsByProperty.values()) if (perms.has(permission)) return;
      throw AppError.forbidden();
    }
    const raw: unknown = req.params[scope.propertyParam];
    const propertyId = typeof raw === 'string' ? raw : undefined;
    // A property the caller cannot see at all is reported as missing, whoever owns it.
    if (!propertyId || !UUID.test(propertyId)) throw AppError.notFound('property');
    const perms = auth.permissionsByProperty.get(propertyId);
    if (!perms) throw AppError.notFound('property');
    if (!perms.has(permission)) throw AppError.forbidden();
  }

  /**
   * Platform routes (slice 5.7): only the operator cookie counts, so a tenant session never passes here, and tenant
   * routes never look at the operator cookie.
   */
  private async checkOperator(req: AppRequest, unsafe: boolean): Promise<boolean> {
    const token: unknown = req.cookies?.[platformSessionCookieName(this.config.COOKIE_SECURE)];
    const resolved = typeof token === 'string' ? await this.platformSessions.resolve(token) : null;
    if (!resolved) throw new AppError('UNAUTHENTICATED', 'Your session has ended. Sign in again.');
    if (unsafe) {
      const header = req.get(CSRF_HEADER);
      if (!header || !safeEqual(sha256(header), resolved.csrfTokenHash)) {
        throw new AppError(
          'CSRF_FAILED',
          'This request could not be verified. Reload the page and try again.',
        );
      }
    }
    req.operator = resolved.operator;
    return true;
  }

  /** Browsers always send Origin on cross-site state-changing requests; reject any we do not serve. */
  private checkOrigin(req: AppRequest): void {
    const origin = req.get('origin');
    if (origin && !this.config.WEB_ORIGINS.includes(origin)) {
      throw new AppError('CSRF_FAILED', 'Requests from this site are not allowed.');
    }
  }
}
