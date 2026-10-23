import { describe, expect, it } from 'vitest';
import {
  createGuestRequest,
  guestDocumentInput,
  normalizeDocumentNumber,
  normalizePhone,
  updateGuestRequest,
} from './guests';

describe('normalizePhone', () => {
  it('maps Pakistani local and international formats to one key', () => {
    for (const v of ['0300 1234567', '+92 300 1234567', '0092-300-1234567', '923001234567']) {
      expect(normalizePhone(v), v).toBe('923001234567');
    }
  });
  it('keeps other countries as digits and rejects too-short numbers', () => {
    expect(normalizePhone('+44 20 7946 0958')).toBe('442079460958');
    expect(normalizePhone('12345')).toBeNull();
  });
});

describe('identity documents', () => {
  it('normalises numbers for hashing', () => {
    expect(normalizeDocumentNumber('35202-1234567-1')).toBe('3520212345671');
    expect(normalizeDocumentNumber(' ab 12345 ')).toBe('AB12345');
  });

  it('checks the CNIC and passport formats', () => {
    const cnic = (number: string) =>
      guestDocumentInput.safeParse({ documentType: 'cnic', issuingCountry: 'pk', number }).success;
    expect(cnic('35202-1234567-1')).toBe(true);
    expect(cnic('35202-123456')).toBe(false);
    const passport = (number: string) =>
      guestDocumentInput.safeParse({ documentType: 'passport', issuingCountry: 'GB', number }).success;
    expect(passport('AB1234567')).toBe(true);
    expect(passport('A1')).toBe(false);
  });
});

describe('guest requests', () => {
  it('turns empty optional fields into null and lower-cases email', () => {
    const g = createGuestRequest.parse({
      fullName: ' Ali Demo ',
      phone: '',
      email: 'ALI@Example.TEST',
      city: '',
    });
    expect(g).toMatchObject({ fullName: 'Ali Demo', phone: null, email: 'ali@example.test', city: null });
  });

  it('rejects bad phones, unknown fields and empty updates', () => {
    expect(createGuestRequest.safeParse({ fullName: 'A', phone: '12' }).success).toBe(false);
    expect(createGuestRequest.safeParse({ fullName: 'A', tenantId: 'x' }).success).toBe(false);
    expect(updateGuestRequest.safeParse({}).success).toBe(false);
  });
});
