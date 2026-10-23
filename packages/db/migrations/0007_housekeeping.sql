-- 0007_housekeeping: cleaning/inspection tasks and maintenance tickets with dated out-of-order periods
-- (Phase 2 slice 2.6, decision P2-14).
--
-- Out-of-order periods are dated so inventory can be correct for future nights: a room in an active period does
-- not count as sellable on those nights. rooms.service_state reflects the period covering the business date.

INSERT INTO permissions (code, description)
  VALUES ('room.out_of_order', 'Take rooms out of order and return them to service');
INSERT INTO role_permissions (role_code, permission_code)
  VALUES ('tenant_owner', 'room.out_of_order'), ('hotel_manager', 'room.out_of_order');

CREATE TABLE housekeeping_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  property_id      uuid NOT NULL,
  room_id          uuid NOT NULL,
  task_type        text NOT NULL CHECK (task_type IN ('clean', 'inspect')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'cancelled')),
  source           text NOT NULL CHECK (source IN ('manual', 'room_dirty', 'inspection_failed')),
  assigned_user_id uuid,
  notes            text CHECK (length(notes) <= 500),
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  completed_by     uuid,
  FOREIGN KEY (tenant_id, property_id, room_id) REFERENCES rooms (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, assigned_user_id) REFERENCES users (tenant_id, id),
  CHECK ((status IN ('done', 'cancelled')) = (completed_at IS NOT NULL))
);
-- At most one open task of each type per room: a room that becomes dirty twice still has one cleaning task.
CREATE UNIQUE INDEX housekeeping_tasks_one_open ON housekeeping_tasks (room_id, task_type)
  WHERE status IN ('open', 'in_progress');
CREATE INDEX housekeeping_tasks_queue_idx ON housekeeping_tasks (tenant_id, property_id, status);

CREATE TABLE maintenance_tickets (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  property_id        uuid NOT NULL,
  room_id            uuid,
  category           text NOT NULL CHECK (category IN ('plumbing', 'electrical', 'hvac', 'furniture', 'appliance', 'cleaning', 'other')),
  priority           text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'cancelled')),
  description        text NOT NULL CHECK (length(description) BETWEEN 3 AND 1000),
  -- Out-of-order period [from, to); to NULL = until the ticket is resolved.
  out_of_order_from  date,
  out_of_order_to    date,
  reported_by        uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution_note    text CHECK (length(resolution_note) <= 1000),
  -- Bookings unassigned when the room was taken out of order (for follow-up by the front desk).
  unassigned_reservations jsonb NOT NULL DEFAULT '[]'::jsonb,
  FOREIGN KEY (tenant_id, property_id, room_id) REFERENCES rooms (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, reported_by) REFERENCES users (tenant_id, id),
  CHECK (out_of_order_from IS NULL OR room_id IS NOT NULL),
  CHECK (out_of_order_to IS NULL OR (out_of_order_from IS NOT NULL AND out_of_order_to > out_of_order_from)),
  CHECK ((status IN ('resolved', 'cancelled')) = (resolved_at IS NOT NULL))
);
CREATE INDEX maintenance_tickets_queue_idx ON maintenance_tickets (tenant_id, property_id, status);
CREATE INDEX maintenance_tickets_ooo_idx ON maintenance_tickets (room_id, out_of_order_from)
  WHERE out_of_order_from IS NOT NULL AND status IN ('open', 'in_progress');

ALTER TABLE housekeeping_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON housekeeping_tasks
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE maintenance_tickets ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON maintenance_tickets
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON housekeeping_tasks, maintenance_tickets TO innpilot_app;
