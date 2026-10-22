-- Slice 6.2: files kept in private object storage (SEC-003, D12 receipts, guest identity scans).
-- The database keeps what is needed to find, check and decrypt a file; the file itself lives in the bucket,
-- encrypted by the API (AES-256-GCM) under a key that carries the tenant and property but nothing about the
-- guest or the file's name.

CREATE TABLE attachments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  -- The expense's property; NULL for guest scans (guests are shared by the tenant's properties).
  property_id   uuid,
  owner_type    text NOT NULL CHECK (owner_type IN ('expense', 'guest')),
  expense_id    uuid,
  guest_id      uuid,
  object_key    text NOT NULL UNIQUE CHECK (object_key ~ '^t/[0-9a-f-]{36}/(p/[0-9a-f-]{36}|shared)/[0-9a-f-]{36}$'),
  file_name     text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 120),
  content_type  text NOT NULL CHECK (content_type IN ('application/pdf', 'image/jpeg', 'image/png')),
  size_bytes    integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  -- Of the plain file: spots an upload sent twice, and proves a download is the file that was stored.
  sha256        bytea NOT NULL CHECK (length(sha256) = 32),
  enc_iv        bytea NOT NULL CHECK (length(enc_iv) = 12),
  enc_tag       bytea NOT NULL CHECK (length(enc_tag) = 16),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  removed_at    timestamptz,
  removed_by    uuid,
  CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  CHECK (
    (owner_type = 'expense' AND expense_id IS NOT NULL AND guest_id IS NULL AND property_id IS NOT NULL)
    OR (owner_type = 'guest' AND guest_id IS NOT NULL AND expense_id IS NULL AND property_id IS NULL)
  ),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, expense_id) REFERENCES expense_vouchers (tenant_id, id),
  FOREIGN KEY (tenant_id, guest_id) REFERENCES guests (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, removed_by) REFERENCES users (tenant_id, id)
);

CREATE INDEX attachments_expense_idx ON attachments (tenant_id, expense_id) WHERE expense_id IS NOT NULL;
CREATE INDEX attachments_guest_idx ON attachments (tenant_id, guest_id) WHERE guest_id IS NOT NULL;
-- The same file attached twice to the same record is one attachment (a retried upload is harmless).
CREATE UNIQUE INDEX attachments_expense_once ON attachments (tenant_id, expense_id, sha256)
  WHERE expense_id IS NOT NULL AND removed_at IS NULL;
CREATE UNIQUE INDEX attachments_guest_once ON attachments (tenant_id, guest_id, sha256)
  WHERE guest_id IS NOT NULL AND removed_at IS NULL;

-- A stored attachment never changes; the only update is marking it removed, once.
CREATE FUNCTION attachments_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'attachment % is already removed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.property_id, NEW.owner_type, NEW.expense_id, NEW.guest_id, NEW.object_key,
      NEW.file_name, NEW.content_type, NEW.size_bytes, NEW.sha256, NEW.enc_iv, NEW.enc_tag, NEW.created_by,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.property_id, OLD.owner_type, OLD.expense_id, OLD.guest_id, OLD.object_key,
      OLD.file_name, OLD.content_type, OLD.size_bytes, OLD.sha256, OLD.enc_iv, OLD.enc_tag, OLD.created_by,
      OLD.created_at) THEN
    RAISE EXCEPTION 'attachments are not edited, only removed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attachments_guard BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION attachments_guard();

ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attachments
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- No DELETE: a removed attachment keeps its row (who removed what, when) even after its file is gone.
GRANT SELECT, INSERT, UPDATE ON attachments TO innpilot_app;
