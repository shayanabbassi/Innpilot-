import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ROOM_BAND_LIMIT,
  type AccessGrantDto,
  type ChangePasswordRequest,
  type GrantAccessRequest,
  type OperatorDto,
  type PlatformAuditEventDto,
  type PlatformLoginRequest,
  type PlatformTenantDetailDto,
  type PlatformTenantDto,
  type SupportViewDto,
  type UpdateTenantRequest,
} from '@innpilot/contracts';
import { hashPassword, schema, verifyAgainstDummy, verifyPassword } from '@innpilot/db';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config';
import { AppError } from '../common/app-error';
import type { OperatorContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';
import { decryptSecret } from '../auth/crypto';
import { verifyTotp } from '../auth/totp';
import { PlatformSessionService, type NewPlatformSession } from './platform-session.service';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const INVALID = () => new AppError('INVALID_CREDENTIALS', 'The email, password or code is not correct.');

type TenantRow = {
  id: string;
  slug: string;
  legal_name: string;
  display_name: string;
  status: PlatformTenantDto['status'];
  plan: PlatformTenantDto['plan'];
  room_band: PlatformTenantDto['roomBand'];
  created_at: string | Date;
  properties: number;
  rooms: number;
  users: number;
  last_sign_in: string | Date | null;
};

const iso = (v: string | Date) => new Date(v).toISOString();

/**
 * Platform administration (slice 5.7, D16). Operators see tenant metadata through narrow database functions; inside
 * a tenant they see only what a support grant allows, for its duration, and every step is written to the platform
 * audit log and to the tenant's own audit log.
 */
@Injectable()
export class PlatformService {
  private readonly logger = new Logger('PlatformService');
  private readonly mfaKey: Buffer;

  constructor(
    private readonly db: Db,
    private readonly sessions: PlatformSessionService,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.mfaKey = Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64url');
  }

  // ------------------------------------------------------------------------------------------- sign-in

  async login(
    body: PlatformLoginRequest,
    meta: RequestMeta & { userAgent: string | null },
  ): Promise<{ operator: OperatorDto; session: NewPlatformSession }> {
    const o = schema.platformOperators;
    const [op] = await this.db.unscoped.select().from(o).where(eq(o.email, body.email));
    if (!op) {
      await verifyAgainstDummy(body.password);
      this.logger.warn({ requestId: meta.requestId }, 'Platform login failed: unknown account');
      throw INVALID();
    }
    if (op.lockedUntil && op.lockedUntil > new Date()) {
      throw new AppError(
        'ACCOUNT_LOCKED',
        `Too many failed sign-in attempts. Try again after ${LOCKOUT_MINUTES} minutes.`,
      );
    }
    const passwordOk = await verifyPassword(op.passwordHash, body.password);
    const step = passwordOk
      ? verifyTotp(decryptSecret(op.mfaSecretEnc, this.mfaKey), body.code, {
          lastUsedStep: op.mfaLastUsedStep,
        })
      : null;
    if (step === null) {
      const failed = op.failedAttempts + 1;
      await this.db.unscoped
        .update(o)
        .set({
          failedAttempts: failed >= MAX_FAILED_ATTEMPTS ? 0 : failed,
          lockedUntil:
            failed >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : op.lockedUntil,
        })
        .where(eq(o.id, op.id));
      await this.log(
        op.id,
        'platform.login_failed',
        null,
        { locked: failed >= MAX_FAILED_ATTEMPTS },
        null,
        meta,
      );
      throw INVALID();
    }
    if (op.status !== 'active') throw AppError.forbidden('This operator account is disabled.');

    await this.db.unscoped
      .update(o)
      .set({ failedAttempts: 0, lockedUntil: null, mfaLastUsedStep: step })
      .where(eq(o.id, op.id));
    const session = await this.sessions.create({ operatorId: op.id, ip: meta.ip, userAgent: meta.userAgent });
    await this.log(op.id, 'platform.login', null, {}, null, meta);
    return { operator: { id: op.id, email: op.email, fullName: op.fullName }, session };
  }

  async logout(operator: OperatorContext, meta: RequestMeta): Promise<void> {
    await this.sessions.revoke(operator.sessionId);
    await this.log(operator.operatorId, 'platform.logout', null, {}, null, meta);
  }

  /** An operator changes their own password (current one required); their other sessions end. */
  async changePassword(
    operator: OperatorContext,
    body: ChangePasswordRequest,
    meta: RequestMeta,
  ): Promise<void> {
    const o = schema.platformOperators;
    const [op] = await this.db.unscoped.select().from(o).where(eq(o.id, operator.operatorId));
    if (!op || !(await verifyPassword(op.passwordHash, body.currentPassword))) {
      await this.log(operator.operatorId, 'platform.password_change_failed', null, {}, null, meta);
      throw AppError.validation('The current password is not correct.', [
        { path: 'currentPassword', message: 'The current password is not correct.' },
      ]);
    }
    await this.db.unscoped
      .update(o)
      .set({ passwordHash: await hashPassword(body.newPassword) })
      .where(eq(o.id, op.id));
    await this.db.unscoped
      .update(schema.platformSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.platformSessions.operatorId, op.id),
          isNull(schema.platformSessions.revokedAt),
          ne(schema.platformSessions.id, operator.sessionId),
        ),
      );
    await this.log(operator.operatorId, 'platform.password_changed', null, {}, null, meta);
  }

  // ------------------------------------------------------------------------------------------- tenants

  async tenants(): Promise<PlatformTenantDto[]> {
    const { rows } = await this.db.unscoped.execute<TenantRow>(sql`select * from platform_tenants()`);
    return rows.map(tenantDto);
  }

  async tenant(operator: OperatorContext, tenantId: string): Promise<PlatformTenantDetailDto> {
    const tenant = await this.findTenant(tenantId);
    const grants = await this.db.tenant(tenantId, (tx) =>
      tx
        .select({ g: schema.tenantAccessGrants, name: schema.platformOperators.fullName })
        .from(schema.tenantAccessGrants)
        .innerJoin(
          schema.platformOperators,
          eq(schema.platformOperators.id, schema.tenantAccessGrants.operatorId),
        )
        .orderBy(desc(schema.tenantAccessGrants.grantedAt))
        .limit(50),
    );
    const a = schema.platformAuditEvents;
    const log = await this.db.unscoped
      .select({ e: a, name: schema.platformOperators.fullName })
      .from(a)
      .leftJoin(schema.platformOperators, eq(schema.platformOperators.id, a.operatorId))
      .where(eq(a.targetTenantId, tenantId))
      .orderBy(desc(a.occurredAt))
      .limit(100);
    const all = grants.map((x) => grantDto(x.g, x.name));
    return {
      tenant,
      activeGrant:
        all.find(
          (g) => g.active && grants.find((x) => x.g.id === g.id)!.g.operatorId === operator.operatorId,
        ) ?? null,
      grants: all,
      log: log.map((x) => auditDto(x.e, x.name)),
    };
  }

  /** Status, plan and room band, with a reason. Suspending takes effect on the tenant's next request. */
  async updateTenant(
    operator: OperatorContext,
    tenantId: string,
    body: UpdateTenantRequest,
    meta: RequestMeta,
  ): Promise<PlatformTenantDto> {
    const before = await this.findTenant(tenantId);
    const next = {
      status: body.status ?? before.status,
      plan: body.plan ?? before.plan,
      roomBand: body.roomBand ?? before.roomBand,
    };
    await this.db.unscoped.execute(
      sql`select platform_set_tenant(${tenantId}::uuid, ${next.status}, ${next.plan}, ${next.roomBand})`,
    );
    const changes: Record<string, { from: string; to: string }> = {};
    for (const k of ['status', 'plan', 'roomBand'] as const) {
      if (before[k] !== next[k]) changes[k] = { from: before[k], to: next[k] };
    }
    await this.log(operator.operatorId, 'platform.tenant_updated', tenantId, changes, body.reason, meta);
    // The hotel sees in its own audit log that the platform changed its account, and why.
    await this.tenantAudit(tenantId, operator, 'platform.tenant_updated', changes, body.reason, meta);
    return this.findTenant(tenantId);
  }

  // ------------------------------------------------------------------------------------------- support access

  async grantAccess(
    operator: OperatorContext,
    tenantId: string,
    body: GrantAccessRequest,
    meta: RequestMeta,
  ): Promise<AccessGrantDto> {
    await this.findTenant(tenantId);
    const g = schema.tenantAccessGrants;
    const row = await this.db.tenant(tenantId, async (tx) => {
      // One open grant per operator and tenant: a new one ends the previous.
      await tx
        .update(g)
        .set({ endedAt: new Date() })
        .where(and(eq(g.operatorId, operator.operatorId), isNull(g.endedAt), gt(g.expiresAt, new Date())));
      const now = new Date();
      const [created] = await tx
        .insert(g)
        .values({
          tenantId,
          operatorId: operator.operatorId,
          reason: body.reason,
          grantedAt: now,
          expiresAt: new Date(now.getTime() + body.minutes * 60_000),
        })
        .returning();
      return created!;
    });
    const changes = { grantId: row.id, minutes: body.minutes, expiresAt: row.expiresAt.toISOString() };
    await this.log(operator.operatorId, 'platform.access_granted', tenantId, changes, body.reason, meta);
    await this.tenantAudit(tenantId, operator, 'platform.access_granted', changes, body.reason, meta);
    return grantDto(row, operator.fullName);
  }

  async endAccess(operator: OperatorContext, tenantId: string, meta: RequestMeta): Promise<void> {
    await this.findTenant(tenantId);
    const g = schema.tenantAccessGrants;
    const ended = await this.db.tenant(tenantId, (tx) =>
      tx
        .update(g)
        .set({ endedAt: new Date() })
        .where(and(eq(g.operatorId, operator.operatorId), isNull(g.endedAt), gt(g.expiresAt, new Date())))
        .returning({ id: g.id }),
    );
    if (ended.length === 0) throw new AppError('CONFLICT', 'You have no open support access to this hotel.');
    await this.log(
      operator.operatorId,
      'platform.access_ended',
      tenantId,
      { grantId: ended[0]!.id },
      null,
      meta,
    );
    await this.tenantAudit(
      tenantId,
      operator,
      'platform.access_ended',
      { grantId: ended[0]!.id },
      null,
      meta,
    );
  }

  /**
   * Inside the tenant, during an open grant only: properties, staff accounts and recent activity, for support.
   * No guest, folio, payment or ledger records. Every read is audited on both sides.
   */
  async supportView(operator: OperatorContext, tenantId: string, meta: RequestMeta): Promise<SupportViewDto> {
    await this.findTenant(tenantId);
    const g = schema.tenantAccessGrants;
    const view = await this.db.tenant(tenantId, async (tx) => {
      const [grant] = await tx
        .select()
        .from(g)
        .where(and(eq(g.operatorId, operator.operatorId), isNull(g.endedAt), gt(g.expiresAt, new Date())))
        .orderBy(desc(g.grantedAt))
        .limit(1);
      if (!grant) {
        throw AppError.forbidden(
          'Open support access to this hotel first, with a reason. Access is time-bound.',
        );
      }
      const properties = await tx
        .select({
          id: schema.properties.id,
          name: schema.properties.name,
          businessDate: schema.properties.businessDate,
          status: schema.properties.status,
          timezone: schema.properties.timezone,
        })
        .from(schema.properties)
        .orderBy(schema.properties.name);
      const users = await tx.execute<{
        id: string;
        full_name: string;
        email: string;
        status: string;
        roles: string[] | null;
        mfa: boolean;
        locked: boolean;
      }>(sql`
        select u.id, u.full_name, u.email::text, u.status,
               array_remove(array_agg(distinct r.role_code), null) as roles,
               u.mfa_enabled_at is not null as mfa, coalesce(u.locked_until > now(), false) as locked
        from users u left join user_roles r on r.user_id = u.id
        group by u.id order by u.full_name`);
      const activity = await tx
        .select({
          action: schema.auditEvents.action,
          entityType: schema.auditEvents.entityType,
          occurredAt: schema.auditEvents.occurredAt,
        })
        .from(schema.auditEvents)
        .orderBy(desc(schema.auditEvents.occurredAt))
        .limit(50);
      return {
        grant: grantDto(grant, operator.fullName),
        properties,
        users: users.rows.map((u) => ({
          id: u.id,
          fullName: u.full_name,
          email: u.email,
          status: u.status,
          roles: u.roles ?? [],
          mfaEnabled: u.mfa,
          locked: u.locked,
        })),
        recentActivity: activity.map((x) => ({ ...x, occurredAt: x.occurredAt.toISOString() })),
      };
    });
    await this.log(
      operator.operatorId,
      'platform.support_read',
      tenantId,
      { grantId: view.grant.id },
      null,
      meta,
    );
    await this.tenantAudit(
      tenantId,
      operator,
      'platform.support_read',
      { grantId: view.grant.id },
      null,
      meta,
    );
    return view;
  }

  async auditLog(): Promise<PlatformAuditEventDto[]> {
    const a = schema.platformAuditEvents;
    const rows = await this.db.unscoped
      .select({ e: a, name: schema.platformOperators.fullName })
      .from(a)
      .leftJoin(schema.platformOperators, eq(schema.platformOperators.id, a.operatorId))
      .orderBy(desc(a.occurredAt))
      .limit(200);
    return rows.map((x) => auditDto(x.e, x.name));
  }

  // ------------------------------------------------------------------------------------------- internals

  private async findTenant(tenantId: string): Promise<PlatformTenantDto> {
    const { rows } = await this.db.unscoped.execute<TenantRow>(
      sql`select * from platform_tenants() where id = ${tenantId}::uuid`,
    );
    if (!rows[0]) throw AppError.notFound('hotel');
    return tenantDto(rows[0]);
  }

  private async log(
    operatorId: string | null,
    action: string,
    tenantId: string | null,
    changes: Record<string, unknown>,
    reason: string | null,
    meta: RequestMeta,
  ): Promise<void> {
    await this.db.unscoped.insert(schema.platformAuditEvents).values({
      operatorId,
      action,
      targetTenantId: tenantId,
      changes,
      reason,
      requestId: meta.requestId,
      ip: meta.ip,
    });
  }

  /** The same event in the tenant's own audit log, as a platform actor named in the details. */
  private async tenantAudit(
    tenantId: string,
    operator: OperatorContext,
    action: string,
    changes: Record<string, unknown>,
    reason: string | null,
    meta: RequestMeta,
  ): Promise<void> {
    await this.db.tenant(tenantId, (tx) =>
      tx.insert(schema.auditEvents).values({
        tenantId,
        actorType: 'platform',
        action,
        entityType: 'tenant',
        entityId: tenantId,
        changes: { ...changes, operatorName: operator.fullName, operatorEmail: operator.email },
        reason,
        requestId: meta.requestId,
        ip: meta.ip,
      }),
    );
  }
}

function tenantDto(r: TenantRow): PlatformTenantDto {
  return {
    id: r.id,
    slug: r.slug,
    legalName: r.legal_name,
    displayName: r.display_name,
    status: r.status,
    plan: r.plan,
    roomBand: r.room_band,
    createdAt: iso(r.created_at),
    properties: r.properties,
    rooms: r.rooms,
    users: r.users,
    lastSignIn: r.last_sign_in ? iso(r.last_sign_in) : null,
    overBand: r.rooms > ROOM_BAND_LIMIT[r.room_band],
  };
}

function grantDto(g: typeof schema.tenantAccessGrants.$inferSelect, operatorName: string): AccessGrantDto {
  return {
    id: g.id,
    operatorName,
    reason: g.reason,
    grantedAt: g.grantedAt.toISOString(),
    expiresAt: g.expiresAt.toISOString(),
    endedAt: g.endedAt?.toISOString() ?? null,
    active: !g.endedAt && g.expiresAt > new Date(),
  };
}

function auditDto(
  e: typeof schema.platformAuditEvents.$inferSelect,
  operatorName: string | null,
): PlatformAuditEventDto {
  return {
    id: e.id,
    operatorName,
    action: e.action,
    tenantId: e.targetTenantId,
    changes: e.changes,
    reason: e.reason,
    occurredAt: e.occurredAt.toISOString(),
  };
}
