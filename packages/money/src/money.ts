import DecimalBase from 'decimal.js';

/**
 * Decimal arithmetic configured for money. 40 significant digits is far beyond NUMERIC(19,4),
 * so intermediate results (e.g. tax-rate multiplication) never lose precision before explicit rounding.
 */
export const Decimal = DecimalBase.clone({ precision: 40, rounding: DecimalBase.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;

/** Matches the database column type NUMERIC(19,4): up to 15 integer digits and 4 fraction digits. */
export const STORAGE_SCALE = 4;
const MAX_INTEGER_DIGITS = 15;
const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

export type RoundingMode = 'HALF_UP' | 'HALF_EVEN' | 'DOWN' | 'UP';

const ROUNDING: Record<RoundingMode, DecimalBase.Rounding> = {
  HALF_UP: Decimal.ROUND_HALF_UP,
  HALF_EVEN: Decimal.ROUND_HALF_EVEN,
  DOWN: Decimal.ROUND_DOWN,
  UP: Decimal.ROUND_UP,
};

/** ISO 4217 minor units for currencies we expect to meet; anything else defaults to 2. */
const MINOR_UNITS: Record<string, number> = {
  PKR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SAR: 2,
  JPY: 0,
  KWD: 3,
};

export function minorUnits(currency: string): number {
  return MINOR_UNITS[currency] ?? 2;
}

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

function parseAmount(input: string | Decimal): Decimal {
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!DECIMAL_STRING.test(trimmed)) {
      throw new MoneyError(
        `Invalid monetary amount "${input}". Use a plain decimal string such as "1250.50".`,
      );
    }
    return new Decimal(trimmed);
  }
  if (input instanceof Decimal) return input;
  // Guards against callers bypassing the type system with a JS number.
  throw new MoneyError('Monetary amounts must be decimal strings, never JavaScript numbers.');
}

/**
 * An immutable amount of a single currency. Values are kept at full precision internally and
 * only rounded where a caller explicitly asks (storage, document totals, display).
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    readonly currency: string,
  ) {}

  static of(amount: string | Decimal, currency: string): Money {
    if (!CURRENCY_CODE.test(currency)) {
      throw new MoneyError(`Invalid ISO 4217 currency code "${currency}".`);
    }
    const value = parseAmount(amount);
    if (!value.isFinite()) throw new MoneyError('Monetary amount must be finite.');
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return Money.of('0', currency);
  }

  /** Sums a list of amounts that must all share `currency`. An empty list sums to zero. */
  static sum(items: readonly Money[], currency: string): Money {
    return items.reduce((acc, m) => acc.add(m), Money.zero(currency));
  }

  /**
   * Parses a value read from the database or API and checks it fits NUMERIC(19,4).
   * Use this at every system boundary instead of `of`.
   */
  static fromStorage(amount: string, currency: string): Money {
    const money = Money.of(amount, currency);
    money.assertStorable();
    return money;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new MoneyError(`Currency mismatch: ${this.currency} vs ${other.currency}.`);
    }
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  /** Multiplies by a decimal factor such as a tax rate ("0.16") or a quantity ("3"). */
  multiply(factor: string | Decimal): Money {
    return new Money(this.value.times(parseAmount(factor)), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  abs(): Money {
    return new Money(this.value.abs(), this.currency);
  }

  /** Rounds to `scale` fraction digits; defaults to the currency's minor units. */
  round(mode: RoundingMode = 'HALF_UP', scale: number = minorUnits(this.currency)): Money {
    return new Money(this.value.toDecimalPlaces(scale, ROUNDING[mode]), this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.assertSameCurrency(other);
    return this.value.comparedTo(other.value) as -1 | 0 | 1;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  /**
   * Splits this amount by integer weights so the parts always sum exactly to the original,
   * at the given scale (default: currency minor units). Remainder units go to the largest
   * fractional remainders first, ties to the earliest weight.
   */
  allocate(weights: readonly number[], scale: number = minorUnits(this.currency)): Money[] {
    if (weights.length === 0) throw new MoneyError('Allocation needs at least one weight.');
    if (weights.some((w) => !Number.isInteger(w) || w < 0)) {
      throw new MoneyError('Allocation weights must be non-negative integers.');
    }
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    if (totalWeight === 0) throw new MoneyError('Allocation weights must not all be zero.');

    const unit = new Decimal(10).pow(-scale);
    const total = this.value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
    if (!total.equals(this.value)) {
      throw new MoneyError(
        `Amount ${this.value.toString()} has more than ${scale} decimal places; round first.`,
      );
    }
    const sign = total.isNegative() ? -1 : 1;
    const magnitude = total.abs();

    const exact = weights.map((w) => magnitude.times(w).dividedBy(totalWeight));
    const floors = exact.map((e) => e.toDecimalPlaces(scale, Decimal.ROUND_DOWN));
    let remainderUnits = magnitude
      .minus(floors.reduce((a, b) => a.plus(b), new Decimal(0)))
      .dividedBy(unit)
      .toNumber();

    const order = exact
      .map((e, i) => ({ i, frac: e.minus(floors[i]!) }))
      .sort((a, b) => b.frac.comparedTo(a.frac) || a.i - b.i);
    for (const { i } of order) {
      if (remainderUnits <= 0) break;
      floors[i] = floors[i]!.plus(unit);
      remainderUnits -= 1;
    }
    return floors.map((f) => new Money(sign < 0 ? f.negated() : f, this.currency));
  }

  /** Throws unless the value fits NUMERIC(19,4). */
  assertStorable(): void {
    if (this.value.decimalPlaces() > STORAGE_SCALE) {
      throw new MoneyError(`Amount ${this.value.toString()} exceeds ${STORAGE_SCALE} decimal places.`);
    }
    if (this.value.abs().truncated().toFixed(0).length > MAX_INTEGER_DIGITS) {
      throw new MoneyError(`Amount ${this.value.toString()} exceeds ${MAX_INTEGER_DIGITS} integer digits.`);
    }
  }

  /** Fixed-scale string for the database (NUMERIC(19,4)). Throws rather than silently rounding. */
  toStorage(): string {
    this.assertStorable();
    return this.value.toFixed(STORAGE_SCALE);
  }

  /** Canonical API representation: a decimal string at currency minor units if exact, otherwise full precision. */
  toString(): string {
    const scale = Math.max(minorUnits(this.currency), this.value.decimalPlaces());
    return this.value.toFixed(scale);
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency };
  }

  /** The underlying decimal, for callers that need ratio maths (e.g. occupancy-weighted splits). */
  toDecimal(): Decimal {
    return this.value;
  }

  /**
   * Locale-aware display string, e.g. "Rs 1,250.50". Display only — never parse this back.
   * Intl formats the decimal string directly, so no float conversion happens.
   */
  format(locale = 'en-PK'): string {
    const digits = minorUnits(this.currency);
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: this.currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: Math.max(digits, this.value.decimalPlaces()),
    }).format(this.value.toFixed() as unknown as number);
  }
}
