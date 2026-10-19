import type { Permission, RoleCode, SessionState } from '@innpilot/contracts';
import type { Request } from 'express';

export interface RoleAssignment {
  role: RoleCode;
  /** null = all properties in the tenant. */
  propertyId: string | null;
}

/** Everything the server knows about the caller. Built only from the session, never from client input. */
export interface AuthContext {
  sessionId: string;
  tenantId: string;
  userId: string;
  sessionState: SessionState;
  assignments: RoleAssignment[];
  /** Active property ids in the tenant. */
  tenantPropertyIds: string[];
  /** Permissions granted on each property (tenant-wide roles included). */
  permissionsByProperty: Map<string, Set<Permission>>;
  /** Permissions from tenant-wide role assignments only. */
  tenantWidePermissions: Set<Permission>;
}

export interface AppRequest extends Request {
  id: string;
  auth?: AuthContext;
}

/** Audit metadata taken from the request. */
export interface RequestMeta {
  requestId: string;
  ip: string | null;
}

export function requestMeta(req: AppRequest): RequestMeta {
  return { requestId: req.id, ip: req.ip ?? null };
}
