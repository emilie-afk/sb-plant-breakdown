-- ============================================================
-- 0006 — sign-in attempt counters for the dashboard's Netlify gateway
--
-- One row per bucket ("global" or "client:<hmac of the client address>"):
-- the start of the current fixed window and the attempts counted in it.
-- Every change is a single INSERT ... ON CONFLICT DO UPDATE ... RETURNING
-- statement, so concurrent sign-ins cannot lose counts. No address, password
-- or session is stored. Adds a table only; nothing existing changes.
-- ============================================================
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  n            INTEGER NOT NULL
);
