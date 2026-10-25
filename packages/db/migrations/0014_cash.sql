-- 0014_cash: cash and bank accounts read from the ledger, transfers, opening balances (Phase 4 slice 4.1).
-- The cashbook is not a second copy of the money (P4-1): journal lines gain a cash-account dimension, and every
-- posted line on a ledger account used by a cash account must say which drawer or bank it is. Transfers are one
-- journal between two cash accounts, so they never touch revenue or expense (P4-2). Opening balances are one journal
-- per property, balanced through an opening-balance equity account (P4-3).

INSERT INTO permissions (code, description)
  VALUES ('cash.transfer', 'Move money between cash drawers and bank accounts');
INSERT INTO role_permissions (role_code, permission_code)
  VALUES ('tenant_owner', 'cash.transfer'), ('hotel_manager', 'cash.transfer'),
         ('accountant', 'cash.transfer'), ('cashier', 'cash.transfer');

-- ---------------------------------------------------------------------------------------------------------------
-- Cash accounts: details, own ledger sub-accounts, the cash dimension on journal lines
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE cash_accounts
  ADD COLUMN details text CHECK (length(details) <= 120),
  ADD CONSTRAINT cash_accounts_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE journal_lines ADD COLUMN cash_account_id uuid;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_cash_account_fk
  FOREIGN KEY (tenant_id, cash_account_id) REFERENCES cash_accounts (tenant_id, id);
CREATE INDEX journal_lines_cash_idx ON journal_lines (tenant_id, cash_account_id) WHERE cash_account_id IS NOT NULL;

-- Tag the cash lines already posted by payments and refunds (Phase 3). Only the new dimension is set; no amount,
-- account or date changes, so the immutability trigger is paused for this statement alone.
ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_guard;
UPDATE journal_lines l SET cash_account_id = p.cash_account_id
  FROM payments p JOIN cash_accounts c ON c.id = p.cash_account_id
  WHERE l.journal_entry_id = p.journal_entry_id AND l.account_id = c.ledger_account_id;
UPDATE journal_lines l SET cash_account_id = r.cash_account_id
  FROM refunds r JOIN cash_accounts c ON c.id = r.cash_account_id
  WHERE l.journal_entry_id = r.journal_entry_id AND l.account_id = c.ledger_account_id;
-- Manual journals on a cash ledger account: the property's only cash account on that ledger account, if unique.
UPDATE journal_lines l SET cash_account_id = c.id
  FROM journal_entries e, cash_accounts c
  WHERE l.journal_entry_id = e.id AND l.cash_account_id IS NULL AND e.status <> 'draft'
    AND c.property_id = e.property_id AND c.ledger_account_id = l.account_id
    AND (SELECT count(*) FROM cash_accounts c2
         WHERE c2.property_id = e.property_id AND c2.ledger_account_id = l.account_id) = 1;
ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_guard;

-- Posted entries balance, and every line on a cash ledger account names its cash account (checked at commit).
CREATE OR REPLACE FUNCTION journal_entries_balanced() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  e record;
  s record;
BEGIN
  SELECT * INTO e FROM journal_entries WHERE id = NEW.id;
  IF NOT FOUND OR e.status = 'draft' THEN
    RETURN NULL;
  END IF;
  SELECT count(*) AS n, coalesce(sum(debit), 0) AS dr, coalesce(sum(credit), 0) AS cr
    INTO s FROM journal_lines WHERE journal_entry_id = e.id;
  IF s.n < 2 OR s.dr <> s.cr OR s.dr <> e.total_debit OR s.cr <> e.total_credit THEN
    RAISE EXCEPTION 'Journal entry % does not balance (lines %, debit %, credit %)', e.id, s.n, s.dr, s.cr
      USING ERRCODE = 'check_violation', HINT = 'JOURNAL_UNBALANCED';
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines l
    WHERE l.journal_entry_id = e.id
      AND (
        (l.cash_account_id IS NULL AND l.account_id IN (
           SELECT ledger_account_id FROM cash_accounts WHERE property_id = e.property_id))
        OR (l.cash_account_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM cash_accounts c WHERE c.id = l.cash_account_id
             AND c.property_id = e.property_id AND c.ledger_account_id = l.account_id))
      )
  ) THEN
    RAISE EXCEPTION 'Journal entry % has a cash ledger line without its cash account', e.id
      USING ERRCODE = 'check_violation', HINT = 'CASH_ACCOUNT_REQUIRED';
  END IF;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Opening balance equity
-- ---------------------------------------------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------------------------------------------
-- Transfers and opening balances
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE cash_transfers (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  property_id            uuid NOT NULL,
  from_cash_account_id   uuid NOT NULL,
  to_cash_account_id     uuid NOT NULL,
  amount                 numeric(19, 4) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  business_date          date NOT NULL,
  reference              text CHECK (length(reference) <= 80),
  notes                  text CHECK (length(notes) <= 300),
  journal_entry_id       uuid NOT NULL,
  created_by             uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, property_id, from_cash_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, to_cash_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CHECK (from_cash_account_id <> to_cash_account_id)
);
CREATE INDEX cash_transfers_date_idx ON cash_transfers (tenant_id, property_id, business_date DESC);
CREATE TRIGGER cash_transfers_append_only BEFORE UPDATE OR DELETE ON cash_transfers
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TABLE opening_balances (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  property_id       uuid NOT NULL,
  as_of             date NOT NULL,
  journal_entry_id  uuid NOT NULL,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- Once per property: corrections afterwards are ordinary journals or a reversal of this one.
  UNIQUE (property_id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE TRIGGER opening_balances_append_only BEFORE UPDATE OR DELETE ON opening_balances
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

ALTER TABLE cash_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE opening_balances ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_transfers
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON opening_balances
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT ON cash_transfers, opening_balances TO innpilot_app;
