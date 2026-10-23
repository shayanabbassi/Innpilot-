import { Injectable } from '@nestjs/common';
import { schema } from '@innpilot/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { OperatorContext } from '../common/request';
import { Db } from '../db/db.module';
import { randomToken, sha256 } from '../auth/crypto';

/** Operator sessions are shorter than staff sessions: 30 minutes idle, 8 hours at most. */
const IDLE_MS = 30 * 60_000;
const ABSOLUTE_MS = 8 * 3_600_000;
const TOUCH_INTERVAL_MS = 60_000;

export interface NewPlatformSession {
  token: string;
  csrfToken: string;
  absoluteExpiresAt: Date;
}

/**
 * Sessions of platform operators, kept apart from tenant sessions (own table, own cookie). Platform tables hold no
 * tenant data, so they are read without a tenant scope.
 */
@Injectable()
export class PlatformSessionService {
  constructor(private readonly db: Db) {}

  async create(input: {
    operatorId: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<NewPlatformSession> {
    const token = randomToken();
    const csrfToken = randomToken();
    const now = Date.now();
    const absoluteExpiresAt = new Date(now + ABSOLUTE_MS);
    await this.db.unscoped.insert(schema.platformSessions).values({
      operatorId: input.operatorId,
      tokenHash: sha256(token),
      csrfTokenHash: sha256(csrfToken),
      idleExpiresAt: new Date(Math.min(now + IDLE_MS, absoluteExpiresAt.getTime())),
      absoluteExpiresAt,
      ip: input.ip,
      userAgent: input.userAgent?.slice(0, 500) ?? null,
    });
    return { token, csrfToken, absoluteExpiresAt };
  }

  async resolve(token: string): Promise<{ operator: OperatorContext; csrfTokenHash: Buffer } | null> {
    if (!token || token.length > 100) return null;
    const now = new Date();
    const s = schema.platformSessions;
    const o = schema.platformOperators;
    const [row] = await this.db.unscoped
      .select({ session: s, operator: o })
      .from(s)
      .innerJoin(o, eq(o.id, s.operatorId))
      .where(
        and(
          eq(s.tokenHash, sha256(token)),
          isNull(s.revokedAt),
          gt(s.idleExpiresAt, now),
          gt(s.absoluteExpiresAt, now),
        ),
      );
    if (!row) return null;
    if (row.operator.status !== 'active') {
      await this.revoke(row.session.id);
      return null;
    }
    if (now.getTime() - row.session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.unscoped
        .update(s)
        .set({
          lastSeenAt: now,
          idleExpiresAt: new Date(Math.min(now.getTime() + IDLE_MS, row.session.absoluteExpiresAt.getTime())),
        })
        .where(eq(s.id, row.session.id));
    }
    return {
      csrfTokenHash: row.session.csrfTokenHash,
      operator: {
        sessionId: row.session.id,
        operatorId: row.operator.id,
        email: row.operator.email,
        fullName: row.operator.fullName,
      },
    };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.unscoped
      .update(schema.platformSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.platformSessions.id, sessionId), isNull(schema.platformSessions.revokedAt)));
  }
}
