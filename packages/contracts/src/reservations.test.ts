import { describe, expect, it } from 'vitest';
import {
  addDays,
  createReservationRequest,
  nightsBetween,
  reservationRoomInput,
  staysOverlap,
  stayNights,
} from './reservations';

const type = '11111111-1111-4111-8111-111111111111';

describe('business date helpers', () => {
  it('count nights across month and leap-year boundaries', () => {
    expect(nightsBetween('2026-10-19', '2026-10-22')).toBe(3);
    expect(nightsBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(stayNights('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01']);
  });

  it('treat same-day turnover as not overlapping', () => {
    const a = { arrival: '2026-10-19', departure: '2026-10-21' };
    expect(staysOverlap(a, { arrival: '2026-10-21', departure: '2026-10-23' })).toBe(false);
    expect(staysOverlap(a, { arrival: '2026-10-20', departure: '2026-10-23' })).toBe(true);
    expect(staysOverlap(a, { arrival: '2026-10-17', departure: '2026-10-19' })).toBe(false);
  });
});

describe('reservation room input', () => {
  const base = { roomTypeId: type, arrival: '2026-10-19', departure: '2026-10-20', adults: 2 };

  it('requires departure after arrival and caps stay length', () => {
    expect(reservationRoomInput.safeParse(base).success).toBe(true);
    expect(reservationRoomInput.safeParse({ ...base, departure: '2026-10-19' }).success).toBe(false);
    expect(reservationRoomInput.safeParse({ ...base, departure: '2026-12-31' }).success).toBe(false);
  });

  it('requires a reason when the rate is overridden', () => {
    expect(reservationRoomInput.safeParse({ ...base, nightlyRate: '5000' }).success).toBe(false);
    expect(
      reservationRoomInput.safeParse({ ...base, nightlyRate: '5000', rateOverrideReason: 'Corporate deal' })
        .success,
    ).toBe(true);
  });

  it('defaults new bookings to confirmed and refuses unknown fields', () => {
    const guestId = '22222222-2222-4222-8222-222222222222';
    expect(createReservationRequest.parse({ guestId, source: 'phone', rooms: [base] }).status).toBe(
      'confirmed',
    );
    expect(
      createReservationRequest.safeParse({ guestId, source: 'phone', rooms: [base], propertyId: type })
        .success,
    ).toBe(false);
  });
});
