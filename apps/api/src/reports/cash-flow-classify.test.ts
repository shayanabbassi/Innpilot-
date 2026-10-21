import { describe, expect, it } from 'vitest';
import { classify } from './cash-reports.service';

const acc = (
  account_class: string,
  report_group: string,
  system_role: string | null = null,
  is_tax = false,
) => ({
  account_class,
  report_group,
  system_role,
  is_tax,
});

describe('cash flow classification (D13)', () => {
  it('reads the other side of a cash movement', () => {
    expect(classify(acc('asset', 'current_asset', 'guest_receivable'))).toBe('receipts_from_guests');
    expect(classify(acc('revenue', 'revenue'))).toBe('receipts_from_guests');
    expect(classify(acc('liability', 'current_liability', 'guest_deposits'))).toBe('guest_deposits');
    expect(classify(acc('liability', 'current_liability', 'accounts_payable'))).toBe('payments_to_suppliers');
    expect(classify(acc('expense', 'operating_expense'))).toBe('operating_expenses');
    expect(classify(acc('cost_of_sales', 'cost_of_sales'))).toBe('operating_expenses');
    expect(classify(acc('other', 'other'))).toBe('other_operating');
  });

  it('puts tax accounts, including ones chosen for a tax code, under taxes', () => {
    expect(classify(acc('liability', 'current_liability', 'tax_payable'))).toBe('taxes');
    expect(classify(acc('asset', 'current_asset', 'tax_recoverable'))).toBe('taxes');
    expect(classify(acc('liability', 'current_liability', null, true))).toBe('taxes');
  });

  it('uses the report group for investing and financing', () => {
    expect(classify(acc('asset', 'non_current_asset'))).toBe('fixed_assets');
    expect(classify(acc('liability', 'non_current_liability'))).toBe('loans');
    expect(classify(acc('equity', 'equity'))).toBe('owner_equity');
    expect(classify(acc('equity', 'equity', 'opening_balance_equity'))).toBe('opening_balances');
    expect(classify(acc('liability', 'current_liability'))).toBe('other_operating');
  });
});
