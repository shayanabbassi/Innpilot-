-- 0004_guests: guest profiles and identity documents (Phase 2 slice 2.3, decisions P2-8, P2-9, D2).
-- Guests belong to the tenant (shared by its properties). Identity document numbers are stored only encrypted
-- (AES-256-GCM, done by the application), with an HMAC for exact-match lookup and the last 4 characters for display.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE guests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id),
  full_name          text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  phone              text CHECK (length(phone) <= 40),
  -- Digits-only key for search and duplicate detection (see normalizePhone in @innpilot/contracts).
  phone_normalized   text CHECK (phone_normalized ~ '^\d{7,20}$'),
  email              citext CHECK (length(email) <= 254),
  nationality        char(2) CHECK (nationality ~ '^[A-Z]{2}$'),
  address_line       text CHECK (length(address_line) <= 300),
  city               text CHECK (length(city) <= 100),
  country_code       char(2) CHECK (country_code ~ '^[A-Z]{2}$'),
  preferences        text CHECK (length(preferences) <= 1000),
  notes              text CHECK (length(notes) <= 2000),
  marketing_consent  boolean NOT NULL DEFAULT false,
  consent_updated_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  UNIQUE (tenant_id, id),
  CHECK ((phone IS NULL) = (phone_normalized IS NULL))
);
CREATE INDEX guests_phone_idx ON guests (tenant_id, phone_normalized);
CREATE INDEX guests_email_idx ON guests (tenant_id, email);
CREATE INDEX guests_name_trgm_idx ON guests USING gin (lower(full_name) gin_trgm_ops);

CREATE TABLE guest_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  guest_id        uuid NOT NULL,
  document_type   text NOT NULL CHECK (document_type IN ('cnic', 'passport', 'driving_license', 'other')),
  issuing_country char(2) NOT NULL CHECK (issuing_country ~ '^[A-Z]{2}$'),
  -- Never the plain number: v1.<iv>.<tag>.<ciphertext>.
  number_enc      text NOT NULL CHECK (number_enc LIKE 'v1.%'),
  number_hmac     bytea NOT NULL CHECK (length(number_hmac) = 32),
  number_last4    text NOT NULL CHECK (number_last4 ~ '^[A-Z0-9]{1,4}$'),
  expiry_date     date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  FOREIGN KEY (tenant_id, guest_id) REFERENCES guests (tenant_id, id)
);
CREATE INDEX guest_documents_guest_idx ON guest_documents (tenant_id, guest_id);
CREATE INDEX guest_documents_lookup_idx ON guest_documents (tenant_id, number_hmac);

CREATE TRIGGER guests_updated_at BEFORE UPDATE ON guests FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- A document is replaced, never edited: correcting a number means removing and re-adding (both audited).
CREATE TRIGGER guest_documents_no_update
  BEFORE UPDATE ON guest_documents
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

ALTER TABLE guests ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guests
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE guest_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guest_documents
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Guests are not deleted here: erasure is a separate, legally reviewed anonymisation workflow.
GRANT SELECT, INSERT, UPDATE ON guests TO innpilot_app;
GRANT SELECT, INSERT, DELETE ON guest_documents TO innpilot_app;
