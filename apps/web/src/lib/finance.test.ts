import { describe, expect, it } from 'vitest';
import { balanceSide, journalTotals, monthRange } from './finance';

describe('journal totals', () => {
  it('adds decimal strings exactly and reports the difference', () => {
    const t = journalTotals(
      [
        { debit: '0.10', credit: '' },
        { debit: '0.20', credit: '' },
        { debit: '', credit: '0.30' },
      ],
      'PKR',
    );
    expect(t).toMatchObject({ debit: '0.30', credit: '0.30', difference: '0.00', balanced: true });
  });

  it('is not balanced while empty, uneven or partly typed', () => {
    expect(journalTotals([], 'PKR').balanced).toBe(false);
    expect(
      journalTotals(
        [
          { debit: '100', credit: '' },
          { debit: '', credit: '99.5' },
        ],
        'PKR',
      ),
    ).toMatchObject({
      difference: '0.50',
      balanced: false,
    });
    expect(journalTotals([{ debit: '12.', credit: '' }], 'PKR').debit).toBe('0.00');
  });
});

describe('dates and balances', () => {
  it('gives the calendar month of a date', () => {
    expect(monthRange('2026-02-14')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthRange('2028-02-03')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-12-31')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('shows a signed balance as Dr or Cr', () => {
    expect(balanceSide('1500.00')).toEqual({ amount: '1500.00', side: 'dr' });
    expect(balanceSide('-20.50')).toEqual({ amount: '20.50', side: 'cr' });
    expect(balanceSide('0.00')).toEqual({ amount: '0', side: null });
  });
});
