import { z } from 'zod';
import { permission, roleCode } from './rbac';

export const PASSWORD_MIN_LENGTH = 12;
export const password = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(128, 'Use at most 128 characters.');

export const loginRequest = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  // Not validated against the policy: existing passwords are checked, not re-judged.
  password: z.string().min(1, 'Enter your password.').max(128),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const mfaCodeRequest = z.object({
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app.'),
});
export type MfaCodeRequest = z.infer<typeof mfaCodeRequest>;

/**
 * What the session may do next:
 * - `active`: fully signed in.
 * - `mfa_verify`: password accepted; a TOTP code is required.
 * - `mfa_enroll`: password accepted; the user's role requires MFA and they must set it up first.
 */
export const sessionState = z.enum(['active', 'mfa_verify', 'mfa_enroll']);
export type SessionState = z.infer<typeof sessionState>;

export const loginResponse = z.object({ sessionState });
export type LoginResponse = z.infer<typeof loginResponse>;

export const mfaSetupResponse = z.object({
  /** otpauth:// URI for authenticator apps (render as a QR code). */
  otpauthUri: z.string(),
  /** Base32 secret for manual entry. */
  secret: z.string(),
});
export type MfaSetupResponse = z.infer<typeof mfaSetupResponse>;

export const propertyAccess = z.object({
  id: z.string().uuid(),
  name: z.string(),
  timezone: z.string(),
  currencyCode: z.string(),
  businessDate: z.string(),
  roles: z.array(roleCode),
  permissions: z.array(permission),
});
export type PropertyAccess = z.infer<typeof propertyAccess>;

export const meResponse = z.object({
  sessionState,
  user: z.object({ id: z.string().uuid(), email: z.string(), fullName: z.string(), mfaEnabled: z.boolean() }),
  tenant: z.object({ id: z.string().uuid(), displayName: z.string(), baseCurrency: z.string() }),
  /** Empty until the session state is `active`. */
  properties: z.array(propertyAccess),
  /** Permissions from tenant-wide roles; tenant-level screens (staff, audit log) need these. */
  tenantPermissions: z.array(permission),
});
export type MeResponse = z.infer<typeof meResponse>;

/** Header carrying the CSRF token on every state-changing request. */
export const CSRF_HEADER = 'x-csrf-token';
/** Header for retry-safe commands (payments, refunds, postings, night audit). */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/** `__Host-` cookies are locked to HTTPS, path "/" and the exact host, so they are used whenever Secure is on. */
export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-ip_session' : 'ip_session';
}

/** Readable by the web app's JavaScript, which echoes it in the CSRF header. */
export function csrfCookieName(secure: boolean): string {
  return secure ? '__Host-ip_csrf' : 'ip_csrf';
}
