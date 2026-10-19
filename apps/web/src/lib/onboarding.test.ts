import { ONBOARDING_REQUIRED_FIELDS, type PropertyDto } from '@innpilot/contracts';
import { describe, expect, it } from 'vitest';
import { firstIncompleteStep, STEP_REQUIRED } from './onboarding';

const complete: PropertyDto = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Test Hotel',
  legalName: 'Test Hotel (Pvt) Ltd',
  timezone: 'Asia/Karachi',
  currencyCode: 'PKR',
  addressLine: '1 Road',
  city: 'Lahore',
  countryCode: 'PK',
  phone: '+92 300 0000000',
  email: null,
  checkInTime: '14:00',
  checkOutTime: '12:00',
  businessDate: '2026-10-19',
  status: 'active',
  onboardingCompletedAt: null,
};

describe('onboarding resume step', () => {
  it('starts at business details when they are missing', () => {
    expect(firstIncompleteStep({ ...complete, legalName: null })).toBe('business');
    expect(firstIncompleteStep({ ...complete, phone: '  ' })).toBe('business');
  });

  it('moves on to location once business details are filled', () => {
    expect(firstIncompleteStep({ ...complete, city: null })).toBe('location');
  });

  it('lands on review when everything required is present (email is optional)', () => {
    expect(firstIncompleteStep(complete)).toBe('review');
  });

  it('requires exactly the fields the server requires', () => {
    const client = [...STEP_REQUIRED.business, ...STEP_REQUIRED.location].sort();
    expect(client).toEqual([...ONBOARDING_REQUIRED_FIELDS].sort());
  });
});
