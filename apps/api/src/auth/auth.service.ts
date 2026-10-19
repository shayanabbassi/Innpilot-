import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  LoginRequest,
  LoginResponse,
  MeResponse,
  MfaSetupResponse,
  Permission,
  RoleCode,
} from '@innpilot/contracts';
import { schema, verifyAgainstDummy, verifyPassword, type Tx } from '@innpilot/db';
import { eq, inArray, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/app-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { APP_CONFIG, type AppConfig } from '../config';
import { Db } from '../db/db.module';
import { sessionState } from './access';
import { decryptSecret, encryptSecret } from './crypto';
import { SessionService, type NewSession } from './session.service';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;
const ACTIVE_TENANT_STATUSES = new Set(['trial', 'active']);
const INVALID = () => new AppError('INVALID_CREDENTIALS', 'The email or password is incorrect.');

interface LoginRow extends Record<string, unknown> {
  user_id: string;
  tenant_id: string;
  password_hash: string;
  user_status: string;
  tenant_status: string;
  /** Computed with the database clock; raw queries return timestamps as strings. */
  is_locked: boolean;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger('AuthService');
  private readonly mfaKey: Buffer;

  constructor(
    private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.mfaKey = Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64url');
  }

  async login(
    body: LoginRequest,
    meta: RequestMeta & { userAgent: string | null },
  ): Promise<LoginResponse & { session: NewSession }> {
    const { rows } = await this.db.unscoped.execute<LoginRow>(
      sql`select user_id, tenant_id, password_hash, user_status, tenant_status,
                 coalesce(locked_until > now(), false) as is_locked
            from auth_find_login(${body.email})`,
    );
    const found = rows[0];
    if (!found) {
      await verifyAgainstDummy(body.password);
      this.logger.warn({ requestId: meta.requestId }, 'Login failed: unknown account');
      throw INVALID();
    }

    if (found.is_locked) {
      throw new AppError(
        'ACCOUNT_LOCKED',
        `Too many failed sign-in attempts. Try again after ${LOCKOUT_MINUTES} minutes or ask your administrator.`,
      );
    }

    if (!(await verifyPassword(found.password_hash, body.password))) {
      await this.db.tenant(found.tenant_id, (tx) => this.recordFailedAttempt(tx, found, 'password', meta));
      throw INVALID();
    }

    if (found.user_status !== 'active' || !ACTIVE_TENANT_STATUSES.has(found.tenant_status)) {
      throw AppError.forbidden('This account is disabled. Contact your hotel administrator.');
    }

    return this.db.tenant(found.tenant_id, async (tx) => {
      const [user] = await tx
        .select({ mfaEnabledAt: schema.users.mfaEnabledAt })
        .from(schema.users)
        .where(eq(schema.users.id, found.user_id));
      const assignments = await this.assignments(tx, found.user_id);

      await tx
        .update(schema.users)
        .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(schema.users.id, found.user_id));
      const session = await this.sessions.create(tx, {
        tenantId: found.tenant_id,
        userId: found.user_id,
        ip: meta.ip,
        userAgent: meta.userAgent,
        mfaVerified: false,
      });
      await this.audit.record(
        tx,
        {
          tenantId: found.tenant_id,
          actor: { type: 'user', userId: found.user_id },
          action: 'auth.login',
          entityType: 'user',
          entityId: found.user_id,
        },
        meta,
      );
      const state = sessionState({
        assignments,
        mfaEnabled: !!user?.mfaEnabledAt,
        sessionMfaVerified: false,
      });
      return { sessionState: state, session };
    });
  }

  async logout(auth: AuthContext, meta: RequestMeta): Promise<void> {
    await this.db.tenant(auth.tenantId, async (tx) => {
      await this.sessions.revoke(tx, auth.sessionId, 'logout');
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: 'auth.logout',
          entityType: 'user',
          entityId: auth.userId,
        },
        meta,
      );
    });
  }

  async me(auth: AuthContext): Promise<MeResponse> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const [row] = await tx
        .select({ user: schema.users, tenant: schema.tenants })
        .from(schema.users)
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.users.tenantId))
        .where(eq(schema.users.id, auth.userId));
      if (!row) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');

      let properties: MeResponse['properties'] = [];
      if (auth.sessionState === 'active' && auth.permissionsByProperty.size > 0) {
        const rows = await tx
          .select()
          .from(schema.properties)
          .where(inArray(schema.properties.id, [...auth.permissionsByProperty.keys()]))
          .orderBy(schema.properties.name);
        properties = rows.map((p) => ({
          id: p.id,
          name: p.name,
          timezone: p.timezone,
          currencyCode: p.currencyCode,
          businessDate: p.businessDate,
          onboardingCompleted: p.onboardingCompletedAt !== null,
          roles: [
            ...new Set(
              auth.assignments
                .filter((a) => a.propertyId === null || a.propertyId === p.id)
                .map((a) => a.role),
            ),
          ] as RoleCode[],
          permissions: [...(auth.permissionsByProperty.get(p.id) ?? [])].sort() as Permission[],
        }));
      }

      return {
        sessionState: auth.sessionState,
        user: {
          id: row.user.id,
          email: row.user.email,
          fullName: row.user.fullName,
          mfaEnabled: row.user.mfaEnabledAt !== null,
        },
        tenant: {
          id: row.tenant.id,
          displayName: row.tenant.displayName,
          baseCurrency: row.tenant.baseCurrency,
        },
        properties,
        tenantPermissions:
          auth.sessionState === 'active' ? ([...auth.tenantWidePermissions].sort() as Permission[]) : [],
      };
    });
  }

  /** Starts (or restarts) enrolment: stores a new pending secret. MFA is not on until `enableMfa` succeeds. */
  async setupMfa(auth: AuthContext): Promise<MfaSetupResponse> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const user = await this.user(tx, auth.userId);
      if (user.mfaEnabledAt)
        throw new AppError('CONFLICT', 'Two-step verification is already on for this account.');
      const secret = generateTotpSecret();
      await tx
        .update(schema.users)
        .set({ mfaSecretEnc: encryptSecret(secret, this.mfaKey), mfaLastUsedStep: null })
        .where(eq(schema.users.id, auth.userId));
      return { secret, otpauthUri: otpauthUri(secret, user.email) };
    });
  }

  async enableMfa(auth: AuthContext, code: string, meta: RequestMeta): Promise<void> {
    await this.db.tenant(auth.tenantId, async (tx) => {
      const user = await this.user(tx, auth.userId);
      if (user.mfaEnabledAt)
        throw new AppError('CONFLICT', 'Two-step verification is already on for this account.');
      if (!user.mfaSecretEnc) throw new AppError('CONFLICT', 'Start two-step verification setup first.');
      const step = verifyTotp(decryptSecret(user.mfaSecretEnc, this.mfaKey), code);
      if (step === null)
        throw new AppError(
          'INVALID_MFA_CODE',
          'That code is not valid. Check the time on your phone and try again.',
        );

      await tx
        .update(schema.users)
        .set({ mfaEnabledAt: new Date(), mfaLastUsedStep: step })
        .where(eq(schema.users.id, auth.userId));
      await this.sessions.markMfaVerified(tx, auth.sessionId);
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: 'auth.mfa_enabled',
          entityType: 'user',
          entityId: auth.userId,
        },
        meta,
      );
    });
  }

  /**
   * Second sign-in step. A wrong code counts toward the same lockout as a wrong password.
   * Failures are committed in their own transaction so the error does not roll them back.
   */
  async verifyMfa(auth: AuthContext, code: string, meta: RequestMeta): Promise<void> {
    const outcome = await this.db.tenant(auth.tenantId, async (tx) => {
      const user = await this.user(tx, auth.userId);
      if (!user.mfaEnabledAt || !user.mfaSecretEnc)
        throw new AppError('CONFLICT', 'Two-step verification is not set up.');
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) return 'locked' as const;

      const step = verifyTotp(decryptSecret(user.mfaSecretEnc, this.mfaKey), code, {
        lastUsedStep: user.mfaLastUsedStep,
      });
      if (step === null) {
        const locked = await this.recordFailedAttempt(
          tx,
          { user_id: user.id, tenant_id: user.tenantId },
          'mfa',
          meta,
        );
        if (locked) await this.sessions.revoke(tx, auth.sessionId, 'locked');
        return locked ? ('locked' as const) : ('invalid' as const);
      }

      await tx
        .update(schema.users)
        .set({ mfaLastUsedStep: step, failedLoginCount: 0, lockedUntil: null })
        .where(eq(schema.users.id, auth.userId));
      await this.sessions.markMfaVerified(tx, auth.sessionId);
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: 'auth.mfa_verified',
          entityType: 'user',
          entityId: auth.userId,
        },
        meta,
      );
      return 'ok' as const;
    });
    if (outcome === 'locked') {
      throw new AppError(
        'ACCOUNT_LOCKED',
        `Too many failed attempts. Try again after ${LOCKOUT_MINUTES} minutes.`,
      );
    }
    if (outcome === 'invalid') {
      throw new AppError(
        'INVALID_MFA_CODE',
        'That code is not valid. Check the time on your phone and try again.',
      );
    }
  }

  async assignments(tx: Tx, userId: string) {
    const rows = await tx
      .select({ role: schema.userRoles.roleCode, propertyId: schema.userRoles.propertyId })
      .from(schema.userRoles)
      .where(eq(schema.userRoles.userId, userId));
    return rows.map((r) => ({ role: r.role as RoleCode, propertyId: r.propertyId }));
  }

  private async user(tx: Tx, userId: string) {
    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId));
    if (!user) throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
    return user;
  }

  /** Increments the failure counter, locking the account at the threshold. Returns true if now locked. */
  private async recordFailedAttempt(
    tx: Tx,
    user: Pick<LoginRow, 'user_id' | 'tenant_id'>,
    factor: 'password' | 'mfa',
    meta: RequestMeta,
  ): Promise<boolean> {
    const [updated] = await tx
      .update(schema.users)
      .set({
        failedLoginCount: sql`${schema.users.failedLoginCount} + 1`,
        lockedUntil: sql`case when ${schema.users.failedLoginCount} + 1 >= ${MAX_FAILED_ATTEMPTS}
                              then now() + make_interval(mins => ${LOCKOUT_MINUTES}) else ${schema.users.lockedUntil} end`,
      })
      .where(eq(schema.users.id, user.user_id))
      .returning({ count: schema.users.failedLoginCount, lockedUntil: schema.users.lockedUntil });
    const locked = !!updated && updated.count >= MAX_FAILED_ATTEMPTS;
    if (locked) {
      await tx.update(schema.users).set({ failedLoginCount: 0 }).where(eq(schema.users.id, user.user_id));
    }
    await this.audit.record(
      tx,
      {
        tenantId: user.tenant_id,
        actor: { type: 'system' },
        action: locked ? 'auth.account_locked' : 'auth.login_failed',
        entityType: 'user',
        entityId: user.user_id,
        changes: { factor },
      },
      meta,
    );
    return locked;
  }
}
