import { describe, expect, it } from 'vitest';
import { createUserRequest, loginRequest, updatePropertyRequest } from './index';

const roles = [{ role: 'front_desk', propertyId: null }];

describe('request schemas', () => {
  it('reports a missing value as "Required", and keeps a schema’s own messages', () => {
    const missing = loginRequest.safeParse({ email: 'owner@example.com' });
    expect(missing.error?.issues).toEqual([
      expect.objectContaining({ path: ['password'], message: 'Required' }),
    ]);
    const own = createUserRequest.safeParse({ email: 'not-an-email', fullName: 'A', password: 'x', roles });
    expect(own.error?.issues.find((i) => i.path[0] === 'email')?.message).toBe(
      'Enter a valid email address.',
    );
  });

  it('normalises login email', () => {
    expect(loginRequest.parse({ email: '  Owner@Example.COM ', password: 'x' }).email).toBe(
      'owner@example.com',
    );
  });

  it('enforces password policy on new users', () => {
    const base = { email: 'a@example.com', fullName: 'A', roles };
    expect(createUserRequest.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(createUserRequest.safeParse({ ...base, password: 'long-enough-pass' }).success).toBe(true);
  });

  it('rejects unknown roles', () => {
    const body = {
      email: 'a@example.com',
      fullName: 'A',
      password: 'long-enough-pass',
      roles: [{ role: 'super_admin', propertyId: null }],
    };
    expect(createUserRequest.safeParse(body).success).toBe(false);
  });

  it('rejects unknown fields such as a client-supplied tenant id', () => {
    const body = {
      email: 'a@example.com',
      fullName: 'A',
      password: 'long-enough-pass',
      roles,
      tenantId: 'x',
    };
    expect(createUserRequest.safeParse(body).success).toBe(false);
  });

  it('validates property time zone and times', () => {
    expect(updatePropertyRequest.safeParse({ timezone: 'Asia/Karachi' }).success).toBe(true);
    expect(updatePropertyRequest.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(updatePropertyRequest.safeParse({ checkInTime: '25:00' }).success).toBe(false);
    expect(updatePropertyRequest.safeParse({}).success).toBe(false);
    expect(updatePropertyRequest.parse({ city: '' }).city).toBeNull();
    expect(updatePropertyRequest.parse({ email: '' }).email).toBeNull();
    expect(updatePropertyRequest.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});
