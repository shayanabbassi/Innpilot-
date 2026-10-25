-- Phase 5 slice 5.1: report groups for the financial statements (P5-4).
-- Each account belongs to one report group, which places it on the balance sheet (current or non-current) and, from
-- slice 5.2, in the cash-flow sections. Only assets and liabilities have a choice; every other class has exactly one
-- group. Changing a group moves no posted amount: it changes where the balance is shown.

ALTER TABLE accounts ADD COLUMN report_group text;

UPDATE accounts SET report_group = CASE
    WHEN account_class = 'asset' AND code IN ('1500', '1590') THEN 'non_current_asset'
    WHEN account_class = 'asset' THEN 'current_asset'
    WHEN account_class = 'liability' AND code = '2400' THEN 'non_current_liability'
    WHEN account_class = 'liability' THEN 'current_liability'
    WHEN account_class = 'expense' THEN 'operating_expense'
    ELSE account_class
  END;

ALTER TABLE accounts
  ALTER COLUMN report_group SET NOT NULL,
  ADD CONSTRAINT accounts_report_group CHECK (
    CASE account_class
      WHEN 'asset' THEN report_group IN ('current_asset', 'non_current_asset')
      WHEN 'liability' THEN report_group IN ('current_liability', 'non_current_liability')
      WHEN 'expense' THEN report_group = 'operating_expense'
      ELSE report_group = account_class
    END);

-- A new account without a group gets the usual one for its class (current, for assets and liabilities).
CREATE FUNCTION accounts_default_report_group() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.report_group IS NULL THEN
    NEW.report_group := CASE NEW.account_class
      WHEN 'asset' THEN 'current_asset'
      WHEN 'liability' THEN 'current_liability'
      WHEN 'expense' THEN 'operating_expense'
      ELSE NEW.account_class
    END;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER accounts_default_report_group BEFORE INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION accounts_default_report_group();

-- The default chart places equipment, its depreciation and loans as non-current.
ALTER FUNCTION seed_chart_of_accounts(uuid) RENAME TO seed_chart_of_accounts_0018;
REVOKE ALL ON FUNCTION seed_chart_of_accounts_0018(uuid) FROM PUBLIC;

CREATE FUNCTION seed_chart_of_accounts(p_tenant uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
BEGIN
  PERFORM seed_chart_of_accounts_0018(p_tenant);
  UPDATE accounts SET report_group = 'non_current_asset'
    WHERE tenant_id = p_tenant AND code IN ('1500', '1590') AND account_class = 'asset';
  UPDATE accounts SET report_group = 'non_current_liability'
    WHERE tenant_id = p_tenant AND code = '2400' AND account_class = 'liability';
END
$$;
