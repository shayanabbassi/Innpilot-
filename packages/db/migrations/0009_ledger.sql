-- 0009_ledger: double-entry ledger core (Phase 3 slice 3.1).
-- Chart of accounts, monthly fiscal periods, journal entries and lines, document number counters.
-- The ledger rules hold in the database itself, not only in the API:
--   * a posted entry has at least two lines, debits equal credits, and both equal the header totals (checked at commit);
--   * posted entries and their lines can never be edited or deleted; the only change allowed is marking an entry reversed;
--   * nothing posts into a closed period;
--   * every amount is non-negative, on one side only, and in whole paisa (decision D5).

INSERT INTO permissions (code, description)
  VALUES ('account.manage', 'Create and change accounts in the chart of accounts');
INSERT INTO role_permissions (role_code, permission_code)
  VALUES ('tenant_owner', 'account.manage'), ('accountant', 'account.manage');

-- ---------------------------------------------------------------------------------------------------------------
-- Chart of accounts
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  code            text NOT NULL CHECK (code ~ '^[1-7][0-9]{3,5}$'),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  account_class   text NOT NULL CHECK (account_class IN
                    ('asset', 'liability', 'equity', 'revenue', 'cost_of_sales', 'expense', 'other')),
  normal_balance  text NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  parent_id       uuid,
  -- Accounts the posting rules rely on (guest receivable, room revenue…). They can be renamed, never removed.
  system_role     text,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES accounts (tenant_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (system_role IS NULL OR active),
  -- The first digit of the code follows the class ranges of the accounting spec (1 assets … 7 other).
  CHECK (substr(code, 1, 1) = CASE account_class
           WHEN 'asset' THEN '1' WHEN 'liability' THEN '2' WHEN 'equity' THEN '3' WHEN 'revenue' THEN '4'
           WHEN 'cost_of_sales' THEN '5' WHEN 'expense' THEN '6' ELSE '7' END)
);
CREATE UNIQUE INDEX accounts_system_role_key ON accounts (tenant_id, system_role) WHERE system_role IS NOT NULL;
CREATE TRIGGER accounts_updated_at BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Code, class, normal balance and system role are fixed once an account exists: changing them would silently
-- re-classify every amount already posted to it.
CREATE FUNCTION accounts_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Accounts cannot be deleted; deactivate them instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.code <> OLD.code OR NEW.account_class <> OLD.account_class OR NEW.normal_balance <> OLD.normal_balance
     OR NEW.system_role IS DISTINCT FROM OLD.system_role OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'Account code, class, normal balance and system role cannot be changed'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER accounts_guard BEFORE UPDATE OR DELETE ON accounts FOR EACH ROW EXECUTE FUNCTION accounts_guard();

-- Starter template from the accounting specification §2. Codes and names are a starting point for the hotel's
-- accountant to review; hotels add their own accounts.
CREATE FUNCTION seed_chart_of_accounts(p_tenant uuid) RETURNS void
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

CREATE FUNCTION tenants_seed_chart() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM seed_chart_of_accounts(NEW.id);
  RETURN NULL;
END
$$;
CREATE TRIGGER tenants_seed_chart AFTER INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION tenants_seed_chart();

-- Existing tenants get the same template.
SELECT seed_chart_of_accounts(id) FROM tenants;

-- ---------------------------------------------------------------------------------------------------------------
-- Fiscal periods (calendar months, tenant-wide)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE fiscal_periods (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_by      uuid,
  closed_at      timestamptz,
  reopened_by    uuid,
  reopened_at    timestamptz,
  reopen_reason  text CHECK (length(reopen_reason) <= 500),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, start_date),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, reopened_by) REFERENCES users (tenant_id, id),
  CHECK (start_date = date_trunc('month', start_date)::date),
  CHECK (end_date = (start_date + interval '1 month' - interval '1 day')::date),
  CHECK (status = 'open' OR (closed_by IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (reopened_at IS NULL OR reopen_reason IS NOT NULL)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Document number counters (journal numbers now; invoices and receipts later)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE document_sequences (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  property_id  uuid,
  series       text NOT NULL CHECK (series ~ '^[a-z_]{2,40}$'),
  next_number  bigint NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  -- One counter per scope; a NULL property means tenant-wide. Row-locked when a number is taken, so numbers are
  -- gapless and unique under concurrency (a rolled-back transaction also rolls back its number).
  UNIQUE NULLS NOT DISTINCT (tenant_id, property_id, series),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Journals
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE journal_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  property_id        uuid NOT NULL,
  journal_number     bigint,
  status             text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
  accounting_date    date NOT NULL,
  period_id          uuid,
  currency_code      char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  -- What the entry records. Manual journals and reversals have no source record; later slices add folio charges,
  -- payments and refunds. One posted entry per source and purpose.
  source_type        text NOT NULL CHECK (source_type ~ '^[a-z_]{2,40}$'),
  source_id          uuid,
  purpose            text NOT NULL DEFAULT 'main' CHECK (purpose ~ '^[a-z_]{2,40}$'),
  reference          text CHECK (length(reference) <= 80),
  narration          text NOT NULL CHECK (length(btrim(narration)) BETWEEN 1 AND 500),
  total_debit        numeric(19, 4) NOT NULL DEFAULT 0,
  total_credit       numeric(19, 4) NOT NULL DEFAULT 0,
  reverses_entry_id  uuid,
  reversed_by_id     uuid,
  idempotency_key    text,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  posted_by          uuid,
  posted_at          timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, journal_number),
  UNIQUE (reverses_entry_id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, period_id) REFERENCES fiscal_periods (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, reversed_by_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, posted_by) REFERENCES users (tenant_id, id),
  CHECK (status = 'draft' OR (journal_number IS NOT NULL AND posted_by IS NOT NULL AND posted_at IS NOT NULL
                               AND period_id IS NOT NULL)),
  CHECK (status = 'draft' OR (total_debit = total_credit AND total_debit > 0)),
  CHECK ((status = 'reversed') = (reversed_by_id IS NOT NULL)),
  CHECK (reverses_entry_id IS NULL OR source_type = 'reversal')
);
CREATE UNIQUE INDEX journal_entries_source_key ON journal_entries (tenant_id, source_type, source_id, purpose)
  WHERE source_id IS NOT NULL AND status <> 'draft';
CREATE INDEX journal_entries_date_idx ON journal_entries (tenant_id, accounting_date, journal_number);
CREATE INDEX journal_entries_status_idx ON journal_entries (tenant_id, status, created_at DESC);

CREATE TABLE journal_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  journal_entry_id  uuid NOT NULL,
  line_no           smallint NOT NULL CHECK (line_no BETWEEN 1 AND 500),
  account_id        uuid NOT NULL,
  debit             numeric(19, 4) NOT NULL DEFAULT 0,
  credit            numeric(19, 4) NOT NULL DEFAULT 0,
  description       text CHECK (length(description) <= 300),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  UNIQUE (journal_entry_id, line_no),
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit > 0) <> (credit > 0)),
  -- Whole paisa only (D5): the posting rules round, the database refuses anything finer.
  CHECK (debit = round(debit, 2) AND credit = round(credit, 2))
);
CREATE INDEX journal_lines_entry_idx ON journal_lines (journal_entry_id);
CREATE INDEX journal_lines_account_idx ON journal_lines (tenant_id, account_id);

-- Entries: drafts change freely; a posted entry may only become reversed (status + link); nothing else, ever.
CREATE FUNCTION journal_entries_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  p record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Posted journal entries cannot be deleted; reverse them instead'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.status <> 'draft' THEN
    IF NOT (OLD.status = 'posted' AND NEW.status = 'reversed'
            AND (to_jsonb(NEW) - 'status' - 'reversed_by_id') = (to_jsonb(OLD) - 'status' - 'reversed_by_id')) THEN
      RAISE EXCEPTION 'Posted journal entries cannot be changed; reverse them instead'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- Becoming posted (insert as posted, or draft -> posted): the period must exist, cover the date and be open.
  IF NEW.status <> 'draft' THEN
    SELECT * INTO p FROM fiscal_periods WHERE id = NEW.period_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR NEW.accounting_date NOT BETWEEN p.start_date AND p.end_date THEN
      RAISE EXCEPTION 'Journal entry period does not cover its accounting date' USING ERRCODE = 'check_violation';
    END IF;
    IF p.status <> 'open' THEN
      RAISE EXCEPTION 'Accounting period % is closed', to_char(p.start_date, 'YYYY-MM')
        USING ERRCODE = 'check_violation', HINT = 'PERIOD_CLOSED';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_entries_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_guard();

-- Lines can be written only while their entry is a draft.
CREATE FUNCTION journal_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  entry_status text;
BEGIN
  SELECT status INTO entry_status FROM journal_entries
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.journal_entry_id ELSE NEW.journal_entry_id END;
  -- A cascade from deleting a draft finds no entry any more.
  IF entry_status IS NOT NULL AND entry_status <> 'draft' THEN
    RAISE EXCEPTION 'Lines of a posted journal entry cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.journal_entry_id <> OLD.journal_entry_id THEN
    RAISE EXCEPTION 'Journal lines cannot move between entries' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER journal_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_guard();

-- Checked at commit, after all lines are in: a posted entry balances, has two or more lines, and its header
-- totals match its lines. A failure rolls back the whole transaction, so no partial entry can exist.
CREATE FUNCTION journal_entries_balanced() RETURNS trigger
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
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT OR UPDATE ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entries_balanced();

-- ---------------------------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON accounts
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON fiscal_periods
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON document_sequences
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON journal_entries
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON journal_lines
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON accounts TO innpilot_app;
GRANT SELECT, INSERT, UPDATE ON fiscal_periods TO innpilot_app;
GRANT SELECT, INSERT, UPDATE ON document_sequences TO innpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON journal_entries TO innpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON journal_lines TO innpilot_app;
