-- Phase 4 slice 4.3: suppliers, expenses and payables (P4-6, P4-7, D12).
-- Two flows (data dictionary: "distinguish cash-paid expense from credit supplier bill"):
--   cash expense: money leaves a cash or bank account when recorded (Dr expense, Cr cash) and is reviewed afterwards;
--   supplier bill: approved into accounts payable (Dr expense, Cr 2000) and paid in one or more payments.
-- Accounts payable lines carry the supplier, so what each supplier is owed is read from the ledger.

INSERT INTO permissions (code, description)
  VALUES ('supplier.manage', 'Create and change suppliers');
INSERT INTO role_permissions (role_code, permission_code)
  VALUES ('tenant_owner', 'supplier.manage'), ('hotel_manager', 'supplier.manage'), ('accountant', 'supplier.manage');

-- ---------------------------------------------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE suppliers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 160),
  contact             text CHECK (length(contact) <= 200),
  tax_identifier      text CHECK (length(tax_identifier) <= 40),
  payment_terms_days  integer NOT NULL DEFAULT 0 CHECK (payment_terms_days BETWEEN 0 AND 365),
  notes               text CHECK (length(notes) <= 500),
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (id)
);
CREATE UNIQUE INDEX suppliers_name_key ON suppliers (tenant_id, lower(btrim(name)));
CREATE TRIGGER suppliers_no_delete BEFORE DELETE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

ALTER TABLE journal_lines ADD COLUMN supplier_id uuid;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_supplier_fk
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id);
CREATE INDEX journal_lines_supplier_idx ON journal_lines (supplier_id) WHERE supplier_id IS NOT NULL;

-- Posted entries balance; cash ledger lines name their cash account (4.1); accounts payable lines name their
-- supplier (4.3). Checked at commit.
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
  IF EXISTS (
    SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.journal_entry_id = e.id
      -- coalesce: accounts without a system role would otherwise make the comparison unknown and pass.
      AND (coalesce(a.system_role = 'accounts_payable', false) <> (l.supplier_id IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'Journal entry % has an accounts payable line without its supplier, or a supplier elsewhere', e.id
      USING ERRCODE = 'check_violation', HINT = 'SUPPLIER_REQUIRED';
  END IF;
  RETURN NULL;
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Expense vouchers
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE expense_vouchers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  property_id        uuid NOT NULL,
  voucher_number     text NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('cash', 'bill')),
  -- draft → (cash) paid, reviewed later | (bill) submitted → approved → partly_paid → paid; void from any unpaid state.
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft', 'submitted', 'approved', 'partly_paid', 'paid', 'void')),
  supplier_id        uuid,
  payee              text CHECK (length(payee) <= 160),
  expense_date       date NOT NULL,
  due_date           date,
  bill_reference     text CHECK (length(bill_reference) <= 80),
  description        text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 500),
  -- D12: a reference to the paper receipt or bill (file number, folder); scanned files come with file storage.
  attachment_ref     text CHECK (length(attachment_ref) <= 200),
  cash_account_id    uuid,
  net_amount         numeric(19, 4) NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  tax_amount         numeric(19, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total_amount       numeric(19, 4) NOT NULL DEFAULT 0 CHECK (total_amount = net_amount + tax_amount),
  journal_entry_id   uuid,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  submitted_by       uuid,
  submitted_at       timestamptz,
  approved_by        uuid,
  approved_at        timestamptz,
  voided_by          uuid,
  voided_at          timestamptz,
  void_reason        text CHECK (length(void_reason) <= 500),
  UNIQUE (tenant_id, id),
  UNIQUE (property_id, voucher_number),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES suppliers (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, cash_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, voided_by) REFERENCES users (tenant_id, id),
  CONSTRAINT expense_bill_supplier CHECK (kind <> 'bill' OR supplier_id IS NOT NULL),
  -- Maker-checker: whoever created or submitted it cannot approve it.
  CONSTRAINT expense_maker_checker
    CHECK (approved_by IS NULL OR (approved_by <> created_by AND approved_by IS DISTINCT FROM submitted_by)),
  CONSTRAINT expense_void_reason
    CHECK (status <> 'void' OR (voided_by IS NOT NULL AND coalesce(length(btrim(void_reason)), 0) >= 3)),
  CONSTRAINT expense_posted CHECK (status IN ('draft', 'submitted', 'void') OR journal_entry_id IS NOT NULL),
  CONSTRAINT expense_cash_account CHECK (kind <> 'cash' OR status IN ('draft', 'void') OR cash_account_id IS NOT NULL)
);
CREATE INDEX expense_vouchers_status_idx ON expense_vouchers (tenant_id, property_id, status, expense_date DESC);
CREATE INDEX expense_vouchers_supplier_idx ON expense_vouchers (supplier_id) WHERE supplier_id IS NOT NULL;

CREATE TABLE expense_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  voucher_id        uuid NOT NULL,
  line_no           integer NOT NULL CHECK (line_no > 0),
  account_id        uuid NOT NULL,
  description       text CHECK (length(description) <= 300),
  amount            numeric(19, 4) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  tax_amount        numeric(19, 4) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0 AND tax_amount = round(tax_amount, 2)),
  -- P4-7: recoverable purchase tax goes to Tax recoverable (1300); otherwise it is part of the cost.
  tax_recoverable   boolean NOT NULL DEFAULT false,
  UNIQUE (voucher_id, line_no),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES expense_vouchers (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id)
);

CREATE TABLE expense_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  property_id       uuid NOT NULL,
  voucher_id        uuid NOT NULL,
  cash_account_id   uuid NOT NULL,
  amount            numeric(19, 4) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  business_date     date NOT NULL,
  reference         text CHECK (length(reference) <= 80),
  journal_entry_id  uuid NOT NULL,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES expense_vouchers (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, cash_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX expense_payments_voucher_idx ON expense_payments (voucher_id);
CREATE TRIGGER expense_payments_append_only BEFORE UPDATE OR DELETE ON expense_payments
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- Payments never exceed the bill (checked under the voucher row lock the service takes, and here).
CREATE FUNCTION expense_payments_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  v record;
  paid numeric;
BEGIN
  SELECT * INTO v FROM expense_vouchers WHERE id = NEW.voucher_id FOR UPDATE;
  IF v.kind <> 'bill' OR v.status NOT IN ('approved', 'partly_paid') THEN
    RAISE EXCEPTION 'Only an approved, unpaid supplier bill can be paid' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(sum(amount), 0) INTO paid FROM expense_payments WHERE voucher_id = NEW.voucher_id;
  IF paid + NEW.amount > v.total_amount THEN
    RAISE EXCEPTION 'Payments would exceed the bill' USING ERRCODE = 'check_violation', HINT = 'PAYMENT_EXCEEDS_BALANCE';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER expense_payments_guard BEFORE INSERT ON expense_payments
  FOR EACH ROW EXECUTE FUNCTION expense_payments_guard();

-- Lines and amounts are fixed once a voucher leaves draft ("edits refused once submitted"). Only status, approval,
-- payment and void fields move after that.
CREATE FUNCTION expense_vouchers_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Expense vouchers are never deleted; void them' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'draft' AND (
       (NEW.tenant_id, NEW.property_id, NEW.voucher_number, NEW.kind, NEW.supplier_id, NEW.payee, NEW.expense_date,
        NEW.due_date, NEW.bill_reference, NEW.description, NEW.attachment_ref, NEW.net_amount, NEW.tax_amount,
        NEW.total_amount, NEW.created_by)
       IS DISTINCT FROM
       (OLD.tenant_id, OLD.property_id, OLD.voucher_number, OLD.kind, OLD.supplier_id, OLD.payee, OLD.expense_date,
        OLD.due_date, OLD.bill_reference, OLD.description, OLD.attachment_ref, OLD.net_amount, OLD.tax_amount,
        OLD.total_amount, OLD.created_by)
       OR (OLD.cash_account_id IS NOT NULL AND NEW.cash_account_id IS DISTINCT FROM OLD.cash_account_id)
       OR (OLD.journal_entry_id IS NOT NULL AND NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id)) THEN
    RAISE EXCEPTION 'A submitted expense cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'void' THEN
    RAISE EXCEPTION 'A void expense cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'paid' AND NEW.status NOT IN ('paid', 'void') THEN
    RAISE EXCEPTION 'Expense status cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER expense_vouchers_guard BEFORE UPDATE OR DELETE ON expense_vouchers
  FOR EACH ROW EXECUTE FUNCTION expense_vouchers_guard();

CREATE FUNCTION expense_lines_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM expense_vouchers
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.voucher_id ELSE NEW.voucher_id END;
  IF st IS NOT NULL AND st <> 'draft' THEN
    RAISE EXCEPTION 'Lines of a submitted expense cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER expense_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON expense_lines
  FOR EACH ROW EXECUTE FUNCTION expense_lines_guard();

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON suppliers
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON expense_vouchers
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON expense_lines
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON expense_payments
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON suppliers, expense_vouchers TO innpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_lines TO innpilot_app;
GRANT SELECT, INSERT ON expense_payments TO innpilot_app;
