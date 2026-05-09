-- 0022_daily_summary_expenses.sql
-- Cache the petty-cash expense totals on the daily summary row so the
-- summary read path doesn't recompute. Adds two columns:
--   total_expenses_value_pesewas (sum)
--   expenses_by_category_json     (breakdown for the dashboard)
--
-- Default values are 0 / [] for backfill of existing rows.

ALTER TABLE daily_summaries ADD COLUMN total_expenses_value_pesewas INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_summaries ADD COLUMN expenses_by_category_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(expenses_by_category_json));
