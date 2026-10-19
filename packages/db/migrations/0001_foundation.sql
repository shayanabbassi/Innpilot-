-- 0001_foundation: tenants, properties, users, roles/permissions, sessions, audit events, idempotency keys.
--
-- Isolation model (ADR-0001):
--   * The API connects as `innpilot_app`, which owns nothing and has no BYPASSRLS.
--   * Every tenant-owned table has row-level security keyed on the per-transaction setting app.tenant_id.
--   * Child rows reference parents through composite (tenant_id, id) foreign keys, so a row can never point at
--     another tenant's record even if application code is wrong.
--   * Login and session lookup happen before the tenant is known; they go through two narrow SECURITY DEFINER
--     functions instead of exposing the tables.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'innpilot_app') THEN
    RAISE EXCEPTION 'Role innpilot_app does not exist. Run "pnpm db:provision" before migrating.';
  END IF;
END
$$;

CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------------------

CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE FUNCTION reject_modification() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: records are append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  legal_name    text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 200),
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status        text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'suspended', 'closed')),
  base_currency char(3) NOT NULL DEFAULT 'PKR' CHECK (base_currency ~ '^[A-Z]{3}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE properties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants (id),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  legal_name     text CHECK (length(legal_name) <= 200),
  timezone       text NOT NULL DEFAULT 'Asia/Karachi',
  currency_code  char(3) NOT NULL DEFAULT 'PKR' CHECK (currency_code ~ '^[A-Z]{3}$'),
  address_line   text CHECK (length(address_line) <= 300),
  city           text CHECK (length(city) <= 100),
  country_code   char(2) NOT NULL DEFAULT 'PK' CHECK (country_code ~ '^[A-Z]{2}$'),
  phone          text CHECK (length(phone) <= 40),
  email          citext CHECK (length(email) <= 254),
  check_in_time  time NOT NULL DEFAULT '14:00',
  check_out_time time NOT NULL DEFAULT '12:00',
  -- The hotel's operating date. Advanced only by the daily close (night audit), never by the wall clock.
  business_date  date NOT NULL,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX properties_tenant_idx ON properties (tenant_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Identity and access
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  -- One user belongs to one tenant; email is globally unique so login is unambiguous (ADR-0001).
  email               citext NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  full_name           text NOT NULL CHECK (length(full_name) BETWEEN 1 AND 200),
  password_hash       text NOT NULL,
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- TOTP secret encrypted by the application (AES-256-GCM); never stored in plain text.
  mfa_secret_enc      text,
  mfa_enabled_at      timestamptz,
  -- Last accepted TOTP time step; codes at or before it are rejected so a code cannot be replayed.
  mfa_last_used_step  bigint,
  failed_login_count  integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until        timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  UNIQUE (tenant_id, id),
  CHECK (mfa_enabled_at IS NULL OR mfa_secret_enc IS NOT NULL)
);
CREATE INDEX users_tenant_idx ON users (tenant_id);

-- System-defined catalogue: readable by everyone, writable only by migrations.
CREATE TABLE permissions (
  code        text PRIMARY KEY CHECK (code ~ '^[a-z_]+(\.[a-z_]+)+$'),
  description text NOT NULL
);

CREATE TABLE roles (
  code         text PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
  name         text NOT NULL,
  description  text NOT NULL,
  mfa_required boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL
);

CREATE TABLE role_permissions (
  role_code       text NOT NULL REFERENCES roles (code),
  permission_code text NOT NULL REFERENCES permissions (code),
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE user_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  -- NULL means the role applies to every property in the tenant.
  property_id uuid,
  role_code   text NOT NULL REFERENCES roles (code),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  UNIQUE NULLS NOT DISTINCT (user_id, role_code, property_id)
);
CREATE INDEX user_roles_tenant_user_idx ON user_roles (tenant_id, user_id);

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  user_id             uuid NOT NULL,
  -- SHA-256 of the random session token. The token itself only exists in the user's cookie.
  token_hash          bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  csrf_token_hash     bytea NOT NULL CHECK (length(csrf_token_hash) = 32),
  mfa_verified_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  revoked_reason      text,
  ip                  inet,
  user_agent          text CHECK (length(user_agent) <= 500),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX sessions_active_user_idx ON sessions (tenant_id, user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE audit_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  property_id   uuid,
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'system', 'platform')),
  actor_user_id uuid,
  action        text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type   text NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 60),
  entity_id     uuid,
  -- Redacted before/after summary. Never contains passwords, tokens, MFA secrets or full identity numbers.
  changes       jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason        text CHECK (length(reason) <= 1000),
  request_id    text CHECK (length(request_id) <= 100),
  ip            inet,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, property_id) REFERENCES properties (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CHECK (actor_type <> 'user' OR actor_user_id IS NOT NULL)
);
CREATE INDEX audit_events_tenant_time_idx ON audit_events (tenant_id, occurred_at DESC, id DESC);
CREATE INDEX audit_events_entity_idx ON audit_events (tenant_id, entity_type, entity_id);

CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_modification();
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------------------------------------------
-- Idempotency (payments, refunds, postings, night audit and other retry-sensitive commands)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE idempotency_keys (
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  -- The command the key belongs to, e.g. 'POST /payments'. The same key may be reused for a different command.
  scope           text NOT NULL CHECK (length(scope) BETWEEN 1 AND 200),
  key             text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  actor_user_id   uuid NOT NULL,
  -- SHA-256 of the canonical request body; a reused key with a different body is rejected.
  request_hash    text NOT NULL CHECK (length(request_hash) = 64),
  status          text NOT NULL CHECK (status IN ('in_progress', 'completed')),
  response_status integer,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, scope, key),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CHECK (status = 'in_progress' OR (response_status IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------------------------------------------

CREATE TRIGGER tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER properties_updated_at BEFORE UPDATE ON properties FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- Role and permission catalogue (generated from packages/contracts/src/rbac.ts; a test asserts they match)
-- ---------------------------------------------------------------------------------------------------------------

INSERT INTO permissions (code, description) VALUES
  ('property.read', 'View property profile and settings'),
  ('property.manage', 'Change property profile and settings'),
  ('user.read', 'View staff accounts and role assignments'),
  ('user.manage', 'Create staff accounts, assign roles, disable accounts'),
  ('audit.read', 'View the audit log'),
  ('room.read', 'View rooms, room types and the room board'),
  ('room.manage', 'Create and change rooms, room types and rates'),
  ('reservation.read', 'View reservations'),
  ('reservation.write', 'Create, change and cancel reservations'),
  ('guest.read', 'View guest profiles and stay history'),
  ('guest.write', 'Create and change guest profiles'),
  ('guest.identity.read', 'View guest identity document details'),
  ('stay.checkin', 'Check guests in'),
  ('stay.checkout', 'Check guests out'),
  ('housekeeping.read', 'View housekeeping tasks and room status'),
  ('housekeeping.write', 'Update cleaning, inspection and maintenance status'),
  ('folio.read', 'View guest folios'),
  ('folio.charge', 'Post charges to folios'),
  ('folio.adjust', 'Post adjustments, transfers and write-offs on folios'),
  ('payment.receive', 'Record payments and deposits'),
  ('payment.refund', 'Issue refunds'),
  ('cashier.operate', 'Open and close own cashier session'),
  ('cashier.approve', 'Approve cashier variances'),
  ('journal.read', 'View chart of accounts and journals'),
  ('journal.post', 'Post manual journal entries'),
  ('journal.reverse', 'Reverse posted journal entries'),
  ('period.close', 'Close accounting periods'),
  ('period.reopen', 'Reopen closed accounting periods'),
  ('expense.write', 'Record expenses and supplier bills'),
  ('expense.approve', 'Approve expenses and supplier bills'),
  ('expense.pay', 'Pay approved expenses and supplier bills'),
  ('tax.configure', 'Configure tax codes and invoice settings'),
  ('night_audit.run', 'Run the daily close and advance the business date'),
  ('report.operational', 'View operational reports'),
  ('report.financial', 'View financial reports and statements'),
  ('export.run', 'Export reports and data');

INSERT INTO roles (code, name, description, mfa_required, sort_order) VALUES
  ('tenant_owner', 'Owner', 'Full control of the hotel account, finance and staff.', true, 1),
  ('hotel_manager', 'General manager', 'Runs daily operations, approves exceptions and manages staff.', true, 2),
  ('accountant', 'Accountant', 'Manages the ledger, expenses, periods and financial reports.', true, 3),
  ('cashier', 'Cashier', 'Takes payments, runs a cashier session and records cash expenses.', false, 4),
  ('front_desk', 'Front desk', 'Handles reservations, check-in, check-out and guest charges.', false, 5),
  ('housekeeping', 'Housekeeping', 'Sees assigned rooms and updates cleaning and maintenance status.', false, 6),
  ('read_only_auditor', 'Auditor (read only)', 'Reads records and reports; cannot change anything.', false, 7);

INSERT INTO role_permissions (role_code, permission_code) VALUES
  ('tenant_owner', 'property.read'),
  ('tenant_owner', 'property.manage'),
  ('tenant_owner', 'user.read'),
  ('tenant_owner', 'user.manage'),
  ('tenant_owner', 'audit.read'),
  ('tenant_owner', 'room.read'),
  ('tenant_owner', 'room.manage'),
  ('tenant_owner', 'reservation.read'),
  ('tenant_owner', 'reservation.write'),
  ('tenant_owner', 'guest.read'),
  ('tenant_owner', 'guest.write'),
  ('tenant_owner', 'guest.identity.read'),
  ('tenant_owner', 'stay.checkin'),
  ('tenant_owner', 'stay.checkout'),
  ('tenant_owner', 'housekeeping.read'),
  ('tenant_owner', 'housekeeping.write'),
  ('tenant_owner', 'folio.read'),
  ('tenant_owner', 'folio.charge'),
  ('tenant_owner', 'folio.adjust'),
  ('tenant_owner', 'payment.receive'),
  ('tenant_owner', 'payment.refund'),
  ('tenant_owner', 'cashier.operate'),
  ('tenant_owner', 'cashier.approve'),
  ('tenant_owner', 'journal.read'),
  ('tenant_owner', 'journal.post'),
  ('tenant_owner', 'journal.reverse'),
  ('tenant_owner', 'period.close'),
  ('tenant_owner', 'period.reopen'),
  ('tenant_owner', 'expense.write'),
  ('tenant_owner', 'expense.approve'),
  ('tenant_owner', 'expense.pay'),
  ('tenant_owner', 'tax.configure'),
  ('tenant_owner', 'night_audit.run'),
  ('tenant_owner', 'report.operational'),
  ('tenant_owner', 'report.financial'),
  ('tenant_owner', 'export.run'),
  ('hotel_manager', 'property.read'),
  ('hotel_manager', 'property.manage'),
  ('hotel_manager', 'user.read'),
  ('hotel_manager', 'user.manage'),
  ('hotel_manager', 'audit.read'),
  ('hotel_manager', 'room.read'),
  ('hotel_manager', 'room.manage'),
  ('hotel_manager', 'reservation.read'),
  ('hotel_manager', 'reservation.write'),
  ('hotel_manager', 'guest.read'),
  ('hotel_manager', 'guest.write'),
  ('hotel_manager', 'guest.identity.read'),
  ('hotel_manager', 'stay.checkin'),
  ('hotel_manager', 'stay.checkout'),
  ('hotel_manager', 'housekeeping.read'),
  ('hotel_manager', 'housekeeping.write'),
  ('hotel_manager', 'folio.read'),
  ('hotel_manager', 'folio.charge'),
  ('hotel_manager', 'folio.adjust'),
  ('hotel_manager', 'payment.receive'),
  ('hotel_manager', 'payment.refund'),
  ('hotel_manager', 'cashier.operate'),
  ('hotel_manager', 'cashier.approve'),
  ('hotel_manager', 'journal.read'),
  ('hotel_manager', 'expense.write'),
  ('hotel_manager', 'expense.approve'),
  ('hotel_manager', 'expense.pay'),
  ('hotel_manager', 'night_audit.run'),
  ('hotel_manager', 'report.operational'),
  ('hotel_manager', 'report.financial'),
  ('hotel_manager', 'export.run'),
  ('accountant', 'property.read'),
  ('accountant', 'user.read'),
  ('accountant', 'audit.read'),
  ('accountant', 'room.read'),
  ('accountant', 'reservation.read'),
  ('accountant', 'guest.read'),
  ('accountant', 'housekeeping.read'),
  ('accountant', 'folio.read'),
  ('accountant', 'journal.read'),
  ('accountant', 'journal.post'),
  ('accountant', 'journal.reverse'),
  ('accountant', 'period.close'),
  ('accountant', 'period.reopen'),
  ('accountant', 'expense.write'),
  ('accountant', 'expense.approve'),
  ('accountant', 'expense.pay'),
  ('accountant', 'cashier.approve'),
  ('accountant', 'tax.configure'),
  ('accountant', 'report.operational'),
  ('accountant', 'report.financial'),
  ('accountant', 'export.run'),
  ('cashier', 'property.read'),
  ('cashier', 'room.read'),
  ('cashier', 'reservation.read'),
  ('cashier', 'guest.read'),
  ('cashier', 'folio.read'),
  ('cashier', 'folio.charge'),
  ('cashier', 'payment.receive'),
  ('cashier', 'cashier.operate'),
  ('cashier', 'expense.write'),
  ('cashier', 'report.operational'),
  ('front_desk', 'property.read'),
  ('front_desk', 'room.read'),
  ('front_desk', 'reservation.read'),
  ('front_desk', 'reservation.write'),
  ('front_desk', 'guest.read'),
  ('front_desk', 'guest.write'),
  ('front_desk', 'guest.identity.read'),
  ('front_desk', 'stay.checkin'),
  ('front_desk', 'stay.checkout'),
  ('front_desk', 'housekeeping.read'),
  ('front_desk', 'folio.read'),
  ('front_desk', 'folio.charge'),
  ('front_desk', 'payment.receive'),
  ('front_desk', 'cashier.operate'),
  ('front_desk', 'report.operational'),
  ('housekeeping', 'property.read'),
  ('housekeeping', 'room.read'),
  ('housekeeping', 'housekeeping.read'),
  ('housekeeping', 'housekeeping.write'),
  ('read_only_auditor', 'property.read'),
  ('read_only_auditor', 'user.read'),
  ('read_only_auditor', 'audit.read'),
  ('read_only_auditor', 'room.read'),
  ('read_only_auditor', 'reservation.read'),
  ('read_only_auditor', 'guest.read'),
  ('read_only_auditor', 'housekeeping.read'),
  ('read_only_auditor', 'folio.read'),
  ('read_only_auditor', 'journal.read'),
  ('read_only_auditor', 'report.operational'),
  ('read_only_auditor', 'report.financial');

-- ---------------------------------------------------------------------------------------------------------------
-- Row-level security. With app.tenant_id unset, app_current_tenant() is NULL and every policy matches nothing.
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON properties
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_roles
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON idempotency_keys
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ---------------------------------------------------------------------------------------------------------------
-- Pre-tenant lookups. These run as the migration owner (bypassing RLS) and return only what the login and
-- session-resolution steps need. Everything after them runs with app.tenant_id set.
-- ---------------------------------------------------------------------------------------------------------------

CREATE FUNCTION auth_find_login(p_email citext)
  RETURNS TABLE (
    user_id       uuid,
    tenant_id     uuid,
    password_hash text,
    user_status   text,
    tenant_status text,
    locked_until  timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT u.id, u.tenant_id, u.password_hash, u.status, t.status, u.locked_until
      FROM users u
      JOIN tenants t ON t.id = u.tenant_id
     WHERE u.email = p_email
  $$;

CREATE FUNCTION auth_resolve_session(p_token_hash bytea)
  RETURNS TABLE (session_id uuid, tenant_id uuid, user_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT s.id, s.tenant_id, s.user_id
      FROM sessions s
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.idle_expires_at > now()
       AND s.absolute_expires_at > now()
  $$;

REVOKE ALL ON FUNCTION auth_find_login(citext) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_resolve_session(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_login(citext) TO innpilot_app;
GRANT EXECUTE ON FUNCTION auth_resolve_session(bytea) TO innpilot_app;

-- ---------------------------------------------------------------------------------------------------------------
-- Grants for the application role (least privilege; no DELETE on anything financial or audited)
-- ---------------------------------------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO innpilot_app;
GRANT SELECT ON permissions, roles, role_permissions TO innpilot_app;
GRANT SELECT ON tenants TO innpilot_app;
GRANT SELECT, INSERT, UPDATE ON properties, users, sessions TO innpilot_app;
GRANT SELECT, INSERT, DELETE ON user_roles TO innpilot_app;
GRANT SELECT, INSERT ON audit_events TO innpilot_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON idempotency_keys TO innpilot_app;
