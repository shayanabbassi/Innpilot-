import { Money } from '@innpilot/money';
import { describe, expect, it } from 'vitest';
import { calculateTax, type RateInEffect } from './tax-calc';

const PKR = (v: string) => Money.of(v, 'PKR');
const rate = (code: string, ratePercent: string, inclusive = false): RateInEffect => ({
  taxCodeId: code,
  code,
  name: code,
  ratePercent,
  inclusive,
});
const strings = (r: ReturnType<typeof calculateTax>) => ({
  net: r.net.toString(),
  taxes: r.lines.map((l) => l.amount.toString()),
  taxTotal: r.taxTotal.toString(),
  gross: r.gross.toString(),
});

describe('tax calculation', () => {
  it('charges nothing when no tax applies (a blank setup is valid)', () => {
    expect(strings(calculateTax(PKR('12500.50'), []))).toEqual({
      net: '12500.50',
      taxes: [],
      taxTotal: '0.00',
      gross: '12500.50',
    });
  });

  it('adds exclusive tax on top, rounded half-up to the paisa', () => {
    expect(strings(calculateTax(PKR('12500.50'), [rate('ST', '16')]))).toEqual({
      net: '12500.50',
      taxes: ['2000.08'],
      taxTotal: '2000.08',
      gross: '14500.58',
    });
    // 0.125 → 0.13 (half-up, not banker's rounding).
    expect(calculateTax(PKR('2.50'), [rate('X', '5')]).lines[0]!.amount.toString()).toBe('0.13');
  });

  it('rounds each exclusive tax on its own', () => {
    expect(strings(calculateTax(PKR('999.99'), [rate('A', '16'), rate('B', '5')]))).toEqual({
      net: '999.99',
      taxes: ['160.00', '50.00'],
      taxTotal: '210.00',
      gross: '1209.99',
    });
  });

  it('splits inclusive tax out of the amount so net plus tax is exactly the amount', () => {
    const r = calculateTax(PKR('11600'), [rate('ST', '16', true)]);
    expect(strings(r)).toEqual({
      net: '10000.00',
      taxes: ['1600.00'],
      taxTotal: '1600.00',
      gross: '11600.00',
    });

    const awkward = calculateTax(PKR('100'), [rate('A', '13', true), rate('B', '3.5', true)]);
    expect(awkward.net.add(awkward.taxTotal).toString()).toBe('100.00');
    expect(strings(awkward)).toEqual({
      net: '85.84',
      taxes: ['11.16', '3.00'],
      taxTotal: '14.16',
      gross: '100.00',
    });
  });

  it('applies exclusive taxes to the net left after inclusive ones, without tax on tax', () => {
    const r = calculateTax(PKR('1160'), [rate('IN', '16', true), rate('EX', '5')]);
    expect(strings(r)).toEqual({
      net: '1000.00',
      taxes: ['160.00', '50.00'],
      taxTotal: '210.00',
      gross: '1210.00',
    });
  });

  it('keeps zero-rated taxes as lines', () => {
    const r = calculateTax(PKR('500'), [rate('ZR', '0'), rate('ZI', '0', true)]);
    expect(strings(r)).toEqual({ net: '500.00', taxes: ['0.00', '0.00'], taxTotal: '0.00', gross: '500.00' });
  });

  it('never loses a paisa over many awkward amounts', () => {
    for (let paisa = 1; paisa <= 3000; paisa += 7) {
      const amount = Money.of((paisa / 100).toFixed(2), 'PKR');
      const r = calculateTax(amount, [rate('A', '16', true), rate('B', '0.25', true), rate('C', '5')]);
      expect(r.net.add(r.lines[0]!.amount).add(r.lines[1]!.amount).equals(amount)).toBe(true);
      expect(r.gross.equals(r.net.add(r.taxTotal))).toBe(true);
    }
  });
});
