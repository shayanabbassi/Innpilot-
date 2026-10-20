import { describe, expect, it } from 'vitest';
import { expenseDraftRequest, payExpenseRequest, updateSupplierRequest } from './expenses';

const id = '00000000-0000-4000-8000-000000000001';
const line = { accountId: id, amount: '100' };

describe('expense contracts', () => {
  it('needs a supplier on a bill and no due date on a cash expense', () => {
    const base = { expenseDate: '2026-10-19', description: 'Vegetables', lines: [line] };
    expect(expenseDraftRequest.safeParse({ ...base, kind: 'bill' }).success).toBe(false);
    expect(expenseDraftRequest.safeParse({ ...base, kind: 'bill', supplierId: id }).success).toBe(true);
    expect(expenseDraftRequest.safeParse({ ...base, kind: 'cash', dueDate: '2026-10-30' }).success).toBe(
      false,
    );
    expect(
      expenseDraftRequest.safeParse({ ...base, kind: 'bill', supplierId: id, dueDate: '2026-10-01' }).success,
    ).toBe(false);
  });

  it('takes positive whole-paisa amounts, tax defaulting to zero and not recoverable', () => {
    const parsed = expenseDraftRequest.parse({
      kind: 'cash',
      expenseDate: '2026-10-19',
      description: 'Mop',
      lines: [line],
    });
    expect(parsed.lines[0]).toMatchObject({ taxAmount: '0', taxRecoverable: false });
    expect(payExpenseRequest.safeParse({ amount: '0', cashAccountId: id }).success).toBe(false);
    expect(payExpenseRequest.safeParse({ amount: '10.001', cashAccountId: id }).success).toBe(false);
  });

  it('refuses an empty supplier change', () => {
    expect(updateSupplierRequest.safeParse({}).success).toBe(false);
  });
});
