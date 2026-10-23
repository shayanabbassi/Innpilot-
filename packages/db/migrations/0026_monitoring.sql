-- Slice 6.6: what monitoring needs to read, without widening what the application role can see.

-- One row per backup attempt (6.5's backup command writes it as the database owner). No tenant data: the API reads
-- it for the backup-age and backup-failure alerts.
CREATE TABLE backup_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  ok           boolean NOT NULL,
  object_key   text CHECK (length(object_key) <= 200),
  bytes        bigint CHECK (bytes >= 0),
  duration_ms  integer NOT NULL CHECK (duration_ms >= 0),
  -- A short reason, never a connection string or credentials (the backup command strips them).
  error        text CHECK (length(error) <= 500),
  CHECK (ok = (error IS NULL))
);
CREATE INDEX backup_runs_finished_idx ON backup_runs (finished_at DESC);
GRANT SELECT ON backup_runs TO innpilot_app;

-- Readiness compares the applied migrations with the ones the running release ships. Names only, through a narrow
-- function: the application role keeps no access to the migration bookkeeping itself.
CREATE FUNCTION ops_applied_migrations()
  RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$ SELECT name FROM schema_migrations ORDER BY name $$;
REVOKE ALL ON FUNCTION ops_applied_migrations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_applied_migrations() TO innpilot_app;

-- Queue health across tenants, as counts only (the jobs table itself stays tenant-scoped).
CREATE FUNCTION ops_job_stats()
  RETURNS TABLE (queued integer, running integer, failed_24h integer, oldest_queued_seconds double precision)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT count(*) FILTER (WHERE status = 'queued' AND run_after <= now())::int,
           count(*) FILTER (WHERE status = 'running')::int,
           count(*) FILTER (WHERE status = 'failed' AND finished_at > now() - interval '24 hours')::int,
           coalesce(extract(epoch FROM now() - min(run_after) FILTER (WHERE status = 'queued' AND run_after <= now())), 0)::double precision
    FROM jobs;
  $$;
REVOKE ALL ON FUNCTION ops_job_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_job_stats() TO innpilot_app;
