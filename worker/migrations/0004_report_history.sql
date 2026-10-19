-- ============================================================
-- 0004 — report history metadata
--
-- Every stored revision stays in `reports` (status 'active' for the one in
-- use, 'superseded' for earlier revisions), so history is never erased. This
-- migration adds what the dashboard needs to tell a sales PERIOD apart from
-- WHEN the data was collected, and whether the period was over at the time.
-- ============================================================

-- When the collector (or a person) produced the export. Not the sales period.
ALTER TABLE reports ADD COLUMN collected_at TEXT;
-- When this revision became the active report (the successful import).
ALTER TABLE reports ADD COLUMN activated_at TEXT;
-- Last time an identical re-collection confirmed this revision (no new revision).
ALTER TABLE reports ADD COLUMN confirmed_at TEXT;
-- 'complete' when the period had ended (in the store's timezone) at collection
-- time, otherwise 'partial' (month to date, or a period still running).
ALTER TABLE reports ADD COLUMN completeness TEXT;
-- Included / excluded totals (rows left out of rankings, such as shipping or
-- tips), when the importer computed them. Included + excluded = totals.
ALTER TABLE reports ADD COLUMN included_totals_json TEXT;
ALTER TABLE reports ADD COLUMN excluded_totals_json TEXT;
ALTER TABLE reports ADD COLUMN exclusion_labels_json TEXT;

-- Existing rows: the import time is the best record of both moments. The
-- store date is approximated conservatively (UTC − 8 h), so a report imported
-- in the last hours of its final day reads 'partial', never falsely 'complete'.
UPDATE reports SET activated_at = imported_at WHERE activated_at IS NULL AND status IN ('active', 'superseded');
UPDATE reports SET collected_at = imported_at WHERE collected_at IS NULL;
-- A month-to-date slice (the 1st to a day before month end) is always partial.
UPDATE reports SET completeness = CASE
    WHEN substr(period_start, 9, 2) = '01' AND substr(period_start, 1, 7) = substr(period_end, 1, 7)
         AND period_end < date(period_start, 'start of month', '+1 month', '-1 day') THEN 'partial'
    WHEN date(imported_at, '-8 hours') > period_end THEN 'complete'
    ELSE 'partial' END
  WHERE completeness IS NULL;

CREATE INDEX IF NOT EXISTS reports_history ON reports (report_key, revision);
