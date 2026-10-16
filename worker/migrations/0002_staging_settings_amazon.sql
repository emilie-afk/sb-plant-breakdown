-- ============================================================
-- 0002 — staged imports, Amazon row fields, shared settings
-- ============================================================

-- Imports are written as status 'staging' first and only flipped to
-- 'active' once every row is in. A failure part-way leaves a staging report
-- that nothing reads, and the previous active report is never touched.
-- (reports.status: 'staging' | 'active' | 'superseded' | 'abandoned')

-- Amazon rows carry an ASIN and a few measures Shopify rows do not.
ALTER TABLE report_rows ADD COLUMN asin TEXT;
ALTER TABLE report_rows ADD COLUMN extra_json TEXT;   -- shipped units, shipped revenue, order items
CREATE INDEX IF NOT EXISTS report_rows_asin ON report_rows (asin);

-- Small shared settings that must be the same in every browser:
-- classification overrides, approved catalog mappings, confirmed Amazon
-- column mappings. Values are JSON. Every write keeps who and when.
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);
