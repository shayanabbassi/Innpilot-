-- 0006_stays: in-house stays and their room segments (Phase 2 slice 2.5, decisions P2-10, P2-11, P2-13).
--
-- Occupancy is derived from open stay segments; the database guarantees:
--   * a booked room can be checked in only once (reservation_rooms.stay_id set under a row lock, and a stay has
--     at most one open segment);
--   * a room holds at most one in-house guest at a time (one open segment per room).

INSERT INTO permissions (code, description)
  VALUES ('stay.readiness_override', 'Check in or move a guest into a room that is not ready');
INSERT INTO role_permissions (role_code, permission_code)
  VALUES ('tenant_owner', 'stay.readiness_override'), ('hotel_manager', 'stay.readiness_override');

CREATE TABLE stays (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  property_id    uuid NOT NULL,
  reservation_id uuid NOT NULL,
  guest_id       uuid NOT NULL,
  status         text NOT NULL DEFAULT 'in_house' CHECK (status IN ('in_house', 'checked_out')),
  checked_in_at  timestamptz NOT NULL DEFAULT now(),
  checked_in_by  uuid,
  checked_out_at timestamptz,
  checked_out_by uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservations (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, guest_id) REFERENCES guests (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  CHECK ((status = 'checked_out') = (checked_out_at IS NOT NULL))
);
CREATE INDEX stays_in_house_idx ON stays (tenant_id, property_id) WHERE status = 'in_house';

-- Which room the guest was in, and when. A move ends one segment and starts the next.
CREATE TABLE stay_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  property_id uuid NOT NULL,
  stay_id     uuid NOT NULL,
  room_id     uuid NOT NULL,
  from_date   date NOT NULL,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  reason      text CHECK (length(reason) <= 300),
  FOREIGN KEY (tenant_id, property_id, stay_id) REFERENCES stays (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, room_id) REFERENCES rooms (tenant_id, property_id, id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX stay_rooms_one_open_per_stay ON stay_rooms (stay_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX stay_rooms_one_guest_per_room ON stay_rooms (room_id) WHERE ended_at IS NULL;
CREATE INDEX stay_rooms_stay_idx ON stay_rooms (tenant_id, stay_id);

-- Links each booked room to the stay that uses it; set once at check-in (a move's split segment inherits it).
ALTER TABLE reservation_rooms ADD COLUMN stay_id uuid;
ALTER TABLE reservation_rooms ADD CONSTRAINT reservation_rooms_stay_fk
  FOREIGN KEY (tenant_id, property_id, stay_id) REFERENCES stays (tenant_id, property_id, id);

CREATE TRIGGER stays_updated_at BEFORE UPDATE ON stays FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE stays ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stays
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE stay_rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stay_rooms
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON stays, stay_rooms TO innpilot_app;
