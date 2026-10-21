import { z } from 'zod';
import { loginRequest, mfaCodeRequest } from './auth';
import { uuid } from './common';

/**
 * Platform administration (slice 5.7, D16). Operators are a separate identity with their own cookie; a tenant
 * session never reaches these endpoints and an operator session never reaches tenant ones.
 */

export function platformSessionCookieName(secure: boolean): string {
  return secure ? '__Host-ip_op_session' : 'ip_op_session';
}

/** Readable by the operator console's JavaScript, which echoes it in the CSRF header. */
export function platformCsrfCookieName(secure: boolean): string {
  return secure ? '__Host-ip_op_csrf' : 'ip_op_csrf';
}

/** Password and authenticator code together: an operator can never hold a session without MFA. */
export const platformLoginRequest = loginRequest.extend(mfaCodeRequest.shape).strict();
export type PlatformLoginRequest = z.infer<typeof platformLoginRequest>;

export const operatorDto = z.object({ id: uuid, email: z.string(), fullName: z.string() });
export type OperatorDto = z.infer<typeof operatorDto>;

export const TENANT_STATUSES = ['trial', 'active', 'suspended', 'closed'] as const;
export const TENANT_PLANS = ['starter', 'growth'] as const;
export const ROOM_BANDS = ['up_to_20', 'up_to_50', 'up_to_100'] as const;
export type RoomBand = (typeof ROOM_BANDS)[number];
export const ROOM_BAND_LIMIT: Record<RoomBand, number> = { up_to_20: 20, up_to_50: 50, up_to_100: 100 };

export const platformTenantDto = z.object({
  id: uuid,
  slug: z.string(),
  legalName: z.string(),
  displayName: z.string(),
  status: z.enum(TENANT_STATUSES),
  plan: z.enum(TENANT_PLANS),
  roomBand: z.enum(ROOM_BANDS),
  createdAt: z.string(),
  properties: z.number().int(),
  rooms: z.number().int(),
  users: z.number().int(),
  lastSignIn: z.string().nullable(),
  /** More active rooms than the plan's band covers. */
  overBand: z.boolean(),
});
export type PlatformTenantDto = z.infer<typeof platformTenantDto>;

const reason = z.string().trim().min(10, 'Give a reason (at least 10 characters).').max(500);

export const updateTenantRequest = z
  .object({
    status: z.enum(TENANT_STATUSES).optional(),
    plan: z.enum(TENANT_PLANS).optional(),
    roomBand: z.enum(ROOM_BANDS).optional(),
    reason,
  })
  .strict()
  .refine((v) => v.status || v.plan || v.roomBand, { message: 'Change the status, plan or room band.' });
export type UpdateTenantRequest = z.infer<typeof updateTenantRequest>;

export const SUPPORT_MINUTES = [15, 30, 60, 120, 240] as const;
export const grantAccessRequest = z
  .object({
    reason,
    minutes: z.coerce
      .number()
      .int()
      .refine(
        (m) => (SUPPORT_MINUTES as readonly number[]).includes(m),
        'Choose 15, 30, 60, 120 or 240 minutes.',
      ),
  })
  .strict();
export type GrantAccessRequest = z.infer<typeof grantAccessRequest>;

export const accessGrantDto = z.object({
  id: uuid,
  operatorName: z.string(),
  reason: z.string(),
  grantedAt: z.string(),
  expiresAt: z.string(),
  endedAt: z.string().nullable(),
  active: z.boolean(),
});
export type AccessGrantDto = z.infer<typeof accessGrantDto>;

export const platformAuditEventDto = z.object({
  id: uuid,
  operatorName: z.string().nullable(),
  action: z.string(),
  tenantId: uuid.nullable(),
  changes: z.record(z.string(), z.unknown()),
  reason: z.string().nullable(),
  occurredAt: z.string(),
});
export type PlatformAuditEventDto = z.infer<typeof platformAuditEventDto>;

export const platformTenantDetailDto = z.object({
  tenant: platformTenantDto,
  /** The calling operator's open grant, if any. */
  activeGrant: accessGrantDto.nullable(),
  grants: z.array(accessGrantDto),
  log: z.array(platformAuditEventDto),
});
export type PlatformTenantDetailDto = z.infer<typeof platformTenantDetailDto>;

/** What an operator may see inside a tenant during a support grant: set-up and staff, no guest or money records. */
export const supportViewDto = z.object({
  grant: accessGrantDto,
  properties: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      businessDate: z.string(),
      status: z.string(),
      timezone: z.string(),
    }),
  ),
  users: z.array(
    z.object({
      id: uuid,
      fullName: z.string(),
      email: z.string(),
      status: z.string(),
      roles: z.array(z.string()),
      mfaEnabled: z.boolean(),
      locked: z.boolean(),
    }),
  ),
  recentActivity: z.array(z.object({ action: z.string(), entityType: z.string(), occurredAt: z.string() })),
});
export type SupportViewDto = z.infer<typeof supportViewDto>;
