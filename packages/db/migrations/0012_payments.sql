-- 0012_payments: cash accounts, payments, deposits, refunds and receipts (Phase 3 slice 3.4).
-- Money received is a source document posted to the ledger in the same transaction (P3-12):
--   * before check-in it is a deposit:  Dr cash/bank/clearing, Cr guest deposits (a liability, FIN-007);
--   * during the stay it is a payment:  Dr cash/bank/clearing, Cr guest receivable.
-- A deposit is applied to the bill later (Dr guest deposits, Cr guest receivable), recorded here as a deposit
-- application. A refund links to its payment and can never exceed what is left of it (Scenario C).
-- No card data is stored: only a terminal or bank reference.

-- ---------------------------------------------------------------------------------------------------------------
-- Cash accounts: where money is held, each on a ledger asset account
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE cash_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  property_id        uuid NOT NULL,
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  kind               text NOT NULL CHECK (kind IN ('cash', 'bank', 'card_clearing', 'other')),
  ledger_account_id  uuid NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (property_id, name),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, ledger_account_id) REFERENCES accounts (tenant_id, id)
);
CREATE TRIGGER cash_accounts_no_delete BEFORE DELETE ON cash_accounts
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------------------------------------------
-- Payments, deposit applications, refunds
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  property_id         uuid NOT NULL,
  folio_id            uuid NOT NULL,
  reservation_id      uuid NOT NULL,
  -- deposit: received before check-in (held as a liability until applied). payment: received during the stay.
  kind                text NOT NULL CHECK (kind IN ('deposit', 'payment')),
  method              text NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'card', 'other')),
  cash_account_id     uuid NOT NULL,
  amount              numeric(19, 4) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  currency_code       char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  business_date       date NOT NULL,
  received_at         timestamptz NOT NULL DEFAULT now(),
  -- A card terminal or bank reference. Never a card number: the application refuses long digit runs.
  external_reference  text CHECK (length(external_reference) <= 60),
  notes               text CHECK (length(notes) <= 300),
  receipt_number      text NOT NULL,
  journal_entry_id    uuid NOT NULL,
  idempotency_key     text,
  created_by          uuid NOT NULL,
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (property_id, receipt_number),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folios (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservations (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, cash_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX payments_folio_idx ON payments (tenant_id, folio_id);
CREATE INDEX payments_date_idx ON payments (tenant_id, property_id, business_date);
CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TABLE deposit_applications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  property_id       uuid NOT NULL,
  payment_id        uuid NOT NULL,
  amount            numeric(19, 4) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  journal_entry_id  uuid NOT NULL,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, property_id, payment_id) REFERENCES payments (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE TRIGGER deposit_applications_append_only BEFORE UPDATE OR DELETE ON deposit_applications
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TABLE refunds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  property_id         uuid NOT NULL,
  payment_id          uuid NOT NULL,
  amount              numeric(19, 4) NOT NULL CHECK (amount > 0 AND amount = round(amount, 2)),
  method              text NOT NULL CHECK (method IN ('cash', 'bank_transfer', 'card', 'other')),
  cash_account_id     uuid NOT NULL,
  external_reference  text CHECK (length(external_reference) <= 60),
  reason              text NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
  business_date       date NOT NULL,
  refund_number       text NOT NULL,
  journal_entry_id    uuid NOT NULL,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (property_id, refund_number),
  FOREIGN KEY (tenant_id, property_id, payment_id) REFERENCES payments (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, cash_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX refunds_payment_idx ON refunds (tenant_id, payment_id);
CREATE TRIGGER refunds_append_only BEFORE UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- What is left of a payment never goes below zero: refunds plus deposit applications ≤ the amount received.
-- The application locks the payment row first; this is the database's own guarantee.
CREATE FUNCTION payment_remainder_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  received numeric;
  used numeric;
BEGIN
  SELECT amount INTO received FROM payments WHERE id = NEW.payment_id FOR UPDATE;
  SELECT coalesce((SELECT sum(amount) FROM refunds WHERE payment_id = NEW.payment_id), 0)
       + coalesce((SELECT sum(amount) FROM deposit_applications WHERE payment_id = NEW.payment_id), 0)
    INTO used;
  IF used + NEW.amount > received THEN
    RAISE EXCEPTION 'Payment % has only % left', NEW.payment_id, received - used
      USING ERRCODE = 'check_violation', HINT = 'REFUND_EXCEEDS_REMAINDER';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER refunds_remainder BEFORE INSERT ON refunds
  FOR EACH ROW EXECUTE FUNCTION payment_remainder_guard();
CREATE TRIGGER deposit_applications_remainder BEFORE INSERT ON deposit_applications
  FOR EACH ROW EXECUTE FUNCTION payment_remainder_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- The cancellation/no-show charge category (used when a deposit is kept as a fee, P3-15)
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE charge_categories DROP CONSTRAINT charge_categories_system_kind_check;
ALTER TABLE charge_categories ADD CONSTRAINT charge_categories_system_kind_check
  CHECK (system_kind IN ('room', 'cancellation'));

CREATE OR REPLACE FUNCTION seed_property_charges(p_property uuid) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  INSERT INTO charge_categories (tenant_id, property_id, code, name, revenue_account_id, system_kind)
  SELECT p.tenant_id, p.id, t.code, t.name, a.id, t.kind
  FROM properties p
  CROSS JOIN (VALUES
    ('room',         'Room',                          '4000', 'room'),
    ('fnb',          'Food and beverage',             '4100', NULL),
    ('laundry',      'Laundry',                       '4200', NULL),
    ('transport',    'Transport',                     '4300', NULL),
    ('meeting',      'Meeting room',                  '4400', NULL),
    ('cancellation', 'Cancellation and no-show fees', '4500', 'cancellation'),
    ('other',        'Other',                         '4900', NULL)
  ) AS t (code, name, account_code, kind)
  JOIN accounts a ON a.tenant_id = p.tenant_id AND a.code = t.account_code
  WHERE p.id = p_property
  ON CONFLICT (property_id, code) DO NOTHING;

  INSERT INTO invoice_profiles (property_id, tenant_id, legal_name)
  SELECT id, tenant_id, legal_name FROM properties WHERE id = p_property
  ON CONFLICT (property_id) DO NOTHING;

  INSERT INTO cash_accounts (tenant_id, property_id, name, kind, ledger_account_id)
  SELECT p.tenant_id, p.id, t.name, t.kind, a.id
  FROM properties p
  CROSS JOIN (VALUES
    ('Front desk cash', 'cash',          'cash_on_hand'),
    ('Bank',            'bank',          'bank'),
    ('Card terminal',   'card_clearing', 'payment_clearing')
  ) AS t (name, kind, role)
  JOIN accounts a ON a.tenant_id = p.tenant_id AND a.system_role = t.role
  WHERE p.id = p_property
  ON CONFLICT (property_id, name) DO NOTHING;
$$;

SELECT seed_property_charges(id) FROM properties;

-- ---------------------------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE cash_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_accounts
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON payments
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON deposit_applications
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON refunds
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON cash_accounts TO innpilot_app;
GRANT SELECT, INSERT ON payments, deposit_applications, refunds TO innpilot_app;
-- UPDATE only so a payment row can be locked (SELECT … FOR UPDATE); the append-only trigger refuses real updates.
GRANT UPDATE ON payments TO innpilot_app;
