import { Injectable } from '@nestjs/common';
import { schema, type Tx } from '@innpilot/db';
import type { RequestMeta } from '../common/request';

export interface AuditInput {
  tenantId: string;
  propertyId?: string | null;
  actor: { type: 'user'; userId: string } | { type: 'system' };
  /** dotted lower_snake verb, e.g. "user.roles_changed". */
  action: string;
  entityType: string;
  entityId?: string | null;
  /** Redacted before/after summary. Build it with `changeSet` or list safe fields explicitly. */
  changes?: Record<string, unknown>;
  reason?: string | null;
}

/**
 * Writes audit events inside the caller's transaction, so an audited change and its audit record
 * commit or roll back together.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, input: AuditInput, meta: RequestMeta | null): Promise<void> {
    await tx.insert(schema.auditEvents).values({
      tenantId: input.tenantId,
      propertyId: input.propertyId ?? null,
      actorType: input.actor.type,
      actorUserId: input.actor.type === 'user' ? input.actor.userId : null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      changes: input.changes ?? {},
      reason: input.reason ?? null,
      requestId: meta?.requestId ?? null,
      ip: meta?.ip ?? null,
    });
  }
}

/** Before/after values of the listed fields that actually changed. */
export function changeSet<T extends object>(
  before: T,
  after: Partial<T>,
  fields: readonly (keyof T & string)[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of fields) {
    if (f in after && after[f] !== before[f]) out[f] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return out;
}
