import { Inject, Injectable } from '@nestjs/common';
import type { RoleCode } from '@innpilot/contracts';
import { schema, type Tx } from '@innpilot/db';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config';
import type { AuthContext } from '../common/request';
import { Db } from '../db/db.module';
import { buildAccess, sessionState } from './access';
import { randomToken, sha256 } from './crypto';

const TOUCH_INTERVAL_MS = 60_000;
const ACTIVE_TENANT_STATUSES = new Set(['trial', 'active']);

export interface ResolvedSession {
  auth: AuthContext;
  csrfTokenHash: Buffer;
}

export interface NewSession {
  token: string;
  csrfToken: string;
  absoluteExpiresAt: Date;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async create(
    tx: Tx,
    input: {
      tenantId: string;
      userId: string;
      ip: string | null;
      userAgent: string | null;
      mfaVerified: boolean;
    },
  ): Promise<NewSession> {
    const token = randomToken();
    const csrfToken = randomToken();
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + this.config.SESSION_ABSOLUTE_HOURS * 3_600_000);
    await tx.insert(schema.sessions).values({
      tenantId: input.tenantId,
      userId: input.userId,
      tokenHash: sha256(token),
      csrfTokenHash: sha256(csrfToken),
      mfaVerifiedAt: input.mfaVerified ? new Date(now) : null,
      idleExpiresAt: this.idleExpiry(now, absoluteExpiresAt),
      absoluteExpiresAt,
      ip: input.ip,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
    });
    return { token, csrfToken, absoluteExpiresAt };
  }

  /** Looks up a session token and builds the caller's access context, or returns null if it is not valid. */
  async resolve(token: string): Promise<ResolvedSession | null> {
    if (!token || token.length > 100) return null;
    const lookup = await this.db.unscoped.execute<{ session_id: string; tenant_id: string; user_id: string }>(
      sql`select * from auth_resolve_session(${sha256(token)})`,
    );
    const found = lookup.rows[0];
    if (!found) return null;

    return this.db.tenant(found.tenant_id, async (tx) => {
      const [row] = await tx
        .select({
          session: schema.sessions,
          userStatus: schema.users.status,
          mfaEnabledAt: schema.users.mfaEnabledAt,
          passwordChangeRequired: schema.users.passwordChangeRequired,
          tenantStatus: schema.tenants.status,
        })
        .from(schema.sessions)
        .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
        .innerJoin(schema.tenants, eq(schema.tenants.id, schema.sessions.tenantId))
        .where(eq(schema.sessions.id, found.session_id));
      if (!row) return null;

      if (row.userStatus !== 'active' || !ACTIVE_TENANT_STATUSES.has(row.tenantStatus)) {
        await this.revoke(
          tx,
          row.session.id,
          row.userStatus !== 'active' ? 'user_disabled' : 'tenant_inactive',
        );
        return null;
      }

      const [assignments, properties] = await Promise.all([
        tx
          .select({ role: schema.userRoles.roleCode, propertyId: schema.userRoles.propertyId })
          .from(schema.userRoles)
          .where(eq(schema.userRoles.userId, found.user_id)),
        tx
          .select({ id: schema.properties.id })
          .from(schema.properties)
          .where(eq(schema.properties.status, 'active')),
      ]);
      const roleAssignments = assignments.map((a) => ({
        role: a.role as RoleCode,
        propertyId: a.propertyId,
      }));
      const tenantPropertyIds = properties.map((p) => p.id);
      const access = buildAccess(roleAssignments, tenantPropertyIds);

      const now = Date.now();
      if (now - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
        await tx
          .update(schema.sessions)
          .set({
            lastSeenAt: new Date(now),
            idleExpiresAt: this.idleExpiry(now, row.session.absoluteExpiresAt),
          })
          .where(eq(schema.sessions.id, row.session.id));
      }

      return {
        csrfTokenHash: row.session.csrfTokenHash,
        auth: {
          sessionId: row.session.id,
          tenantId: found.tenant_id,
          userId: found.user_id,
          sessionState: sessionState({
            assignments: roleAssignments,
            mfaEnabled: row.mfaEnabledAt !== null,
            sessionMfaVerified: row.session.mfaVerifiedAt !== null,
            passwordChangeRequired: row.passwordChangeRequired,
          }),
          assignments: roleAssignments,
          tenantPropertyIds,
          ...access,
        },
      };
    });
  }

  async markMfaVerified(tx: Tx, sessionId: string): Promise<void> {
    await tx
      .update(schema.sessions)
      .set({ mfaVerifiedAt: new Date() })
      .where(eq(schema.sessions.id, sessionId));
  }

  async revoke(tx: Tx, sessionId: string, reason: string): Promise<void> {
    await tx
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)));
  }

  /** Revokes every live session of a user, optionally keeping the caller's own. Returns how many ended. */
  async revokeAllForUser(tx: Tx, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
    const result = await tx
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(schema.sessions.userId, userId),
          isNull(schema.sessions.revokedAt),
          exceptSessionId ? ne(schema.sessions.id, exceptSessionId) : undefined,
        ),
      );
    return result.rowCount ?? 0;
  }

  private idleExpiry(now: number, absolute: Date): Date {
    return new Date(Math.min(now + this.config.SESSION_IDLE_MINUTES * 60_000, absolute.getTime()));
  }
}
