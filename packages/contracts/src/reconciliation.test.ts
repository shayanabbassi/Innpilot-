import { describe, expect, it } from 'vitest';
import {
  cardSettlementRequest,
  startReconciliationRequest,
  updateReconciliationRequest,
} from './reconciliation';

const a = '00000000-0000-4000-8000-000000000001';
const b = '00000000-0000-4000-8000-000000000002';

describe('reconciliation contracts', () => {
  it('takes a statement balance that may be negative, in whole paisa', () => {
    const base = { cashAccountId: a, statementDate: '2026-10-19' };
    expect(startReconciliationRequest.safeParse({ ...base, statementBalance: '-350.50' }).success).toBe(true);
    expect(startReconciliationRequest.safeParse({ ...base, statementBalance: '1.005' }).success).toBe(false);
    expect(updateReconciliationRequest.safeParse({}).success).toBe(false);
  });

  it('needs two different accounts and a positive amount for a card settlement', () => {
    expect(
      cardSettlementRequest.safeParse({ clearingAccountId: a, bankAccountId: b, grossAmount: '100' }).success,
    ).toBe(true);
    expect(
      cardSettlementRequest.safeParse({ clearingAccountId: a, bankAccountId: a, grossAmount: '100' }).success,
    ).toBe(false);
    expect(
      cardSettlementRequest.safeParse({ clearingAccountId: a, bankAccountId: b, grossAmount: '0' }).success,
    ).toBe(false);
  });
});
