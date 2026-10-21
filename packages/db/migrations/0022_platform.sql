-- Phase 5 slice 5.7: platform administration (D16; Phase 0 C6; threat model "support access").
-- Platform operators are a separate identity: their own table, sessions and cookie, never a tenant user. They see
-- tenant metadata (status, plan, counts) and change status and plan with a reason. Anything inside a tenant needs
-- a time-bound, reason-coded support grant, which the tenant sees in its own audit log. No billing provider.

-- ---------------------------------------------------------------------------------------------------------------
-- Tenant plan
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE tenants
  ADD COLUMN plan text NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'growth')),
  -- Room-band pricing (backlog "room-band plan"): the number of rooms the subscription covers.
  ADD COLUMN room_band text NOT NULL DEFAULT 'up_to_20' CHECK (room_band IN ('up_to_20', 'up_to_50', 'up_to_100'));

-- ---------------------------------------------------------------------------------------------------------------
-- Operators and their sessions (not tenant data: no tenant_id, no row-level security)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE platform_operators (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            citext NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  full_name        text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 1 AND 120),
  password_hash    text NOT NULL,
  -- TOTP is required for every operator: there is no sign-in without it.
  mfa_secret_enc   text NOT NULL,
  mfa_last_used_step bigint,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_attempts  integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id         uuid NOT NULL REFERENCES platform_operators (id),
  token_hash          bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
  csrf_token_hash     bytea NOT NULL CHECK (length(csrf_token_hash) = 32),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  ip                  inet,
  user_agent          text CHECK (length(user_agent) <= 500),
  CHECK (idle_expires_at <= absolute_expires_at)
);

-- Everything operators do, append-only. target_tenant_id names the tenant acted on, if any (not tenant data).
CREATE TABLE platform_audit_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id       uuid REFERENCES platform_operators (id),
  action            text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  target_tenant_id  uuid REFERENCES tenants (id),
  changes           jsonb NOT NULL DEFAULT '{}',
  reason            text CHECK (length(reason) <= 1000),
  request_id        text CHECK (length(request_id) <= 100),
  ip                inet,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_events_tenant_idx ON platform_audit_events (target_tenant_id, occurred_at DESC);
CREATE TRIGGER platform_audit_events_append_only BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------------------------------------------
-- Support access grants: tenant data, so they live under the tenant's row-level security
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE tenant_access_grants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  operator_id  uuid NOT NULL REFERENCES platform_operators (id),
  reason       text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  granted_at   timestamptz NOT NULL DEFAULT now(),
  -- Time-bound: four hours at most.
  expires_at   timestamptz NOT NULL CHECK (expires_at > granted_at AND expires_at <= granted_at + interval '4 hours'),
  ended_at     timestamptz CHECK (ended_at IS NULL OR ended_at >= granted_at)
);
CREATE INDEX tenant_access_grants_open_idx ON tenant_access_grants (tenant_id, operator_id, expires_at)
  WHERE ended_at IS NULL;
ALTER TABLE tenant_access_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_access_grants
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Only ending a grant early is allowed; nothing else changes and nothing is deleted.
CREATE FUNCTION tenant_access_grants_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.ended_at IS NOT NULL
     OR (to_jsonb(NEW) - 'ended_at') <> (to_jsonb(OLD) - 'ended_at') THEN
    RAISE EXCEPTION 'A support grant can only be ended' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tenant_access_grants_guard BEFORE UPDATE OR DELETE ON tenant_access_grants
  FOR EACH ROW EXECUTE FUNCTION tenant_access_grants_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Cross-tenant metadata for operators: narrow SECURITY DEFINER functions, like the pre-tenant auth lookups.
-- They return counts and settings only, never guest, staff or financial records.
-- ---------------------------------------------------------------------------------------------------------------

CREATE FUNCTION platform_tenants()
  RETURNS TABLE (
    id            uuid,
    slug          text,
    legal_name    text,
    display_name  text,
    status        text,
    plan          text,
    room_band     text,
    created_at    timestamptz,
    properties    integer,
    rooms         integer,
    users         integer,
    last_sign_in  timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT t.id, t.slug::text, t.legal_name, t.display_name, t.status, t.plan, t.room_band, t.created_at,
           (SELECT count(*) FROM properties p WHERE p.tenant_id = t.id)::int,
           (SELECT count(*) FROM rooms r WHERE r.tenant_id = t.id AND r.active)::int,
           (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.status = 'active')::int,
           (SELECT max(s.created_at) FROM sessions s WHERE s.tenant_id = t.id)
      FROM tenants t
     ORDER BY t.display_name
  $$;

CREATE FUNCTION platform_set_tenant(p_tenant uuid, p_status text, p_plan text, p_room_band text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    UPDATE tenants SET status = p_status, plan = p_plan, room_band = p_room_band, updated_at = now()
     WHERE id = p_tenant
  $$;

REVOKE ALL ON FUNCTION platform_tenants() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform_set_tenant(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_tenants() TO innpilot_app;
GRANT EXECUTE ON FUNCTION platform_set_tenant(uuid, text, text, text) TO innpilot_app;

GRANT SELECT, INSERT, UPDATE ON platform_operators, platform_sessions TO innpilot_app;
GRANT SELECT, INSERT ON platform_audit_events TO innpilot_app;
GRANT SELECT, INSERT, UPDATE ON tenant_access_grants TO innpilot_app;
