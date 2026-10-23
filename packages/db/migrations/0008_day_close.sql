-- 0008_day_close: interim business-date close (Phase 2 slice 2.7, decision D3).
-- One row per closed business date and property. The unique key makes a second close of the same date impossible,
-- even from two screens at once (the same guarantee the Phase 4 night audit needs for OPS-004).

CREATE TABLE business_date_closes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  property_id       uuid NOT NULL,
  business_date     date NOT NULL,
  next_date         date NOT NULL,
  no_shows_marked   integer NOT NULL DEFAULT 0 CHECK (no_shows_marked >= 0),
  -- Items still open at close time, each acknowledged by the reason below.
  unresolved        jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason            text CHECK (length(reason) <= 500),
  snapshot          jsonb NOT NULL,
  closed_by         uuid NOT NULL,
  closed_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, closed_by) REFERENCES users (tenant_id, id),
  UNIQUE (property_id, business_date),
  CHECK (next_date = business_date + 1),
  CHECK (jsonb_array_length(unresolved) = 0 OR reason IS NOT NULL)
);
CREATE INDEX business_date_closes_history_idx ON business_date_closes (tenant_id, property_id, business_date DESC);

-- A close is a historical record: never edited or removed.
CREATE TRIGGER business_date_closes_append_only
  BEFORE UPDATE OR DELETE ON business_date_closes
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

ALTER TABLE business_date_closes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_date_closes
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT ON business_date_closes TO innpilot_app;
