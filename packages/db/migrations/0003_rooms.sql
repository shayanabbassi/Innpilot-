-- 0003_rooms: room types, rooms, effective-dated base rates and room status history (Phase 2 slice 2.2).
-- Same isolation rules as 0001: tenant RLS on every table and composite foreign keys so a room can only use a
-- room type of the same property, and nothing can reference another tenant's rows.

CREATE TABLE room_types (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  property_id       uuid NOT NULL,
  code              citext NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,11}$'),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  description       text CHECK (length(description) <= 500),
  capacity_adults   integer NOT NULL CHECK (capacity_adults BETWEEN 1 AND 20),
  capacity_children integer NOT NULL DEFAULT 0 CHECK (capacity_children BETWEEN 0 AND 20),
  active            boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 1000),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  UNIQUE (property_id, code),
  UNIQUE (tenant_id, property_id, id)
);
CREATE INDEX room_types_scope_idx ON room_types (tenant_id, property_id);

CREATE TABLE rooms (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  property_id        uuid NOT NULL,
  room_type_id       uuid NOT NULL,
  room_number        citext NOT NULL CHECK (room_number ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,9}$'),
  floor              text CHECK (length(floor) <= 10),
  housekeeping_state text NOT NULL DEFAULT 'clean'
                     CHECK (housekeeping_state IN ('dirty', 'cleaning', 'clean', 'inspected')),
  service_state      text NOT NULL DEFAULT 'in_service' CHECK (service_state IN ('in_service', 'out_of_order')),
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  -- The room type must belong to the same tenant AND the same property.
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_types (tenant_id, property_id, id),
  -- citext makes "a-12" and "A-12" the same room number.
  UNIQUE (property_id, room_number),
  UNIQUE (tenant_id, property_id, id)
);
CREATE INDEX rooms_scope_idx ON rooms (tenant_id, property_id, room_type_id);

-- Base nightly rate per room type, effective from a business date until the next row. Reservations snapshot the
-- agreed rate, so these rows only affect new bookings.
CREATE TABLE room_type_rates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  property_id    uuid NOT NULL,
  room_type_id   uuid NOT NULL,
  effective_from date NOT NULL,
  nightly_rate   numeric(19, 4) NOT NULL CHECK (nightly_rate > 0),
  currency_code  char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_types (tenant_id, property_id, id),
  UNIQUE (room_type_id, effective_from)
);
CREATE INDEX room_type_rates_lookup_idx ON room_type_rates (tenant_id, room_type_id, effective_from DESC);

-- Rates are never edited in place: a change is a new row. Deleting a not-yet-effective row is allowed (the
-- application checks the business date); updating any row is not.
CREATE TRIGGER room_type_rates_no_update
  BEFORE UPDATE ON room_type_rates
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- Every housekeeping or service state change, append-only.
CREATE TABLE room_status_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  property_id   uuid NOT NULL,
  room_id       uuid NOT NULL,
  dimension     text NOT NULL CHECK (dimension IN ('housekeeping', 'service')),
  from_state    text,
  to_state      text NOT NULL,
  reason        text CHECK (length(reason) <= 500),
  actor_user_id uuid,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, property_id, room_id) REFERENCES rooms (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX room_status_events_room_idx ON room_status_events (tenant_id, room_id, occurred_at DESC);

CREATE TRIGGER room_status_events_append_only
  BEFORE UPDATE OR DELETE ON room_status_events
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

CREATE TRIGGER room_types_updated_at BEFORE UPDATE ON room_types FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER rooms_updated_at BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE room_types ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON room_types
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rooms
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE room_type_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON room_type_rates
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE room_status_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON room_status_events
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- No DELETE on room types or rooms: they are deactivated, because reservations and history refer to them.
GRANT SELECT, INSERT, UPDATE ON room_types, rooms TO innpilot_app;
GRANT SELECT, INSERT, DELETE ON room_type_rates TO innpilot_app;
GRANT SELECT, INSERT ON room_status_events TO innpilot_app;
