import { describe, expect, it } from 'vitest';
import { createCashAccountRequest, transferRequest, updateCashAccountRequest } from './cash';

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';

describe('cash contracts', () => {
  it('refuses a transfer to the same account, zero amounts and sub-paisa amounts', () => {
    expect(
      transferRequest.safeParse({ fromCashAccountId: a, toCashAccountId: b, amount: '100.50' }).success,
    ).toBe(true);
    expect(transferRequest.safeParse({ fromCashAccountId: a, toCashAccountId: a, amount: '1' }).success).toBe(
      false,
    );
    expect(transferRequest.safeParse({ fromCashAccountId: a, toCashAccountId: b, amount: '0' }).success).toBe(
      false,
    );
    expect(
      transferRequest.safeParse({ fromCashAccountId: a, toCashAccountId: b, amount: '1.005' }).success,
    ).toBe(false);
  });

  it('needs a ledger account for "other" accounts and refuses card numbers in details', () => {
    expect(createCashAccountRequest.safeParse({ name: 'Petty cash', kind: 'cash' }).success).toBe(true);
    expect(createCashAccountRequest.safeParse({ name: 'Wallet', kind: 'other' }).success).toBe(false);
    expect(
      createCashAccountRequest.safeParse({ name: 'Card', kind: 'bank', details: '4111-1111-1111-1111' })
        .success,
    ).toBe(false);
  });

  it('refuses an empty change and changes to the kind or ledger account', () => {
    expect(updateCashAccountRequest.safeParse({}).success).toBe(false);
    expect(updateCashAccountRequest.safeParse({ kind: 'bank' }).success).toBe(false);
    expect(updateCashAccountRequest.safeParse({ active: false }).success).toBe(true);
  });
});
