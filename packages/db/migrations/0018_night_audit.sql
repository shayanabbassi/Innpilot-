-- Phase 4 slice 4.5: the night audit (P4-9, OPS-004), replacing the interim day close (D3).
-- The same business_date_closes row (unique per property and date) records each night audit, now with its summary.
-- D9: room revenue is accrued nightly, keyed by booked room and night (unique), net of tax:
--   Dr Unbilled guest revenue, Cr room revenue.
-- At check-out the room-night charge then clears the unbilled amount instead of crediting revenue a second time; tax is
-- charged on the guest's bill as before.

CREATE OR REPLACE FUNCTION seed_chart_of_accounts(p_tenant uuid) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  INSERT INTO accounts (tenant_id, code, name, account_class, normal_balance, system_role)
  SELECT p_tenant, t.code, t.name, t.cls, t.nb, t.role
  FROM (VALUES
    ('1000', 'Cash on hand',                       'asset',         'debit',  'cash_on_hand'),
    ('1100', 'Bank accounts',                      'asset',         'debit',  'bank'),
    ('1150', 'Card and payment clearing',          'asset',         'debit',  'payment_clearing'),
    ('1200', 'Guest receivables',                  'asset',         'debit',  'guest_receivable'),
    ('1210', 'Unbilled guest revenue',             'asset',         'debit',  'unbilled_revenue'),
    ('1250', 'Supplier advances',                  'asset',         'debit',  NULL),
    ('1300', 'Tax recoverable',                    'asset',         'debit',  'tax_recoverable'),
    ('1500', 'Furniture and equipment',            'asset',         'debit',  NULL),
    ('1590', 'Accumulated depreciation',           'asset',         'credit', NULL),
    ('2000', 'Accounts payable',                   'liability',     'credit', 'accounts_payable'),
    ('2100', 'Guest deposits',                     'liability',     'credit', 'guest_deposits'),
    ('2150', 'Unearned room revenue',              'liability',     'credit', NULL),
    ('2200', 'Taxes payable',                      'liability',     'credit', 'tax_payable'),
    ('2300', 'Payroll payable',                    'liability',     'credit', NULL),
    ('2400', 'Loans',                              'liability',     'credit', NULL),
    ('3000', 'Owner capital',                      'equity',        'credit', NULL),
    ('3100', 'Retained earnings',                  'equity',        'credit', 'retained_earnings'),
    ('3200', 'Current-year earnings',              'equity',        'credit', 'current_year_earnings'),
    ('3300', 'Drawings and distributions',         'equity',        'debit',  NULL),
    ('3900', 'Opening balance equity',             'equity',        'credit', 'opening_balance_equity'),
    ('4000', 'Room revenue',                       'revenue',       'credit', 'room_revenue'),
    ('4100', 'Food and beverage revenue',          'revenue',       'credit', NULL),
    ('4200', 'Laundry revenue',                    'revenue',       'credit', NULL),
    ('4300', 'Transport revenue',                  'revenue',       'credit', NULL),
    ('4400', 'Meeting room revenue',               'revenue',       'credit', NULL),
    ('4500', 'Cancellation and no-show fees',      'revenue',       'credit', 'cancellation_revenue'),
    ('4900', 'Other revenue',                      'revenue',       'credit', NULL),
    ('5000', 'Food and beverage cost',             'cost_of_sales', 'debit',  NULL),
    ('5100', 'Guest supplies',                     'cost_of_sales', 'debit',  NULL),
    ('5900', 'Other direct costs',                 'cost_of_sales', 'debit',  NULL),
    ('6000', 'Salaries and wages',                 'expense',       'debit',  NULL),
    ('6100', 'Utilities',                          'expense',       'debit',  NULL),
    ('6200', 'Housekeeping',                       'expense',       'debit',  NULL),
    ('6300', 'Repairs and maintenance',            'expense',       'debit',  NULL),
    ('6400', 'Laundry',                            'expense',       'debit',  NULL),
    ('6500', 'Commissions',                        'expense',       'debit',  NULL),
    ('6600', 'Marketing',                          'expense',       'debit',  NULL),
    ('6700', 'Rent',                               'expense',       'debit',  NULL),
    ('6800', 'Insurance',                          'expense',       'debit',  NULL),
    ('6900', 'Bank charges',                       'expense',       'debit',  'bank_charges'),
    ('6950', 'Depreciation',                       'expense',       'debit',  NULL),
    ('6960', 'Guest balances written off',         'expense',       'debit',  'write_off'),
    ('6970', 'Cash over and short',                'expense',       'debit',  'cash_over_short'),
    ('7000', 'Interest income',                    'other',         'credit', NULL),
    ('7100', 'Finance cost',                       'other',         'debit',  NULL),
    ('7200', 'Gain or loss on disposal',           'other',         'credit', NULL),
    ('7900', 'Rounding differences',               'other',         'debit',  'rounding')
  ) AS t (code, name, cls, nb, role)
  ON CONFLICT (tenant_id, code) DO NOTHING;
$$;

SELECT seed_chart_of_accounts(id) FROM tenants;

CREATE TABLE room_revenue_accruals (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  property_id          uuid NOT NULL,
  reservation_room_id  uuid NOT NULL,
  night                date NOT NULL,
  -- The night audit that accrued it.
  business_date        date NOT NULL,
  net_amount           numeric(19, 4) NOT NULL CHECK (net_amount > 0 AND net_amount = round(net_amount, 2)),
  revenue_account_id   uuid NOT NULL,
  journal_entry_id     uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- A night is accrued once, ever (OPS-004).
  UNIQUE (reservation_room_id, night),
  CHECK (night <= business_date),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (reservation_room_id) REFERENCES reservation_rooms (id),
  FOREIGN KEY (tenant_id, revenue_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE INDEX room_revenue_accruals_date_idx ON room_revenue_accruals (tenant_id, property_id, business_date);
CREATE TRIGGER room_revenue_accruals_append_only BEFORE UPDATE OR DELETE ON room_revenue_accruals
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- What the night audit found and did; empty for the interim closes made before this slice.
ALTER TABLE business_date_closes
  ADD COLUMN kind text NOT NULL DEFAULT 'day_close' CHECK (kind IN ('day_close', 'night_audit')),
  ADD COLUMN summary jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE business_date_closes ALTER COLUMN kind SET DEFAULT 'night_audit';

ALTER TABLE room_revenue_accruals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON room_revenue_accruals
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT ON room_revenue_accruals TO innpilot_app;
