import { describe, expect, it } from 'vitest';
import { agingBucket, agingQuery } from './reports';
import { businessDate } from './reservations';

describe('aging buckets (D14)', () => {
  it('puts zero or fewer days in current and the rest in 30-day bands', () => {
    expect([-5, 0, 1, 30, 31, 60, 61, 90, 91, 400].map(agingBucket)).toEqual([
      'current',
      'current',
      'd1_30',
      'd1_30',
      'd31_60',
      'd31_60',
      'd61_90',
      'd61_90',
      'over_90',
      'over_90',
    ]);
  });
});

describe('hotel dates', () => {
  it('refuses impossible dates as a validation error instead of throwing', () => {
    expect(businessDate.safeParse('2026-13-01').success).toBe(false);
    expect(businessDate.safeParse('2026-02-30').success).toBe(false);
    expect(businessDate.safeParse('2028-02-29').success).toBe(true);
    expect(agingQuery.safeParse({ asOf: '2026-00-10' }).success).toBe(false);
  });
});
