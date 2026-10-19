-- 0005_reservations: reservations and their rooms (Phase 2 slice 2.4, decisions P2-1, P2-3 to P2-7).
--
-- Double-booking is prevented in two layers:
--   * an assigned room cannot have two active bookings whose [arrival, departure) ranges overlap — enforced by an
--     exclusion constraint, so it holds even if application code is wrong or two requests race;
--   * bookings by room type (no room yet) are checked against the number of rooms of that type inside a
--     transaction that locks the room-type row (application layer, tested with concurrent requests).
-- Reservation history is the audit log (entity_type 'reservation'); no separate history table.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- New permission: booking at a rate other than the room type rate. Owners and managers only.
INSERT INTO permissions (code, description)
  VALUES ('reservation.rate_override', 'Book at a rate other than the room type rate');
INSERT INTO role_permissions (role_code, permission_code)
  VALUES ('tenant_owner', 'reservation.rate_override'), ('hotel_manager', 'reservation.rate_override');

-- Lets reservation rooms reference (room, room type) together, so a booked room always matches its booked type.
ALTER TABLE rooms ADD CONSTRAINT rooms_id_room_type_key UNIQUE (id, room_type_id);

CREATE TABLE reservations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  property_id       uuid NOT NULL,
  booking_reference text NOT NULL CHECK (booking_reference ~ '^[A-HJKMNP-Z2-9]{8}$'),
  guest_id          uuid NOT NULL,
  source            text NOT NULL CHECK (source IN ('walk_in', 'phone', 'email', 'website', 'agent', 'ota', 'other')),
  status            text NOT NULL CHECK (status IN ('pending', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show')),
  notes             text CHECK (length(notes) <= 2000),
  cancel_reason     text CHECK (length(cancel_reason) <= 500),
  confirmed_at      timestamptz,
  cancelled_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid,
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, guest_id) REFERENCES guests (tenant_id, id),
  UNIQUE (tenant_id, booking_reference),
  UNIQUE (tenant_id, property_id, id),
  CHECK (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL))
);
CREATE INDEX reservations_scope_idx ON reservations (tenant_id, property_id, status);
CREATE INDEX reservations_guest_idx ON reservations (tenant_id, guest_id);

CREATE TABLE reservation_rooms (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  property_id      uuid NOT NULL,
  reservation_id   uuid NOT NULL,
  room_type_id     uuid NOT NULL,
  room_id          uuid,
  arrival          date NOT NULL,
  departure        date NOT NULL,
  adults           integer NOT NULL CHECK (adults BETWEEN 1 AND 20),
  children         integer NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 20),
  -- Agreed rate snapshot: later rate changes never touch existing bookings.
  nightly_rate     numeric(19, 4) NOT NULL CHECK (nightly_rate > 0),
  currency_code    char(3) NOT NULL CHECK (currency_code ~ '^[A-Z]{3}$'),
  rate_overridden  boolean NOT NULL DEFAULT false,
  -- 'released' when the booking is cancelled, a no-show, or the room is removed: it no longer holds inventory.
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservations (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_types (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, room_id) REFERENCES rooms (tenant_id, property_id, id),
  FOREIGN KEY (room_id, room_type_id) REFERENCES rooms (id, room_type_id),
  CHECK (departure > arrival),
  CHECK (departure - arrival <= 60),
  -- The guarantee: one active booking per room per night.
  CONSTRAINT reservation_rooms_no_double_booking EXCLUDE USING gist (
    room_id WITH =,
    daterange(arrival, departure, '[)') WITH &&
  ) WHERE (room_id IS NOT NULL AND status = 'active')
);
CREATE INDEX reservation_rooms_reservation_idx ON reservation_rooms (tenant_id, reservation_id);
CREATE INDEX reservation_rooms_type_dates_idx ON reservation_rooms (tenant_id, room_type_id, arrival, departure)
  WHERE status = 'active';

CREATE TRIGGER reservations_updated_at BEFORE UPDATE ON reservations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER reservation_rooms_updated_at BEFORE UPDATE ON reservation_rooms FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE reservations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reservations
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE reservation_rooms ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON reservation_rooms
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Bookings are never deleted: cancellations and removed rooms are status changes with history.
GRANT SELECT, INSERT, UPDATE ON reservations, reservation_rooms TO innpilot_app;
