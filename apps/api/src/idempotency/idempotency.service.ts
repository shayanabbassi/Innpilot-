import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@innpilot/db';
import { and, eq, lt, sql } from 'drizzle-orm';
import { AppError } from '../common/app-error';

const RETENTION_HOURS = 24;
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Deterministic JSON (sorted keys) so the same logical request always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface IdempotentCommand {
  tenantId: string;
  actorUserId: string;
  /** e.g. "POST /payments". */
  scope: string;
  key: string | undefined;
  body: unknown;
}

export interface StoredResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Exactly-once execution for retry-prone commands (payments, refunds, postings, night audit).
 *
 * Must be called inside the same tenant transaction as the command's writes. The key row is inserted first;
 * a concurrent request with the same key blocks on that row until the first transaction ends, then sees the
 * completed result. If the command fails, its transaction rolls back the key too, so a retry runs again.
 */
@Injectable()
export class IdempotencyService {
  async run<T>(
    tx: Tx,
    cmd: IdempotentCommand,
    execute: () => Promise<{ status: number; body: T }>,
  ): Promise<StoredResult<T>> {
    if (!cmd.key || !KEY_PATTERN.test(cmd.key)) {
      throw AppError.validation(
        'This action needs an Idempotency-Key header of 8–128 letters, digits, "-" or "_".',
      );
    }
    const requestHash = createHash('sha256').update(canonicalJson(cmd.body)).digest('hex');
    const k = schema.idempotencyKeys;
    const match = and(eq(k.tenantId, cmd.tenantId), eq(k.scope, cmd.scope), eq(k.key, cmd.key));

    // An expired key may be reused as if new.
    await tx.delete(k).where(and(match, lt(k.expiresAt, sql`now()`)));

    const inserted = await tx
      .insert(k)
      .values({
        tenantId: cmd.tenantId,
        scope: cmd.scope,
        key: cmd.key,
        actorUserId: cmd.actorUserId,
        requestHash,
        status: 'in_progress',
        expiresAt: sql`now() + make_interval(hours => ${RETENTION_HOURS})`,
      })
      .onConflictDoNothing()
      .returning({ key: k.key });

    if (inserted.length === 0) {
      const [existing] = await tx.select().from(k).where(match);
      if (!existing)
        throw new AppError(
          'IDEMPOTENCY_IN_PROGRESS',
          'This request is still being processed. Try again shortly.',
        );
      if (existing.requestHash !== requestHash || existing.actorUserId !== cmd.actorUserId) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request. Generate a new key for a new action.',
        );
      }
      if (existing.status !== 'completed' || existing.responseStatus === null) {
        throw new AppError(
          'IDEMPOTENCY_IN_PROGRESS',
          'This request is still being processed. Try again shortly.',
        );
      }
      return { status: existing.responseStatus, body: existing.responseBody as T, replayed: true };
    }

    const result = await execute();
    await tx
      .update(k)
      .set({
        status: 'completed',
        responseStatus: result.status,
        responseBody: result.body as unknown as Record<string, unknown>,
        completedAt: sql`now()`,
      })
      .where(match);
    return { ...result, replayed: false };
  }
}
