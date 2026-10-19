import { describe, expect, it } from 'vitest';
import { buildAccess, isSubset, sessionState } from './access';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const OTHER_TENANT_PROPERTY = '33333333-3333-4333-8333-333333333333';

describe('buildAccess', () => {
  it('applies tenant-wide roles to every property', () => {
    const access = buildAccess([{ role: 'front_desk', propertyId: null }], [P1, P2]);
    expect(access.permissionsByProperty.get(P1)?.has('stay.checkin')).toBe(true);
    expect(access.permissionsByProperty.get(P2)?.has('stay.checkin')).toBe(true);
    expect(access.tenantWidePermissions.has('stay.checkin')).toBe(true);
  });

  it('keeps property roles on their own property and out of tenant-wide permissions', () => {
    const access = buildAccess([{ role: 'hotel_manager', propertyId: P1 }], [P1, P2]);
    expect(access.permissionsByProperty.get(P1)?.has('user.manage')).toBe(true);
    expect(access.permissionsByProperty.has(P2)).toBe(false);
    expect(access.tenantWidePermissions.size).toBe(0);
  });

  it("ignores an assignment for a property that is not one of the tenant's", () => {
    const access = buildAccess([{ role: 'tenant_owner', propertyId: OTHER_TENANT_PROPERTY }], [P1]);
    expect(access.permissionsByProperty.size).toBe(0);
  });

  it('merges multiple roles', () => {
    const access = buildAccess(
      [
        { role: 'housekeeping', propertyId: null },
        { role: 'cashier', propertyId: P1 },
      ],
      [P1, P2],
    );
    expect(access.permissionsByProperty.get(P1)?.has('payment.receive')).toBe(true);
    expect(access.permissionsByProperty.get(P1)?.has('housekeeping.write')).toBe(true);
    expect(access.permissionsByProperty.get(P2)?.has('payment.receive')).toBe(false);
  });
});

describe('sessionState', () => {
  const owner = [{ role: 'tenant_owner' as const, propertyId: null }];
  const desk = [{ role: 'front_desk' as const, propertyId: null }];

  it('requires enrolment for privileged roles without MFA', () => {
    expect(sessionState({ assignments: owner, mfaEnabled: false, sessionMfaVerified: false })).toBe(
      'mfa_enroll',
    );
  });

  it('requires verification once enrolled', () => {
    expect(sessionState({ assignments: owner, mfaEnabled: true, sessionMfaVerified: false })).toBe(
      'mfa_verify',
    );
    expect(sessionState({ assignments: owner, mfaEnabled: true, sessionMfaVerified: true })).toBe('active');
  });

  it('lets non-privileged users in without MFA, but honours voluntary enrolment', () => {
    expect(sessionState({ assignments: desk, mfaEnabled: false, sessionMfaVerified: false })).toBe('active');
    expect(sessionState({ assignments: desk, mfaEnabled: true, sessionMfaVerified: false })).toBe(
      'mfa_verify',
    );
  });
});

describe('isSubset', () => {
  it('detects escalation', () => {
    expect(isSubset(['room.read'], new Set(['room.read', 'room.manage']))).toBe(true);
    expect(isSubset(['room.read', 'period.reopen'], new Set(['room.read']))).toBe(false);
  });
});
