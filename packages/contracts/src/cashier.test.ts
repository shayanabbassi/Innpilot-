import { describe, expect, it } from 'vitest';
import { openShiftRequest, reopenClosingRequest, shiftListQuery, submitClosingRequest } from './cashier';

describe('cashier contracts', () => {
  it('takes counts in whole paisa, zero allowed, never negative', () => {
    const drawer = '00000000-0000-4000-8000-000000000001';
    expect(openShiftRequest.safeParse({ cashAccountId: drawer, openingCount: '0' }).success).toBe(true);
    expect(openShiftRequest.safeParse({ cashAccountId: drawer, openingCount: '-5' }).success).toBe(false);
    expect(submitClosingRequest.safeParse({ countedAmount: '12100.505' }).success).toBe(false);
    expect(submitClosingRequest.safeParse({ countedAmount: '12100.50', explanation: 'Short' }).success).toBe(
      true,
    );
  });

  it('needs a reason to reopen and a valid filter', () => {
    expect(reopenClosingRequest.safeParse({ reason: 'x' }).success).toBe(false);
    expect(reopenClosingRequest.safeParse({ reason: 'Recount' }).success).toBe(true);
    expect(shiftListQuery.parse({}).status).toBe('all');
    expect(shiftListQuery.safeParse({ status: 'pending' }).success).toBe(false);
  });
});
