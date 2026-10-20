import { Decimal, Money } from '@innpilot/money';

export interface RateInEffect {
  taxCodeId: string;
  code: string;
  name: string;
  /** Decimal string, e.g. "16" or "13.5". */
  ratePercent: string;
  inclusive: boolean;
}

export interface TaxLine extends RateInEffect {
  base: Money;
  amount: Money;
}

export interface TaxResult {
  /** The amount as entered: gross if any tax is inclusive, otherwise net. */
  amount: Money;
  net: Money;
  lines: TaxLine[];
  taxTotal: Money;
  gross: Money;
}

const HUNDRED = new Decimal(100);
/** Rates have at most 4 decimal places, so ×10 000 gives exact integer weights for splitting. */
const WEIGHT_SCALE = new Decimal(10_000);

/**
 * The tax rules (P3-8, D5, D6). Every amount is rounded half-up to the currency's minor unit, and the parts
 * always add up exactly:
 *   - inclusive taxes: net = amount ÷ (1 + Σ inclusive rates); the difference is split across those taxes in
 *     proportion to their rates, so net + inclusive taxes = amount to the paisa;
 *   - exclusive taxes: each is net × rate, rounded on its own, and added on top.
 * Taxes are never charged on other taxes (no compounding). Rates of 0% are kept as lines so the document shows
 * the tax was considered.
 */
export function calculateTax(amount: Money, rates: readonly RateInEffect[]): TaxResult {
  const currency = amount.currency;
  const zero = Money.zero(currency);
  const inclusive = rates.filter((r) => r.inclusive);
  const exclusive = rates.filter((r) => !r.inclusive);

  const inclusiveRate = inclusive.reduce((s, r) => s.plus(r.ratePercent), new Decimal(0));
  const net = inclusiveRate.isZero()
    ? amount
    : amount.multiply(HUNDRED.dividedBy(HUNDRED.plus(inclusiveRate))).round();

  const inclusiveTotal = amount.subtract(net);
  const weights = inclusive.map((r) => new Decimal(r.ratePercent).times(WEIGHT_SCALE).toNumber());
  const inclusiveParts = inclusiveRate.isZero()
    ? inclusive.map(() => zero)
    : inclusiveTotal.allocate(weights);

  const lines: TaxLine[] = [
    ...inclusive.map((r, i) => ({ ...r, base: net, amount: inclusiveParts[i]! })),
    ...exclusive.map((r) => ({
      ...r,
      base: net,
      amount: net.multiply(new Decimal(r.ratePercent).dividedBy(HUNDRED)).round(),
    })),
  ];
  const taxTotal = Money.sum(
    lines.map((l) => l.amount),
    currency,
  );
  return { amount, net, lines, taxTotal, gross: net.add(taxTotal) };
}
