-- Phase 5 slice 5.6: indexes the 100-room measurements called for (P5-16, docs/phase-5-performance.md).

-- The cashbook's ledger check reads the lines posted to a cash ledger account without a drawer or bank; there
-- are almost none, but without this index every line of the account was read to find them.
CREATE INDEX journal_lines_untagged_idx ON journal_lines (account_id) WHERE cash_account_id IS NULL;

-- Occupancy counts the nights accrued by the night audit in a date range for a property.
CREATE INDEX room_revenue_accruals_night_idx ON room_revenue_accruals (property_id, night);
