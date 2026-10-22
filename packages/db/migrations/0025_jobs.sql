-- Slice 6.3: background jobs (P6-4) and exports prepared in the background.
-- A Postgres-backed queue, no Redis. Every job carries the tenant it was created in, taken from the verified
-- session; the worker runs it inside that tenant's row-level security, as the person who asked.

CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  kind          text NOT NULL CHECK (kind IN ('report_export')),
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  attempts      integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  -- Not before this time (retries wait); a running job's lease ends at locked_until.
  run_after     timestamptz NOT NULL DEFAULT now(),
  locked_until  timestamptz,
  -- A message safe to show the person who asked; never a stack trace or a database error.
  last_error    text CHECK (length(last_error) <= 500),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
  CHECK (status <> 'running' OR locked_until IS NOT NULL),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX jobs_due_idx ON jobs (run_after) WHERE status IN ('queued', 'running');
CREATE INDEX jobs_creator_idx ON jobs (tenant_id, created_by, created_at DESC);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON jobs
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON jobs TO innpilot_app;

-- The file a background export produced. One per job, so a retried job replaces its own file and never adds a
-- second. Only the person who asked can download it, and it expires.
CREATE TABLE export_files (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  job_id        uuid NOT NULL UNIQUE,
  user_id       uuid NOT NULL,
  property_id   uuid,
  report        text NOT NULL,
  format        text NOT NULL CHECK (format IN ('csv', 'xlsx')),
  file_name     text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  object_key    text NOT NULL UNIQUE CHECK (object_key ~ '^t/[0-9a-f-]{36}/exports/[0-9a-f-]{36}$'),
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  row_count     integer NOT NULL CHECK (row_count >= 0),
  sha256        bytea NOT NULL CHECK (length(sha256) = 32),
  enc_iv        bytea NOT NULL CHECK (length(enc_iv) = 12),
  enc_tag       bytea NOT NULL CHECK (length(enc_tag) = 16),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  removed_at    timestamptz,
  CHECK (expires_at > created_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX export_files_expiry_idx ON export_files (expires_at) WHERE removed_at IS NULL;

ALTER TABLE export_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON export_files
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON export_files TO innpilot_app;

-- ---------------------------------------------------------------------------------------------------------------
-- The worker's only cross-tenant reach: narrow SECURITY DEFINER functions that hand out the next job (with its
-- tenant) or the next expired files. Everything the job then reads or writes goes through the tenant's own scope.
-- ---------------------------------------------------------------------------------------------------------------

-- Claims the next due job: queued and due, or running with a lapsed lease (its worker stopped). SKIP LOCKED lets
-- several API instances share the queue without taking the same job. A lapsed job with no attempts left is failed.
CREATE FUNCTION job_claim(p_lease_seconds integer)
  RETURNS TABLE (id uuid, tenant_id uuid, kind text, payload jsonb, attempts integer, max_attempts integer,
                 created_by uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  UPDATE jobs j
     SET status = 'failed', finished_at = now(), locked_until = NULL,
         last_error = 'The job stopped before finishing and has no tries left.'
   WHERE j.status = 'running' AND j.locked_until < now() AND j.attempts >= j.max_attempts;

  RETURN QUERY
  UPDATE jobs j
     SET status = 'running',
         attempts = j.attempts + 1,
         locked_until = now() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(j.started_at, now())
   WHERE j.id = (
     SELECT n.id FROM jobs n
      WHERE (n.status = 'queued' AND n.run_after <= now())
         OR (n.status = 'running' AND n.locked_until < now())
      ORDER BY n.run_after
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
  RETURNING j.id, j.tenant_id, j.kind, j.payload, j.attempts, j.max_attempts, j.created_by;
END;
$$;

-- Prepared exports past their expiry, for the clean-up job. Ids and keys only.
CREATE FUNCTION export_files_expired(p_limit integer)
  RETURNS TABLE (id uuid, tenant_id uuid, object_key text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT f.id, f.tenant_id, f.object_key FROM export_files f
     WHERE f.removed_at IS NULL AND f.expires_at < now()
     ORDER BY f.expires_at
     LIMIT p_limit;
  $$;

REVOKE ALL ON FUNCTION job_claim(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION export_files_expired(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION job_claim(integer) TO innpilot_app;
GRANT EXECUTE ON FUNCTION export_files_expired(integer) TO innpilot_app;
