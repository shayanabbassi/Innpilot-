import { describe, expect, it } from 'vitest';
import { Money, MoneyError } from './money';

const pkr = (a: string) => Money.of(a, 'PKR');

describe('Money construction', () => {
  it('accepts plain decimal strings', () => {
    expect(pkr('1250.50').toString()).toBe('1250.50');
    expect(pkr('-0.0001').toStorage()).toBe('-0.0001');
    expect(pkr(' 7 ').toString()).toBe('7.00');
  });

  it.each(['', '1e3', '1,000', 'abc', '1.', '.5', 'NaN', 'Infinity', '--1'])('rejects "%s"', (bad) => {
    expect(() => pkr(bad)).toThrow(MoneyError);
  });

  it('rejects JavaScript numbers even when the type system is bypassed', () => {
    expect(() => Money.of(0.1 as unknown as string, 'PKR')).toThrow(/never JavaScript numbers/);
  });

  it('rejects invalid currency codes', () => {
    expect(() => Money.of('1', 'pkr')).toThrow(MoneyError);
    expect(() => Money.of('1', 'RUPEE')).toThrow(MoneyError);
  });
});

describe('Money arithmetic', () => {
  it('does not suffer binary floating point error', () => {
    expect(pkr('0.1').add(pkr('0.2')).equals(pkr('0.3'))).toBe(true);
    expect(Money.sum([pkr('0.1'), pkr('0.1'), pkr('0.1')], 'PKR').toString()).toBe('0.30');
  });

  it('refuses to mix currencies', () => {
    expect(() => pkr('1').add(Money.of('1', 'USD'))).toThrow(/Currency mismatch/);
    expect(() => pkr('1').compare(Money.of('1', 'USD'))).toThrow(/Currency mismatch/);
  });

  it('multiplies by decimal factors at full precision', () => {
    // 16% of 4,999.99 = 799.9984 exactly; rounding only happens when asked.
    const tax = pkr('4999.99').multiply('0.16');
    expect(tax.toStorage()).toBe('799.9984');
    expect(tax.round().toString()).toBe('800.00');
  });

  it('supports the documented rounding modes', () => {
    expect(pkr('2.345').round('HALF_UP').toString()).toBe('2.35');
    expect(pkr('2.345').round('HALF_EVEN').toString()).toBe('2.34');
    expect(pkr('2.349').round('DOWN').toString()).toBe('2.34');
    expect(pkr('2.341').round('UP').toString()).toBe('2.35');
    expect(pkr('-2.345').round('HALF_UP').toString()).toBe('-2.35');
    expect(pkr('1249.50').round('HALF_UP', 0).toString()).toBe('1250.00');
  });

  it('reports sign and comparison', () => {
    expect(pkr('0').isZero()).toBe(true);
    expect(pkr('-0').isNegative()).toBe(false);
    expect(pkr('-1').isNegative()).toBe(true);
    expect(pkr('1').isPositive()).toBe(true);
    expect(pkr('2').compare(pkr('10'))).toBe(-1);
    expect(pkr('5').negate().abs().equals(pkr('5'))).toBe(true);
  });
});

describe('Money.allocate', () => {
  it('splits without losing or creating paisa', () => {
    const parts = pkr('100.00').allocate([1, 1, 1]);
    expect(parts.map(String)).toEqual(['33.34', '33.33', '33.33']);
    expect(Money.sum(parts, 'PKR').equals(pkr('100.00'))).toBe(true);
  });

  it('honours weights and negative totals', () => {
    expect(pkr('10.00').allocate([3, 1]).map(String)).toEqual(['7.50', '2.50']);
    const neg = pkr('-0.05').allocate([1, 1]);
    expect(neg.map(String)).toEqual(['-0.03', '-0.02']);
    expect(Money.sum(neg, 'PKR').equals(pkr('-0.05'))).toBe(true);
  });

  it('allows zero weights but not all zero', () => {
    expect(pkr('1.00').allocate([0, 1]).map(String)).toEqual(['0.00', '1.00']);
    expect(() => pkr('1').allocate([0, 0])).toThrow(MoneyError);
    expect(() => pkr('1').allocate([])).toThrow(MoneyError);
    expect(() => pkr('1').allocate([1.5])).toThrow(MoneyError);
  });

  it('requires the amount to be rounded to the allocation scale first', () => {
    expect(() => pkr('1.005').allocate([1, 1])).toThrow(/round first/);
  });
});

describe('Money storage boundary', () => {
  it('formats to NUMERIC(19,4)', () => {
    expect(pkr('12').toStorage()).toBe('12.0000');
    expect(Money.fromStorage('999999999999999.9999', 'PKR').toStorage()).toBe('999999999999999.9999');
  });

  it('refuses values that do not fit instead of rounding silently', () => {
    expect(() => pkr('0.00001').toStorage()).toThrow(/decimal places/);
    expect(() => Money.fromStorage('1000000000000000', 'PKR')).toThrow(/integer digits/);
  });

  it('serialises to JSON as strings', () => {
    expect(JSON.stringify({ total: pkr('1250.5') })).toBe('{"total":{"amount":"1250.50","currency":"PKR"}}');
  });
});

describe('Money.format', () => {
  it('formats PKR with grouping for display', () => {
    const text = pkr('1234567.5').format('en-PK');
    expect(text).toMatch(/12,34,567\.50|1,234,567\.50/);
    expect(text).toMatch(/Rs|PKR/);
  });
});
