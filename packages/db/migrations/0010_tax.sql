-- 0010_tax: tax codes with effective-dated rates, charge categories and the invoice profile (Phase 3 slice 3.2).
-- No tax rates are shipped: a property starts with no tax codes, and that is a valid setup (P3-8). Rates are
-- never edited in place, so a document taxed at a rate can always show that rate (TAX-001); later slices also
-- snapshot the rate on each charge.

CREATE TABLE tax_codes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  property_id         uuid NOT NULL,
  code                text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{1,16}$'),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- Free text, e.g. "Punjab" or "Federal". Shown on invoices and the tax summary; never interpreted.
  jurisdiction        text CHECK (length(jurisdiction) <= 80),
  payable_account_id  uuid NOT NULL,
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (property_id, code),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, payable_account_id) REFERENCES accounts (tenant_id, id)
);
CREATE TRIGGER tax_codes_updated_at BEFORE UPDATE ON tax_codes FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tax_codes_no_delete BEFORE DELETE ON tax_codes FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TABLE tax_rates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  property_id     uuid NOT NULL,
  tax_code_id     uuid NOT NULL,
  effective_from  date NOT NULL,
  rate_percent    numeric(9, 4) NOT NULL CHECK (rate_percent >= 0 AND rate_percent <= 100),
  -- Inclusive: the charged amount already contains this tax. Exclusive (the default, D6): tax is added on top.
  inclusive       boolean NOT NULL DEFAULT false,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, property_id, tax_code_id) REFERENCES tax_codes (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  UNIQUE (tax_code_id, effective_from)
);
CREATE INDEX tax_rates_lookup_idx ON tax_rates (tenant_id, tax_code_id, effective_from DESC);
-- A change of rate is a new row. Deleting a not-yet-effective row is allowed (the application checks the business
-- date); updating any row is not.
CREATE TRIGGER tax_rates_no_update BEFORE UPDATE ON tax_rates FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TABLE charge_categories (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  property_id         uuid NOT NULL,
  code                text NOT NULL CHECK (code ~ '^[a-z0-9_]{2,24}$'),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  revenue_account_id  uuid NOT NULL,
  -- 'room' marks the category used for room nights at check-out. One per property; it cannot be deactivated.
  system_kind         text CHECK (system_kind IN ('room')),
  active              boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (property_id, code),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, revenue_account_id) REFERENCES accounts (tenant_id, id),
  CHECK (system_kind IS NULL OR active)
);
CREATE UNIQUE INDEX charge_categories_system_kind_key ON charge_categories (property_id, system_kind)
  WHERE system_kind IS NOT NULL;
CREATE TRIGGER charge_categories_updated_at BEFORE UPDATE ON charge_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER charge_categories_no_delete BEFORE DELETE ON charge_categories
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- Default tax codes applied to new charges of a category. Several codes may apply (e.g. two levies).
CREATE TABLE charge_category_taxes (
  tenant_id    uuid NOT NULL,
  property_id  uuid NOT NULL,
  category_id  uuid NOT NULL,
  tax_code_id  uuid NOT NULL,
  PRIMARY KEY (category_id, tax_code_id),
  FOREIGN KEY (tenant_id, property_id, category_id) REFERENCES charge_categories (tenant_id, property_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, property_id, tax_code_id) REFERENCES tax_codes (tenant_id, property_id, id)
);

-- What prints on invoices. Registration fields are label/value pairs so no country's fields are hardcoded.
CREATE TABLE invoice_profiles (
  property_id          uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL,
  legal_name           text CHECK (length(legal_name) <= 160),
  address              text CHECK (length(address) <= 500),
  registration_fields  jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(registration_fields) = 'array'
                         AND jsonb_array_length(registration_fields) <= 6),
  invoice_prefix       text NOT NULL DEFAULT 'INV-' CHECK (invoice_prefix ~ '^[A-Za-z0-9/_-]{0,12}$'),
  receipt_prefix       text NOT NULL DEFAULT 'RCT-' CHECK (receipt_prefix ~ '^[A-Za-z0-9/_-]{0,12}$'),
  footer               text CHECK (length(footer) <= 1000),
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users (tenant_id, id)
);
CREATE TRIGGER invoice_profiles_updated_at BEFORE UPDATE ON invoice_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- Defaults for every property: charge categories on the template revenue accounts, an empty invoice profile.
-- ---------------------------------------------------------------------------------------------------------------

CREATE FUNCTION seed_property_charges(p_property uuid) RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  INSERT INTO charge_categories (tenant_id, property_id, code, name, revenue_account_id, system_kind)
  SELECT p.tenant_id, p.id, t.code, t.name, a.id, t.kind
  FROM properties p
  CROSS JOIN (VALUES
    ('room',      'Room',              '4000', 'room'),
    ('fnb',       'Food and beverage', '4100', NULL),
    ('laundry',   'Laundry',           '4200', NULL),
    ('transport', 'Transport',         '4300', NULL),
    ('meeting',   'Meeting room',      '4400', NULL),
    ('other',     'Other',             '4900', NULL)
  ) AS t (code, name, account_code, kind)
  JOIN accounts a ON a.tenant_id = p.tenant_id AND a.code = t.account_code
  WHERE p.id = p_property
  ON CONFLICT (property_id, code) DO NOTHING;

  INSERT INTO invoice_profiles (property_id, tenant_id, legal_name)
  SELECT id, tenant_id, legal_name FROM properties WHERE id = p_property
  ON CONFLICT (property_id) DO NOTHING;
$$;

CREATE FUNCTION properties_seed_charges() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  PERFORM seed_property_charges(NEW.id);
  RETURN NULL;
END
$$;
CREATE TRIGGER properties_seed_charges AFTER INSERT ON properties
  FOR EACH ROW EXECUTE FUNCTION properties_seed_charges();

SELECT seed_property_charges(id) FROM properties;

-- ---------------------------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE tax_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE charge_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE charge_category_taxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tax_codes
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON tax_rates
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON charge_categories
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON charge_category_taxes
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON invoice_profiles
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON tax_codes TO innpilot_app;
GRANT SELECT, INSERT, DELETE ON tax_rates TO innpilot_app;
GRANT SELECT, INSERT, UPDATE ON charge_categories TO innpilot_app;
GRANT SELECT, INSERT, DELETE ON charge_category_taxes TO innpilot_app;
GRANT SELECT, INSERT, UPDATE ON invoice_profiles TO innpilot_app;
