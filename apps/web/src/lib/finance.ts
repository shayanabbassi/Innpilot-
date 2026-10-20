import type { JournalStatus } from '@innpilot/contracts';
import { Money } from '@innpilot/money';

export const STATUS_TONE: Record<JournalStatus, 'neutral' | 'success' | 'warning'> = {
  draft: 'warning',
  posted: 'success',
  reversed: 'neutral',
};

/** Display only. Amounts stay decimal strings everywhere else. */
export function formatAmount(amount: string, currency: string): string {
  return Money.of(amount || '0', currency).format('en-PK');
}

/** A blank or partly typed amount counts as zero; anything that is not a decimal also counts as zero. */
function parse(amount: string, currency: string): Money {
  return /^\d+(\.\d+)?$/.test(amount.trim()) ? Money.of(amount.trim(), currency) : Money.zero(currency);
}

export interface LineAmounts {
  debit: string;
  credit: string;
}

/** Live totals for the journal form. The server repeats this check when posting. */
export function journalTotals(lines: readonly LineAmounts[], currency: string) {
  const debit = Money.sum(
    lines.map((l) => parse(l.debit, currency)),
    currency,
  );
  const credit = Money.sum(
    lines.map((l) => parse(l.credit, currency)),
    currency,
  );
  return {
    debit: debit.toString(),
    credit: credit.toString(),
    difference: debit.subtract(credit).abs().toString(),
    balanced: debit.equals(credit) && debit.isPositive(),
  };
}

/** First and last day of the month containing `date` (YYYY-MM-DD). */
export function monthRange(date: string): { from: string; to: string } {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` };
}

/** A signed ledger balance (debit minus credit) shown as an amount with Dr or Cr. */
export function balanceSide(balance: string): { amount: string; side: 'dr' | 'cr' | null } {
  if (/^-?0+(\.0+)?$/.test(balance)) return { amount: '0', side: null };
  return balance.startsWith('-') ? { amount: balance.slice(1), side: 'cr' } : { amount: balance, side: 'dr' };
}
