import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, previousYear } from './report-scope';
import { comparisonRange } from './statements.service';

describe('report dates', () => {
  it('adds days and counts them across month and year ends', () => {
    expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
  });

  it('takes the same date a year earlier, 29 February becoming 28 February', () => {
    expect(previousYear('2026-10-21')).toBe('2025-10-21');
    expect(previousYear('2028-02-29')).toBe('2027-02-28');
  });
});

describe('comparison range', () => {
  it('uses the same number of days just before the range', () => {
    expect(comparisonRange({ from: '2026-10-01', to: '2026-10-31', compare: 'previous_period' })).toEqual({
      from: '2026-08-31',
      to: '2026-09-30',
    });
    expect(comparisonRange({ from: '2026-10-21', to: '2026-10-21', compare: 'previous_period' })).toEqual({
      from: '2026-10-20',
      to: '2026-10-20',
    });
  });

  it('uses the same dates a year earlier, or nothing', () => {
    expect(comparisonRange({ from: '2028-02-01', to: '2028-02-29', compare: 'previous_year' })).toEqual({
      from: '2027-02-01',
      to: '2027-02-28',
    });
    expect(comparisonRange({ from: '2026-10-01', to: '2026-10-31', compare: 'none' })).toBeNull();
  });
});
