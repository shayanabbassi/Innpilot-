-- Phase 4 slice 4.6: month-end checklist and year-end close (P4-10, P4-11, D10).
-- A month closes only when its checklist has no blockers; warnings need a reason, kept with the period. The fiscal
-- year is the calendar year (D10). Year-end posts, per property, the closing entry dated 31 December that moves the
-- year's revenue, cost and expense balances to Retained earnings, then closes December. Reopening a year (owner,
-- reason) reverses those entries on 31 December and reopens December.

INSERT INTO permissions (code, description)
  VALUES ('fiscal_year.reopen', 'Reopen a closed fiscal year');
INSERT INTO role_permissions (role_code, permission_code) VALUES ('tenant_owner', 'fiscal_year.reopen');

ALTER TABLE fiscal_periods
  ADD COLUMN close_reason text CHECK (length(close_reason) <= 500),
  -- The checklist as it stood when the month was closed: what was checked and which warnings were accepted.
  ADD COLUMN close_checklist jsonb;

CREATE TABLE fiscal_years (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  year               integer NOT NULL CHECK (year BETWEEN 2000 AND 2200),
  status             text NOT NULL DEFAULT 'closed' CHECK (status IN ('closed', 'reopened')),
  -- Net result moved to retained earnings (credit positive: a profit).
  result             numeric(19, 4) NOT NULL,
  close_reason       text CHECK (length(close_reason) <= 500),
  closed_by          uuid NOT NULL,
  closed_at          timestamptz NOT NULL DEFAULT now(),
  reopened_by        uuid,
  reopened_at        timestamptz,
  reopen_reason      text CHECK (length(reopen_reason) <= 500),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants (id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, reopened_by) REFERENCES users (tenant_id, id),
  CONSTRAINT fiscal_year_reopened CHECK (
    (status = 'reopened') = (reopened_by IS NOT NULL AND reopened_at IS NOT NULL
                             AND coalesce(length(btrim(reopen_reason)), 0) >= 3))
);
-- A year is closed at most once at a time; a reopened close stays as history.
CREATE UNIQUE INDEX fiscal_years_closed ON fiscal_years (tenant_id, year) WHERE status = 'closed';

-- Only closed → reopened, with its own fields; nothing else ever changes, nothing is deleted.
CREATE FUNCTION fiscal_years_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.status <> 'closed' OR NEW.status <> 'reopened'
     OR (NEW.tenant_id, NEW.year, NEW.result, NEW.close_reason, NEW.closed_by, NEW.closed_at)
        IS DISTINCT FROM (OLD.tenant_id, OLD.year, OLD.result, OLD.close_reason, OLD.closed_by, OLD.closed_at) THEN
    RAISE EXCEPTION 'A year-end close can only be reopened' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER fiscal_years_guard BEFORE UPDATE OR DELETE ON fiscal_years
  FOR EACH ROW EXECUTE FUNCTION fiscal_years_guard();

CREATE TABLE fiscal_year_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  fiscal_year_id    uuid NOT NULL,
  property_id       uuid NOT NULL,
  journal_entry_id  uuid NOT NULL,
  UNIQUE (fiscal_year_id, property_id),
  FOREIGN KEY (tenant_id, fiscal_year_id) REFERENCES fiscal_years (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id)
);
CREATE TRIGGER fiscal_year_entries_append_only BEFORE UPDATE OR DELETE ON fiscal_year_entries
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

ALTER TABLE fiscal_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_year_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_years
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON fiscal_year_entries
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON fiscal_years TO innpilot_app;
GRANT SELECT, INSERT ON fiscal_year_entries TO innpilot_app;
