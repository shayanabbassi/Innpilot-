-- 0028_owner_self_approval: the hotel's owner needs no second person's approval. The owner asked that expenses and
-- cashier closings they record are final at once, and that they may approve their own waiting items.
-- Maker-checker still holds for everyone else: the CHECK constraints become triggers that allow approver = maker
-- only when the approver is the tenant's owner (a tenant-wide tenant_owner role).

CREATE FUNCTION is_tenant_owner(p_tenant_id uuid, p_user_id uuid) RETURNS boolean
  LANGUAGE sql STABLE
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM user_roles
       WHERE tenant_id = p_tenant_id AND user_id = p_user_id
         AND role_code = 'tenant_owner' AND property_id IS NULL
    )
  $$;

ALTER TABLE expense_vouchers DROP CONSTRAINT expense_maker_checker;

CREATE FUNCTION expense_vouchers_maker_checker() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL
     AND (NEW.approved_by = NEW.created_by OR NEW.approved_by IS NOT DISTINCT FROM NEW.submitted_by)
     AND NOT is_tenant_owner(NEW.tenant_id, NEW.approved_by) THEN
    RAISE EXCEPTION 'Whoever records an expense cannot approve it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER expense_vouchers_maker_checker
  BEFORE INSERT OR UPDATE ON expense_vouchers
  FOR EACH ROW EXECUTE FUNCTION expense_vouchers_maker_checker();

ALTER TABLE cash_closings DROP CONSTRAINT cash_closings_check1;

CREATE FUNCTION cash_closings_maker_checker() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.approved_by IS NOT NULL AND NEW.approved_by = NEW.submitted_by
     AND NOT is_tenant_owner(NEW.tenant_id, NEW.approved_by) THEN
    RAISE EXCEPTION 'Whoever submits a cash closing cannot approve it' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cash_closings_maker_checker
  BEFORE INSERT OR UPDATE ON cash_closings
  FOR EACH ROW EXECUTE FUNCTION cash_closings_maker_checker();
