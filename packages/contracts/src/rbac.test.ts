import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, ROLES, ROLE_CODES } from './rbac';

describe('role definitions', () => {
  it('only reference known permissions, without duplicates', () => {
    for (const code of ROLE_CODES) {
      const perms = ROLES[code].permissions;
      expect(
        perms.every((p) => ALL_PERMISSIONS.includes(p)),
        code,
      ).toBe(true);
      expect(new Set(perms).size, code).toBe(perms.length);
    }
  });

  it('give the owner every permission', () => {
    expect([...ROLES.tenant_owner.permissions].sort()).toEqual([...ALL_PERMISSIONS].sort());
  });

  it('require MFA for every role that can manage users, close periods or post journals', () => {
    const privileged: string[] = [
      'user.manage',
      'period.close',
      'period.reopen',
      'journal.post',
      'tax.configure',
    ];
    for (const code of ROLE_CODES) {
      const role = ROLES[code];
      if (role.permissions.some((p) => privileged.includes(p))) expect(role.mfaRequired, code).toBe(true);
    }
  });

  it('keep the auditor and housekeeping roles free of write permissions', () => {
    const writes = (code: 'read_only_auditor' | 'housekeeping') =>
      ROLES[code].permissions.filter((p) => !p.endsWith('.read') && !p.startsWith('report.'));
    expect(writes('read_only_auditor')).toEqual([]);
    expect(writes('housekeeping')).toEqual(['housekeeping.write']);
  });

  it('do not let front desk or cashier refund, reverse journals or manage users', () => {
    for (const code of ['front_desk', 'cashier'] as const) {
      for (const p of ['payment.refund', 'journal.reverse', 'user.manage', 'report.financial'] as const) {
        expect(ROLES[code].permissions, `${code} ${p}`).not.toContain(p);
      }
    }
  });
});
