-- 0013_checkout: room nights posted at check-out, folio settlement and invoices (Phase 3 slice 3.5).
--   * Room nights are posted when the guest checks out (decision D7), one folio charge per booked-room night. The
--     unique key below means a night can never be posted twice, whatever retries happen (OPS-003).
--   * A folio closes only at zero (FIN-008): paid, its credit refunded, written off (Dr write-off expense,
--     Cr guest receivable) or moved to the guest's account (stays in the receivable, folio "on_account").
--   * An invoice is a frozen copy of the folio at check-out: lines, tax summary and the hotel's details as they were.

CREATE TABLE room_night_charges (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL,
  property_id          uuid NOT NULL,
  charge_id            uuid NOT NULL,
  reservation_room_id  uuid NOT NULL,
  night                date NOT NULL,
  FOREIGN KEY (tenant_id, property_id, charge_id) REFERENCES folio_charges (tenant_id, property_id, id),
  UNIQUE (reservation_room_id, night),
  UNIQUE (charge_id)
);
CREATE TRIGGER room_night_charges_append_only BEFORE UPDATE OR DELETE ON room_night_charges
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

ALTER TABLE folios
  ADD COLUMN written_off numeric(19, 4) NOT NULL DEFAULT 0
    CHECK (written_off >= 0 AND written_off = round(written_off, 2)),
  ADD COLUMN write_off_journal_id uuid,
  ADD COLUMN settled_at timestamptz,
  ADD COLUMN settled_by uuid,
  ADD COLUMN settlement_reason text CHECK (length(settlement_reason) <= 500),
  ADD CONSTRAINT folios_write_off_journal_fk FOREIGN KEY (tenant_id, write_off_journal_id)
    REFERENCES journal_entries (tenant_id, id),
  ADD CONSTRAINT folios_settled_by_fk FOREIGN KEY (tenant_id, settled_by) REFERENCES users (tenant_id, id),
  ADD CONSTRAINT folios_write_off_has_journal CHECK (written_off = 0 OR write_off_journal_id IS NOT NULL),
  ADD CONSTRAINT folios_closed_when_settled CHECK (status = 'open' OR settled_at IS NOT NULL);

CREATE TABLE invoices (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  property_id       uuid NOT NULL,
  folio_id          uuid NOT NULL,
  reservation_id    uuid NOT NULL,
  invoice_number    text NOT NULL,
  issue_date        date NOT NULL,
  currency_code     char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  bill_to           text NOT NULL,
  net_amount        numeric(19, 4) NOT NULL,
  tax_amount        numeric(19, 4) NOT NULL,
  gross_amount      numeric(19, 4) NOT NULL,
  paid_amount       numeric(19, 4) NOT NULL,
  written_off       numeric(19, 4) NOT NULL DEFAULT 0,
  balance_due       numeric(19, 4) NOT NULL,
  -- [{code, name, ratePercent, inclusive, base, amount}]
  tax_summary       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The hotel's legal name, address, registration fields and footer at the moment of issue.
  hotel             jsonb NOT NULL,
  created_by        uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (property_id, invoice_number),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folios (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservations (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CHECK (net_amount + tax_amount = gross_amount),
  CHECK (gross_amount - paid_amount - written_off = balance_due)
);
CREATE INDEX invoices_folio_idx ON invoices (tenant_id, folio_id);
CREATE TRIGGER invoices_append_only BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TABLE invoice_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  property_id   uuid NOT NULL,
  invoice_id    uuid NOT NULL,
  line_no       smallint NOT NULL,
  kind          text NOT NULL,
  description   text NOT NULL,
  service_date  date NOT NULL,
  quantity      numeric(9, 2) NOT NULL,
  unit_price    numeric(19, 4) NOT NULL,
  net_amount    numeric(19, 4) NOT NULL,
  tax_amount    numeric(19, 4) NOT NULL,
  gross_amount  numeric(19, 4) NOT NULL,
  -- [{code, ratePercent, amount}]
  taxes         jsonb NOT NULL DEFAULT '[]'::jsonb,
  FOREIGN KEY (tenant_id, property_id, invoice_id) REFERENCES invoices (tenant_id, property_id, id),
  UNIQUE (invoice_id, line_no)
);
CREATE TRIGGER invoice_lines_append_only BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

ALTER TABLE room_night_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON room_night_charges
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON invoice_lines
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT ON room_night_charges, invoices, invoice_lines TO innpilot_app;
