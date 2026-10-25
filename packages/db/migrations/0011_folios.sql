-- 0011_folios: guest folios and folio charges (Phase 3 slice 3.3).
-- A folio is a subledger of a stay (accounting spec §5): every charge, allowance and transfer is a source record
-- with a status and a posted journal, and journal lines carry the folio so the folio balance can always be
-- reconciled to the ledger. Charges are never deleted or edited; corrections are voids (reversals), allowances
-- (negative charges with a reason) and transfers to another folio.

CREATE TABLE folios (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  property_id     uuid NOT NULL,
  reservation_id  uuid NOT NULL,
  guest_id        uuid NOT NULL,
  label           text NOT NULL DEFAULT 'Main' CHECK (length(btrim(label)) BETWEEN 1 AND 40),
  is_primary      boolean NOT NULL DEFAULT false,
  -- open → settled / on_account at check-out (slice 3.5).
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'on_account')),
  currency_code   char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservations (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, guest_id) REFERENCES guests (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE UNIQUE INDEX folios_one_primary ON folios (reservation_id) WHERE is_primary;
CREATE INDEX folios_reservation_idx ON folios (tenant_id, reservation_id);
CREATE INDEX folios_open_idx ON folios (tenant_id, property_id) WHERE status = 'open';
CREATE TRIGGER folios_updated_at BEFORE UPDATE ON folios FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER folios_no_delete BEFORE DELETE ON folios FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TABLE folio_charges (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  property_id            uuid NOT NULL,
  folio_id               uuid NOT NULL,
  category_id            uuid NOT NULL,
  -- charge: adds to the bill. allowance: a discount or correction with a reason, stored as negative amounts.
  -- room_night: posted at check-out (decision D7, slice 3.5).
  kind                   text NOT NULL CHECK (kind IN ('charge', 'allowance', 'room_night')),
  description            text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 200),
  service_date           date NOT NULL,
  quantity               numeric(9, 2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price             numeric(19, 4) NOT NULL CHECK (unit_price >= 0),
  -- Signed: positive for charges and room nights, negative for allowances. net + tax_total = gross.
  net_amount             numeric(19, 4) NOT NULL,
  tax_amount             numeric(19, 4) NOT NULL,
  gross_amount           numeric(19, 4) NOT NULL,
  -- posted: counts on the folio. voided: reversed in the ledger. transferred: moved to another folio.
  status                 text NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'voided', 'transferred')),
  reason                 text CHECK (length(reason) <= 500),
  journal_entry_id       uuid NOT NULL,
  transferred_from_id    uuid,
  transferred_to_id      uuid,
  void_journal_entry_id  uuid,
  voided_by              uuid,
  voided_at              timestamptz,
  void_reason            text CHECK (length(void_reason) <= 500),
  created_by             uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folios (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, category_id) REFERENCES charge_categories (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, void_journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, transferred_from_id) REFERENCES folio_charges (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, transferred_to_id) REFERENCES folio_charges (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, voided_by) REFERENCES users (tenant_id, id),
  -- Whole paisa (D5), and the parts always add up.
  CHECK (net_amount = round(net_amount, 2) AND tax_amount = round(tax_amount, 2) AND gross_amount = round(gross_amount, 2)),
  CHECK (net_amount + tax_amount = gross_amount),
  CHECK (CASE WHEN kind = 'allowance' THEN gross_amount < 0 AND net_amount <= 0 AND tax_amount <= 0
              ELSE gross_amount > 0 AND net_amount >= 0 AND tax_amount >= 0 END),
  CHECK (kind <> 'allowance' OR reason IS NOT NULL),
  CHECK ((status = 'voided') = (void_journal_entry_id IS NOT NULL AND voided_at IS NOT NULL AND void_reason IS NOT NULL)),
  CHECK ((status = 'transferred') = (transferred_to_id IS NOT NULL))
);
CREATE INDEX folio_charges_folio_idx ON folio_charges (tenant_id, folio_id, service_date);

-- Amounts and sources never change. The only updates allowed are posted → voided (with the void fields) and
-- posted → transferred (with the link to the new charge).
CREATE FUNCTION folio_charges_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Folio charges cannot be deleted; void them instead' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'posted' OR NEW.status NOT IN ('voided', 'transferred')
     OR (to_jsonb(NEW) - 'status' - 'void_journal_entry_id' - 'voided_by' - 'voided_at' - 'void_reason'
           - 'transferred_to_id')
        <> (to_jsonb(OLD) - 'status' - 'void_journal_entry_id' - 'voided_by' - 'voided_at' - 'void_reason'
           - 'transferred_to_id') THEN
    RAISE EXCEPTION 'Folio charges cannot be changed; void or transfer them instead'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER folio_charges_guard BEFORE UPDATE OR DELETE ON folio_charges
  FOR EACH ROW EXECUTE FUNCTION folio_charges_guard();

-- The tax snapshot of each charge (TAX-001): code, name, rate and inclusivity as they were on the service date,
-- and the account the tax was posted to. Later rate changes never touch these rows.
CREATE TABLE folio_charge_taxes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  property_id         uuid NOT NULL,
  charge_id           uuid NOT NULL,
  tax_code_id         uuid NOT NULL,
  code                text NOT NULL,
  name                text NOT NULL,
  rate_percent        numeric(9, 4) NOT NULL,
  inclusive           boolean NOT NULL,
  base_amount         numeric(19, 4) NOT NULL,
  tax_amount          numeric(19, 4) NOT NULL,
  payable_account_id  uuid NOT NULL,
  FOREIGN KEY (tenant_id, property_id, charge_id) REFERENCES folio_charges (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, tax_code_id) REFERENCES tax_codes (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, payable_account_id) REFERENCES accounts (tenant_id, id),
  UNIQUE (charge_id, tax_code_id)
);
CREATE TRIGGER folio_charge_taxes_append_only BEFORE UPDATE OR DELETE ON folio_charge_taxes
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- The folio dimension on ledger lines, so receivable movements can be traced to each folio.
ALTER TABLE journal_lines ADD COLUMN folio_id uuid;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_folio_fk
  FOREIGN KEY (tenant_id, folio_id) REFERENCES folios (tenant_id, id);
CREATE INDEX journal_lines_folio_idx ON journal_lines (tenant_id, folio_id) WHERE folio_id IS NOT NULL;

-- Guests already in house get their main folio now; new check-ins open one automatically.
INSERT INTO folios (tenant_id, property_id, reservation_id, guest_id, is_primary, currency_code)
SELECT r.tenant_id, r.property_id, r.id, r.guest_id, true, p.currency_code
FROM reservations r JOIN properties p ON p.id = r.property_id
WHERE r.status = 'checked_in';

ALTER TABLE folios ENABLE ROW LEVEL SECURITY;
ALTER TABLE folio_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE folio_charge_taxes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON folios
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON folio_charges
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON folio_charge_taxes
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON folios TO innpilot_app;
GRANT SELECT, INSERT, UPDATE ON folio_charges TO innpilot_app;
GRANT SELECT, INSERT ON folio_charge_taxes TO innpilot_app;
