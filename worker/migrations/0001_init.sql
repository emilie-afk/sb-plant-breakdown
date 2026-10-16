-- ============================================================
-- sb-plant-breakdown Worker — shared report store
--
-- Holds PRODUCT-LEVEL SALES REPORTS only. No customer data of any kind:
-- no names, emails, addresses, order ids or buyer identifiers. The ingest
-- route rejects any payload carrying a customer-looking field.
-- ============================================================

-- One row per stored report snapshot.
-- A report is identified by source + scope + the two period dates. Re-importing
-- the same scope and period REVISES that report; it never adds a second active
-- row, so totals can never be double counted.
CREATE TABLE IF NOT EXISTS reports (
  id                TEXT PRIMARY KEY,         -- <source>:<scope>:<start>:<end>:r<revision>
  report_key        TEXT NOT NULL,            -- <source>:<scope>:<start>:<end>
  source            TEXT NOT NULL,            -- 'shopify' | 'amazon'
  report_scope      TEXT NOT NULL,            -- e.g. 'total_sales_by_product'
  period_start      TEXT NOT NULL,            -- YYYY-MM-DD in the store timezone
  period_end        TEXT NOT NULL,
  comparison_start  TEXT,
  comparison_end    TEXT,
  comparison_source TEXT,                     -- how the comparison dates were established
  timezone          TEXT NOT NULL,            -- e.g. America/Los_Angeles
  currency          TEXT NOT NULL,
  source_filename   TEXT,
  content_hash      TEXT NOT NULL,            -- hash of the normalized rows
  row_count         INTEGER NOT NULL,
  has_product_id    INTEGER NOT NULL DEFAULT 0,
  totals_json       TEXT NOT NULL,            -- totals exactly as imported
  prior_totals_json TEXT,
  capabilities_json TEXT NOT NULL,            -- what the source did and did not carry
  revision          INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'superseded'
  superseded_by     TEXT,
  imported_at       TEXT NOT NULL,
  imported_by       TEXT NOT NULL             -- 'collector' | 'manual'
);

-- Exactly one ACTIVE report per source + scope + period. This is the database
-- making double counting impossible rather than trusting the caller.
CREATE UNIQUE INDEX IF NOT EXISTS reports_one_active
  ON reports (report_key) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS reports_lookup
  ON reports (source, report_scope, period_start, period_end, status);

-- Product rows. product_id is the Shopify product id where the report carries
-- one; it is nullable because the default export does not.
CREATE TABLE IF NOT EXISTS report_rows (
  report_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  product_id   TEXT,
  title        TEXT NOT NULL,
  vendor       TEXT NOT NULL,
  product_type TEXT NOT NULL,
  units REAL NOT NULL DEFAULT 0, gross REAL NOT NULL DEFAULT 0,
  disc  REAL NOT NULL DEFAULT 0, ret   REAL NOT NULL DEFAULT 0,
  net   REAL NOT NULL DEFAULT 0, tax   REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  glance REAL NOT NULL DEFAULT 0, inv REAL NOT NULL DEFAULT 0,
  p_units REAL, p_gross REAL, p_disc REAL, p_ret REAL, p_net REAL, p_tax REAL, p_total REAL,
  PRIMARY KEY (report_id, seq),
  FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS report_rows_product ON report_rows (product_id);

-- Every import attempt, successful or not. A failed import never disturbs the
-- last successful report; it only adds a row here.
CREATE TABLE IF NOT EXISTS import_runs (
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  source        TEXT NOT NULL,
  report_scope  TEXT,
  period_start  TEXT,
  period_end    TEXT,
  outcome       TEXT NOT NULL,   -- 'succeeded' | 'unchanged' | 'rejected' | 'failed'
  error_code    TEXT,
  error_message TEXT,            -- never contains a field VALUE, only the rule broken
  row_count     INTEGER,
  content_hash  TEXT,
  report_id     TEXT,
  revision      INTEGER,
  imported_by   TEXT NOT NULL,
  client        TEXT             -- a host label, never a credential
);
CREATE INDEX IF NOT EXISTS import_runs_recent ON import_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS import_runs_source ON import_runs (source, started_at DESC);

-- Approved catalogue mappings: a sales identity a human has confirmed points
-- at a catalogue record. Keyed on the stable Shopify product id when the
-- report carries one, otherwise on the title+vendor fallback identity.
CREATE TABLE IF NOT EXISTS catalog_mappings (
  match_key    TEXT PRIMARY KEY,   -- 'pid:<product_id>' | 'tv:<title>␟<vendor>'
  product_id   TEXT,
  handle       TEXT,
  title        TEXT,
  vendor       TEXT,
  basis        TEXT NOT NULL,      -- 'product_id' | 'exact_title_vendor' | 'approved_manual'
  approved_by  TEXT,
  approved_at  TEXT NOT NULL,
  note         TEXT
);
