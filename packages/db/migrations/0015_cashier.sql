-- Phase 4 slice 4.2: cashier shifts and cash closings (CASH-001, QA scenario B).
-- Shifts are optional (D11). While a shift is open on a cash drawer, every cash line posted on that drawer is linked
-- to it, so expected cash = opening count + the shift's linked movements (P4-4). Closing records the count, the
-- variance and its explanation; above the property's threshold it needs approval by someone else (P4-5).

INSERT INTO permissions (code, description)
  VALUES ('cashier.reopen', 'Reopen a submitted or approved cash closing');
INSERT INTO role_permissions (role_code, permission_code) VALUES ('tenant_owner', 'cashier.reopen');

-- Variance above this needs approval by `cashier.approve` (P4-5, default Rs 500).
ALTER TABLE properties
  ADD COLUMN cash_variance_threshold numeric(19, 4) NOT NULL DEFAULT 500
    CHECK (cash_variance_threshold >= 0 AND cash_variance_threshold = round(cash_variance_threshold, 2));

-- ---------------------------------------------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE cashier_shifts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL,
  property_id           uuid NOT NULL,
  cash_account_id       uuid NOT NULL,
  user_id               uuid NOT NULL,
  business_date         date NOT NULL,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  opening_count         numeric(19, 4) NOT NULL CHECK (opening_count >= 0 AND opening_count = round(opening_count, 2)),
  -- What the ledger said the drawer held when the shift opened; a difference to the count is shown, not hidden.
  book_balance_at_open  numeric(19, 4) NOT NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at             timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, cash_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CHECK ((status = 'open') = (closed_at IS NULL))
);
-- One open shift per drawer and per user.
CREATE UNIQUE INDEX cashier_shifts_open_drawer ON cashier_shifts (cash_account_id) WHERE status = 'open';
CREATE UNIQUE INDEX cashier_shifts_open_user ON cashier_shifts (user_id) WHERE status = 'open';
CREATE INDEX cashier_shifts_date_idx ON cashier_shifts (tenant_id, property_id, business_date DESC);

-- Only the status moves (open ↔ closed, through closing and reopening); the opening facts never change.
CREATE FUNCTION cashier_shifts_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.tenant_id, NEW.property_id, NEW.cash_account_id, NEW.user_id, NEW.business_date, NEW.opened_at,
      NEW.opening_count, NEW.book_balance_at_open)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.property_id, OLD.cash_account_id, OLD.user_id, OLD.business_date, OLD.opened_at,
      OLD.opening_count, OLD.book_balance_at_open) THEN
    RAISE EXCEPTION 'The opening of a cashier shift cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cashier_shifts_guard BEFORE UPDATE ON cashier_shifts
  FOR EACH ROW EXECUTE FUNCTION cashier_shifts_guard();
CREATE TRIGGER cashier_shifts_no_delete BEFORE DELETE ON cashier_shifts
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

-- ---------------------------------------------------------------------------------------------------------------
-- Shift link on cash journal lines
-- ---------------------------------------------------------------------------------------------------------------

ALTER TABLE journal_lines ADD COLUMN cashier_shift_id uuid;
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_shift_fk
  FOREIGN KEY (tenant_id, cashier_shift_id) REFERENCES cashier_shifts (tenant_id, id);
CREATE INDEX journal_lines_shift_idx ON journal_lines (cashier_shift_id) WHERE cashier_shift_id IS NOT NULL;

-- A line joins only an open shift on its own drawer: a closed shift's expected cash can never change afterwards.
CREATE FUNCTION journal_lines_shift_check() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.cashier_shift_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.cashier_shift_id IS DISTINCT FROM OLD.cashier_shift_id)
     AND NOT EXISTS (
       SELECT 1 FROM cashier_shifts s
       WHERE s.id = NEW.cashier_shift_id AND s.status = 'open' AND s.cash_account_id = NEW.cash_account_id) THEN
    RAISE EXCEPTION 'A journal line can only join an open shift on its own cash drawer'
      USING ERRCODE = 'check_violation', HINT = 'SHIFT_NOT_OPEN';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER journal_lines_shift_check BEFORE INSERT OR UPDATE OF cashier_shift_id ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_shift_check();

-- ---------------------------------------------------------------------------------------------------------------
-- Closings
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE cash_closings (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  uuid NOT NULL,
  property_id                uuid NOT NULL,
  shift_id                   uuid NOT NULL,
  cash_account_id            uuid NOT NULL,
  business_date              date NOT NULL,
  expected_amount            numeric(19, 4) NOT NULL,
  counted_amount             numeric(19, 4) NOT NULL CHECK (counted_amount >= 0 AND counted_amount = round(counted_amount, 2)),
  variance                   numeric(19, 4) NOT NULL,
  explanation                text CHECK (length(explanation) <= 1000),
  -- The threshold in force when submitted, and whether the variance went over it.
  threshold                  numeric(19, 4) NOT NULL,
  approval_required          boolean NOT NULL,
  status                     text NOT NULL CHECK (status IN ('submitted', 'approved', 'reopened')),
  submitted_by               uuid NOT NULL,
  submitted_at               timestamptz NOT NULL DEFAULT now(),
  approved_by                uuid,
  approved_at                timestamptz,
  approval_note              text CHECK (length(approval_note) <= 500),
  variance_journal_entry_id  uuid,
  reopened_by                uuid,
  reopened_at                timestamptz,
  reopen_reason              text CHECK (length(reopen_reason) <= 500),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES cashier_shifts (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, cash_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, submitted_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, reopened_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, variance_journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  CHECK (variance = counted_amount - expected_amount),
  -- coalesce: a NULL explanation would otherwise make the check unknown, which Postgres lets through.
  CONSTRAINT cash_closings_explained CHECK (variance = 0 OR coalesce(length(btrim(explanation)), 0) >= 3),
  -- Maker-checker: whoever submits a closing cannot approve it.
  CHECK (approved_by IS NULL OR approved_by <> submitted_by),
  CONSTRAINT cash_closings_reopen_reason
    CHECK (status <> 'reopened' OR (reopened_by IS NOT NULL AND coalesce(length(btrim(reopen_reason)), 0) >= 3))
);
-- At most one live closing per shift; reopened ones stay as history.
CREATE UNIQUE INDEX cash_closings_live ON cash_closings (shift_id) WHERE status <> 'reopened';
CREATE INDEX cash_closings_status_idx ON cash_closings (tenant_id, property_id, status);

-- A submitted closing is locked (P4-5): only approval (submitted → approved) or reopening (→ reopened) may change it,
-- and only their own fields.
CREATE FUNCTION cash_closings_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (NEW.tenant_id, NEW.property_id, NEW.shift_id, NEW.cash_account_id, NEW.business_date, NEW.expected_amount,
      NEW.counted_amount, NEW.variance, NEW.explanation, NEW.threshold, NEW.approval_required, NEW.submitted_by,
      NEW.submitted_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.property_id, OLD.shift_id, OLD.cash_account_id, OLD.business_date, OLD.expected_amount,
      OLD.counted_amount, OLD.variance, OLD.explanation, OLD.threshold, OLD.approval_required, OLD.submitted_by,
      OLD.submitted_at) THEN
    RAISE EXCEPTION 'A submitted cash closing cannot be changed' USING ERRCODE = 'insufficient_privilege',
      HINT = 'CASH_CLOSING_ALREADY_SUBMITTED';
  END IF;
  IF OLD.status = 'reopened'
     OR (NEW.status = 'approved' AND OLD.status <> 'submitted')
     OR (NEW.status = 'submitted' AND OLD.status <> 'submitted')
     OR (OLD.status = 'approved' AND NEW.status = 'approved'
         AND (NEW.approved_by, NEW.approved_at, NEW.variance_journal_entry_id)
             IS DISTINCT FROM (OLD.approved_by, OLD.approved_at, OLD.variance_journal_entry_id)) THEN
    RAISE EXCEPTION 'Cash closing cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege', HINT = 'CASH_CLOSING_ALREADY_SUBMITTED';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cash_closings_guard BEFORE UPDATE ON cash_closings
  FOR EACH ROW EXECUTE FUNCTION cash_closings_guard();
CREATE TRIGGER cash_closings_no_delete BEFORE DELETE ON cash_closings
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

ALTER TABLE cashier_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_closings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cashier_shifts
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON cash_closings
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON cashier_shifts, cash_closings TO innpilot_app;
