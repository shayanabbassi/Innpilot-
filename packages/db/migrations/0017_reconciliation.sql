-- Phase 4 slice 4.4: bank reconciliation and card settlements (P4-8, P4-2).
-- A reconciliation compares a bank statement with the ledger lines of one bank or card-clearing account: the
-- reviewer ticks the lines that appear on the statement; the difference must be zero to finish, or explained
-- (recorded, never silently adjusted). Ticked lines belong to one reconciliation only and are locked once it is done.

INSERT INTO permissions (code, description)
  VALUES ('bank.reconcile', 'Reconcile bank and card accounts with their statements');
INSERT INTO role_permissions (role_code, permission_code)
  VALUES ('tenant_owner', 'bank.reconcile'), ('accountant', 'bank.reconcile');

CREATE TABLE bank_reconciliations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  property_id             uuid NOT NULL,
  cash_account_id         uuid NOT NULL,
  statement_date          date NOT NULL,
  statement_balance       numeric(19, 4) NOT NULL CHECK (statement_balance = round(statement_balance, 2)),
  status                  text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  -- Fixed when completed: what the ticked lines add up to, and the difference to the statement.
  cleared_balance         numeric(19, 4),
  difference              numeric(19, 4),
  difference_explanation  text CHECK (length(difference_explanation) <= 1000),
  created_by              uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  completed_by            uuid,
  completed_at            timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, cash_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, completed_by) REFERENCES users (tenant_id, id),
  CONSTRAINT reconciliation_completed CHECK (
    (status = 'completed') = (completed_by IS NOT NULL AND completed_at IS NOT NULL
                              AND cleared_balance IS NOT NULL AND difference IS NOT NULL)),
  CONSTRAINT reconciliation_difference CHECK (difference IS NULL OR difference = statement_balance - cleared_balance),
  -- coalesce: a NULL explanation must not make the check unknown.
  CONSTRAINT reconciliation_explained
    CHECK (coalesce(difference, 0) = 0 OR coalesce(length(btrim(difference_explanation)), 0) >= 3)
);
-- One reconciliation in progress per account at a time.
CREATE UNIQUE INDEX bank_reconciliations_open ON bank_reconciliations (cash_account_id) WHERE status = 'in_progress';
CREATE INDEX bank_reconciliations_account_idx ON bank_reconciliations (cash_account_id, statement_date DESC);

-- A completed reconciliation never changes; one in progress may change its statement and be abandoned.
CREATE FUNCTION bank_reconciliations_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'A completed reconciliation cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.property_id, NEW.cash_account_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.property_id, OLD.cash_account_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'A reconciliation cannot move to another account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER bank_reconciliations_guard BEFORE UPDATE OR DELETE ON bank_reconciliations
  FOR EACH ROW EXECUTE FUNCTION bank_reconciliations_guard();

CREATE TABLE reconciliation_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  reconciliation_id  uuid NOT NULL,
  -- A ledger line is reconciled once, ever.
  journal_line_id    uuid NOT NULL UNIQUE,
  FOREIGN KEY (tenant_id, reconciliation_id) REFERENCES bank_reconciliations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (journal_line_id) REFERENCES journal_lines (id)
);
CREATE INDEX reconciliation_items_rec_idx ON reconciliation_items (reconciliation_id);

-- Only posted lines on the reconciliation's own account, dated on or before the statement, can be ticked; ticks of a
-- completed reconciliation are locked.
CREATE FUNCTION reconciliation_items_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM bank_reconciliations
    WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.reconciliation_id ELSE NEW.reconciliation_id END;
  IF r.status = 'completed' THEN
    RAISE EXCEPTION 'Lines of a completed reconciliation cannot change' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Reconciliation items are added or removed, never changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
    WHERE l.id = NEW.journal_line_id AND l.cash_account_id = r.cash_account_id
      AND e.status <> 'draft' AND e.accounting_date <= r.statement_date) THEN
    RAISE EXCEPTION 'Only posted lines of this account up to the statement date can be reconciled'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER reconciliation_items_guard BEFORE INSERT OR UPDATE OR DELETE ON reconciliation_items
  FOR EACH ROW EXECUTE FUNCTION reconciliation_items_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Card settlements: the card company pays the clearing balance into the bank, less its fee (P4-2).
--   Dr bank (net), Dr bank charges (fee), Cr card clearing (gross)
-- ---------------------------------------------------------------------------------------------------------------

CREATE TABLE card_settlements (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL,
  property_id            uuid NOT NULL,
  clearing_account_id    uuid NOT NULL,
  bank_account_id        uuid NOT NULL,
  gross_amount           numeric(19, 4) NOT NULL CHECK (gross_amount > 0 AND gross_amount = round(gross_amount, 2)),
  fee_amount             numeric(19, 4) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0 AND fee_amount = round(fee_amount, 2)),
  business_date          date NOT NULL,
  reference              text CHECK (length(reference) <= 80),
  journal_entry_id       uuid NOT NULL,
  created_by             uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (fee_amount < gross_amount),
  CHECK (clearing_account_id <> bank_account_id),
  FOREIGN KEY (tenant_id, property_id, clearing_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, bank_account_id) REFERENCES cash_accounts (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entries (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX card_settlements_date_idx ON card_settlements (tenant_id, property_id, business_date DESC);
CREATE TRIGGER card_settlements_append_only BEFORE UPDATE OR DELETE ON card_settlements
  FOR EACH ROW EXECUTE FUNCTION reject_modification();

ALTER TABLE bank_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bank_reconciliations
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON reconciliation_items
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY tenant_isolation ON card_settlements
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON bank_reconciliations, reconciliation_items TO innpilot_app;
GRANT SELECT, INSERT ON card_settlements TO innpilot_app;
