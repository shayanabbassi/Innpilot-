import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission, SessionState } from '@innpilot/contracts';
import { AppError } from '../common/app-error';
import type { AppRequest, AuthContext, OperatorContext } from '../common/request';

/**
 * Every route must declare exactly one access policy; the guard rejects routes without one (deny by default).
 *
 * Permission scopes:
 * - `tenant`: needs a tenant-wide role granting the permission (staff admin, audit log).
 * - `any`: the permission on at least one property (lists that are then filtered per property).
 * - `{ propertyParam }`: the permission on the property named by that route parameter.
 */
export type PermissionScope = 'tenant' | 'any' | { propertyParam: string };

export type RoutePolicy =
  | { kind: 'public' }
  | { kind: 'session'; states: SessionState[] }
  /** A platform operator session (separate cookie); tenant sessions never pass. */
  | { kind: 'platform' }
  | { kind: 'permission'; permission: Permission; scope: PermissionScope };

export const POLICY_KEY = 'innpilot:policy';

/** No session needed (login, health). */
export const Public = () => SetMetadata(POLICY_KEY, { kind: 'public' } satisfies RoutePolicy);

/** Any signed-in session in one of `states`, without a specific permission. */
export const SessionOnly = (states: SessionState[] = ['active']) =>
  SetMetadata(POLICY_KEY, { kind: 'session', states } satisfies RoutePolicy);

/** A fully signed-in session holding `permission` in `scope`. */
export const RequirePermission = (permission: Permission, scope: PermissionScope = 'tenant') =>
  SetMetadata(POLICY_KEY, { kind: 'permission', permission, scope } satisfies RoutePolicy);

/** The authenticated caller. Only valid on routes that are not @Public. */
export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const auth = ctx.switchToHttp().getRequest<AppRequest>().auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  return auth;
});

/** A signed-in platform operator (slice 5.7). Tenant sessions are never accepted on these routes. */
export const PlatformOnly = () => SetMetadata(POLICY_KEY, { kind: 'platform' } satisfies RoutePolicy);

export const CurrentOperator = createParamDecorator((_: unknown, ctx: ExecutionContext): OperatorContext => {
  const operator = ctx.switchToHttp().getRequest<AppRequest>().operator;
  if (!operator) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  return operator;
});
