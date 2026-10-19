import { ONBOARDING_REQUIRED_FIELDS, type PropertyDto } from '@innpilot/contracts';
import { describe, expect, it } from 'vitest';
import { firstIncompleteStep, roomsReady, STEP_REQUIRED } from './onboarding';

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
    expect(firstIncompleteStep({ ...complete, legalName: null }, true)).toBe('business');
    expect(firstIncompleteStep({ ...complete, phone: '  ' }, true)).toBe('business');
  });

  it('moves on to location once business details are filled', () => {
    expect(firstIncompleteStep({ ...complete, city: null }, true)).toBe('location');
  });

  it('asks for rooms before review, then lands on review (email is optional)', () => {
    expect(firstIncompleteStep(complete, false)).toBe('rooms');
    expect(firstIncompleteStep(complete, true)).toBe('review');
  });

  it('requires exactly the fields the server requires', () => {
    const client = [...STEP_REQUIRED.business, ...STEP_REQUIRED.location].sort();
    expect(client).toEqual([...ONBOARDING_REQUIRED_FIELDS].sort());
  });
});

describe('roomsReady', () => {
  const type = (id: string, rated: boolean) => ({
    id,
    code: id.toUpperCase(),
    name: id,
    description: null,
    capacityAdults: 2,
    capacityChildren: 0,
    active: true,
    sortOrder: 0,
    roomCount: 1,
    currentRate: rated
      ? {
          id: 'r',
          effectiveFrom: '2026-10-19',
          nightlyRate: '5000.00',
          currencyCode: 'PKR',
          createdAt: '2026-10-19T00:00:00.000Z',
        }
      : null,
  });
  const room = (roomTypeId: string, active = true) => ({
    id: roomTypeId + '-room',
    roomNumber: '101',
    floor: null,
    roomTypeId,
    roomTypeCode: 'X',
    housekeepingState: 'clean' as const,
    serviceState: 'in_service' as const,
    active,
  });

  it('needs at least one active room', () => {
    expect(roomsReady([type('std', true)], [])).toBe(false);
    expect(roomsReady([type('std', true)], [room('std', false)])).toBe(false);
    expect(roomsReady([type('std', true)], [room('std')])).toBe(true);
  });

  it('needs a rate only for types that have active rooms', () => {
    expect(roomsReady([type('std', true), type('dlx', false)], [room('std')])).toBe(true);
    expect(roomsReady([type('std', true), type('dlx', false)], [room('std'), room('dlx')])).toBe(false);
  });
});
