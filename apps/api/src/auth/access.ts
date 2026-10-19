import { ROLES, type Permission, type SessionState } from '@innpilot/contracts';
import type { RoleAssignment } from '../common/request';

export interface AccessSets {
  permissionsByProperty: Map<string, Set<Permission>>;
  tenantWidePermissions: Set<Permission>;
}

/**
 * Expands role assignments into permission sets. A tenant-wide assignment (propertyId null) applies to
 * every property; a property assignment applies only to that property, and only if it is an active
 * property of the tenant.
 */
export function buildAccess(
  assignments: readonly RoleAssignment[],
  tenantPropertyIds: readonly string[],
): AccessSets {
  const tenantWidePermissions = new Set<Permission>();
  for (const a of assignments) {
    if (a.propertyId === null) ROLES[a.role].permissions.forEach((p) => tenantWidePermissions.add(p));
  }
  const permissionsByProperty = new Map<string, Set<Permission>>();
  for (const propertyId of tenantPropertyIds) {
    const perms = new Set(tenantWidePermissions);
    for (const a of assignments) {
      if (a.propertyId === propertyId) ROLES[a.role].permissions.forEach((p) => perms.add(p));
    }
    if (perms.size > 0) permissionsByProperty.set(propertyId, perms);
  }
  return { permissionsByProperty, tenantWidePermissions };
}

export function mfaRequiredByRoles(assignments: readonly RoleAssignment[]): boolean {
  return assignments.some((a) => ROLES[a.role].mfaRequired);
}

/**
 * MFA applies when the user's roles require it or the user enrolled voluntarily. Evaluated on every request,
 * so granting a privileged role takes effect immediately, even for an existing session.
 */
export function sessionState(input: {
  assignments: readonly RoleAssignment[];
  mfaEnabled: boolean;
  sessionMfaVerified: boolean;
}): SessionState {
  if (!mfaRequiredByRoles(input.assignments) && !input.mfaEnabled) return 'active';
  if (!input.mfaEnabled) return 'mfa_enroll';
  if (!input.sessionMfaVerified) return 'mfa_verify';
  return 'active';
}

/** True when every permission of `candidate` is also held in `holder` (used to block privilege escalation). */
export function isSubset(candidate: Iterable<Permission>, holder: ReadonlySet<Permission>): boolean {
  for (const p of candidate) if (!holder.has(p)) return false;
  return true;
}
