import { describe, expect, it } from 'vitest';
import {
  createAccountRequest,
  defaultNormalBalance,
  journalDraftRequest,
  journalLineInput,
  periodMonth,
} from './finance';

const ID = '00000000-0000-4000-8000-000000000001';

describe('accounts', () => {
  it('requires the code to start with the digit of its class', () => {
    expect(
      createAccountRequest.safeParse({ code: '6150', name: 'Water', accountClass: 'expense' }).success,
    ).toBe(true);
    expect(
      createAccountRequest.safeParse({ code: '4150', name: 'Water', accountClass: 'expense' }).success,
    ).toBe(false);
    expect(createAccountRequest.safeParse({ code: '8000', name: 'X', accountClass: 'other' }).success).toBe(
      false,
    );
  });

  it('defaults the normal balance from the class', () => {
    expect(defaultNormalBalance('asset')).toBe('debit');
    expect(defaultNormalBalance('revenue')).toBe('credit');
    expect(defaultNormalBalance('expense')).toBe('debit');
  });
});

describe('journal lines', () => {
  it('takes an amount on exactly one side, in whole paisa', () => {
    expect(journalLineInput.safeParse({ accountId: ID, debit: '100.50' }).success).toBe(true);
    expect(journalLineInput.safeParse({ accountId: ID, debit: '100', credit: '100' }).success).toBe(false);
    expect(journalLineInput.safeParse({ accountId: ID }).success).toBe(false);
    expect(journalLineInput.safeParse({ accountId: ID, debit: '0.00', credit: '0' }).success).toBe(false);
    expect(journalLineInput.safeParse({ accountId: ID, debit: '1.005' }).success).toBe(false);
    expect(journalLineInput.safeParse({ accountId: ID, debit: '-5' }).success).toBe(false);
  });

  it('accepts an unbalanced draft (posting checks the balance) but not a single line', () => {
    const lines = [
      { accountId: ID, debit: '10' },
      { accountId: ID, credit: '9' },
    ];
    expect(journalDraftRequest.safeParse({ propertyId: ID, narration: 'Test', lines }).success).toBe(true);
    expect(
      journalDraftRequest.safeParse({ propertyId: ID, narration: 'Test', lines: lines.slice(0, 1) }).success,
    ).toBe(false);
  });
});

describe('periods', () => {
  it('accepts calendar months only', () => {
    expect(periodMonth.safeParse('2026-10').success).toBe(true);
    expect(periodMonth.safeParse('2026-13').success).toBe(false);
    expect(periodMonth.safeParse('2026-1').success).toBe(false);
  });
});
