import { describe, expect, it } from 'vitest';
import { createTaxCodeRequest, invoiceProfileRequest, ratePercent } from './tax';

describe('tax codes', () => {
  it('accepts percentages from 0 to 100 with up to 4 decimals', () => {
    for (const ok of ['0', '16', '13.5', '7.1234', '100', '100.00'])
      expect(ratePercent.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['101', '100.5', '-1', '16%', '1.23456', 'abc', '']) {
      expect(ratePercent.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('upper-cases the code and defaults the first rate to exclusive', () => {
    const parsed = createTaxCodeRequest.parse({
      code: 'pst',
      name: 'Provincial sales tax',
      firstRate: { effectiveFrom: '2026-07-01', ratePercent: '16' },
    });
    expect(parsed.code).toBe('PST');
    expect(parsed.firstRate.inclusive).toBe(false);
  });
});

describe('invoice profile', () => {
  it('takes at most six registration fields as label/value pairs', () => {
    const base = {
      legalName: null,
      address: null,
      invoicePrefix: 'INV-',
      receiptPrefix: 'RCT-',
      footer: null,
    };
    const field = { label: 'NTN', value: '0000000-0' };
    expect(invoiceProfileRequest.safeParse({ ...base, registrationFields: [field] }).success).toBe(true);
    expect(
      invoiceProfileRequest.safeParse({ ...base, registrationFields: Array(7).fill(field) }).success,
    ).toBe(false);
    expect(
      invoiceProfileRequest.safeParse({ ...base, registrationFields: [], invoicePrefix: 'IN V' }).success,
    ).toBe(false);
  });
});
