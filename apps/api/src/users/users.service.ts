import { Injectable } from '@nestjs/common';
import {
  ROLES,
  type CreateUserRequest,
  type Permission,
  type RoleAssignmentDto,
  type RoleCode,
  type UserDto,
} from '@innpilot/contracts';
import { hashPassword, schema, type Tx } from '@innpilot/db';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { isSubset } from '../auth/access';
import { SessionService } from '../auth/session.service';
import { AppError } from '../common/app-error';
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../common/pg-error';
import type { AuthContext, RequestMeta } from '../common/request';
import { Db } from '../db/db.module';

function permissionsOf(roles: readonly RoleAssignmentDto[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const r of roles) ROLES[r.role].permissions.forEach((p) => out.add(p));
  return out;
}

function isTenantOwner(roles: readonly RoleAssignmentDto[]): boolean {
  return roles.some((r) => r.role === 'tenant_owner' && r.propertyId === null);
}

/**
 * Staff administration. Guards against privilege escalation:
 * - an actor can only grant roles whose permissions they hold tenant-wide;
 * - an actor cannot change their own roles, status or MFA, nor any user who holds permissions they lack;
 * - the tenant always keeps at least one active tenant-wide owner.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly db: Db,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  list(auth: AuthContext): Promise<UserDto[]> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const users = await tx.select().from(schema.users).orderBy(asc(schema.users.fullName));
      const roles = await tx.select().from(schema.userRoles);
      return users.map((u) =>
        this.toDto(
          u,
          roles.filter((r) => r.userId === u.id),
        ),
      );
    });
  }

  async create(auth: AuthContext, body: CreateUserRequest, meta: RequestMeta): Promise<UserDto> {
    this.assertAssignable(auth, body.roles);
    const passwordHash = await hashPassword(body.password);
    try {
      return await this.db.tenant(auth.tenantId, async (tx) => {
        const [user] = await tx
          .insert(schema.users)
          .values({
            tenantId: auth.tenantId,
            email: body.email,
            fullName: body.fullName,
            passwordHash,
            createdBy: auth.userId,
          })
          .returning();
        const roles = await this.writeRoles(tx, auth, user!.id, body.roles);
        await this.audit.record(
          tx,
          {
            tenantId: auth.tenantId,
            actor: { type: 'user', userId: auth.userId },
            action: 'user.created',
            entityType: 'user',
            entityId: user!.id,
            changes: { email: body.email, fullName: body.fullName, roles: body.roles },
          },
          meta,
        );
        return this.toDto(user!, roles);
      });
    } catch (err) {
      if (pgErrorCode(err) === PG_UNIQUE_VIOLATION) {
        throw new AppError('CONFLICT', 'An account with this email already exists.', [
          { path: 'email', message: 'This email is already in use.' },
        ]);
      }
      throw err;
    }
  }

  setRoles(
    auth: AuthContext,
    userId: string,
    roles: RoleAssignmentDto[],
    meta: RequestMeta,
  ): Promise<UserDto> {
    this.assertAssignable(auth, roles);
    return this.db.tenant(auth.tenantId, async (tx) => {
      const { user, roles: current } = await this.loadManageable(tx, auth, userId);
      if (isTenantOwner(current) && !isTenantOwner(roles)) await this.assertAnotherOwner(tx, userId);

      await tx.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
      const written = await this.writeRoles(tx, auth, userId, roles);
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: 'user.roles_changed',
          entityType: 'user',
          entityId: userId,
          changes: { roles: { from: current, to: roles } },
        },
        meta,
      );
      return this.toDto(user, written);
    });
  }

  setStatus(
    auth: AuthContext,
    userId: string,
    status: 'active' | 'disabled',
    reason: string,
    meta: RequestMeta,
  ): Promise<UserDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      const { user, roles } = await this.loadManageable(tx, auth, userId);
      if (user.status === status) return this.toDto(user, roles);
      if (status === 'disabled' && isTenantOwner(roles)) await this.assertAnotherOwner(tx, userId);

      const [updated] = await tx
        .update(schema.users)
        .set({ status, ...(status === 'active' ? { failedLoginCount: 0, lockedUntil: null } : {}) })
        .where(eq(schema.users.id, userId))
        .returning();
      const revoked =
        status === 'disabled' ? await this.sessions.revokeAllForUser(tx, userId, 'user_disabled') : 0;
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: status === 'disabled' ? 'user.disabled' : 'user.enabled',
          entityType: 'user',
          entityId: userId,
          changes: { status: { from: user.status, to: status }, sessionsRevoked: revoked },
          reason,
        },
        meta,
      );
      return this.toDto(updated!, roles);
    });
  }

  /** For a lost authenticator: clears MFA so the user re-enrols at next sign-in, and ends their sessions. */
  resetMfa(auth: AuthContext, userId: string, reason: string, meta: RequestMeta): Promise<UserDto> {
    return this.db.tenant(auth.tenantId, async (tx) => {
      await this.loadManageable(tx, auth, userId);
      const [updated] = await tx
        .update(schema.users)
        .set({ mfaSecretEnc: null, mfaEnabledAt: null, mfaLastUsedStep: null })
        .where(eq(schema.users.id, userId))
        .returning();
      const revoked = await this.sessions.revokeAllForUser(tx, userId, 'mfa_reset');
      await this.audit.record(
        tx,
        {
          tenantId: auth.tenantId,
          actor: { type: 'user', userId: auth.userId },
          action: 'user.mfa_reset',
          entityType: 'user',
          entityId: userId,
          changes: { sessionsRevoked: revoked },
          reason,
        },
        meta,
      );
      const roles = await tx.select().from(schema.userRoles).where(eq(schema.userRoles.userId, userId));
      return this.toDto(updated!, roles);
    });
  }

  private assertAssignable(auth: AuthContext, roles: readonly RoleAssignmentDto[]): void {
    const seen = new Set<string>();
    for (const r of roles) {
      const key = `${r.role}:${r.propertyId ?? '*'}`;
      if (seen.has(key)) throw AppError.validation('Each role can be assigned once per property.');
      seen.add(key);
      if (r.propertyId !== null && !auth.tenantPropertyIds.includes(r.propertyId)) {
        throw AppError.validation('Review the highlighted fields.', [
          { path: 'roles', message: 'One of the selected properties does not exist.' },
        ]);
      }
    }
    if (!isSubset(permissionsOf(roles), auth.tenantWidePermissions)) {
      throw AppError.forbidden('You cannot assign a role with more access than your own.');
    }
  }

  /** Loads a user the caller may administer; the caller's own account and their superiors are refused. */
  private async loadManageable(tx: Tx, auth: AuthContext, userId: string) {
    const [user] = await tx.select().from(schema.users).where(eq(schema.users.id, userId)).for('update');
    if (!user) throw AppError.notFound('user');
    if (user.id === auth.userId)
      throw AppError.forbidden('You cannot change your own access. Ask another administrator.');
    const rows = await tx.select().from(schema.userRoles).where(eq(schema.userRoles.userId, userId));
    const roles = rows.map((r) => ({ role: r.roleCode as RoleCode, propertyId: r.propertyId }));
    if (!isSubset(permissionsOf(roles), auth.tenantWidePermissions)) {
      throw AppError.forbidden('This user has access you do not hold, so you cannot change their account.');
    }
    return { user, roles };
  }

  /** Locks the other active owners so two owners cannot remove each other at the same time. */
  private async assertAnotherOwner(tx: Tx, excludingUserId: string): Promise<void> {
    const others = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .innerJoin(schema.userRoles, eq(schema.userRoles.userId, schema.users.id))
      .where(
        and(
          eq(schema.userRoles.roleCode, 'tenant_owner'),
          isNull(schema.userRoles.propertyId),
          eq(schema.users.status, 'active'),
          ne(schema.users.id, excludingUserId),
        ),
      )
      .for('update', { of: schema.users });
    if (others.length === 0) {
      throw new AppError(
        'CONFLICT',
        'The hotel must keep at least one active owner. Add another owner first.',
      );
    }
  }

  private async writeRoles(tx: Tx, auth: AuthContext, userId: string, roles: readonly RoleAssignmentDto[]) {
    return tx
      .insert(schema.userRoles)
      .values(
        roles.map((r) => ({
          tenantId: auth.tenantId,
          userId,
          propertyId: r.propertyId,
          roleCode: r.role,
          createdBy: auth.userId,
        })),
      )
      .returning();
  }

  private toDto(
    u: typeof schema.users.$inferSelect,
    roles: { roleCode?: string; role?: RoleCode; propertyId: string | null }[],
  ): UserDto {
    return {
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      status: u.status,
      mfaEnabled: u.mfaEnabledAt !== null,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      roles: roles.map((r) => ({ role: (r.roleCode ?? r.role) as RoleCode, propertyId: r.propertyId })),
    };
  }
}
