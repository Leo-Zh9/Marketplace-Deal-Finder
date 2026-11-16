-- Monitoring controls. Additive only: ONE new table and ONE seed row. 0001-0007 are APPLIED IN
-- PRODUCTION and SQLite can neither drop a CHECK nor alter a primary key, so nothing here issues
-- an ALTER, DROP, UPDATE or DELETE.
--
-- WHAT THIS ROW SWITCHES. `enabled = 0` is the dashboard's Stop: `GET /api/watch-targets` hands
-- the collector `monitoring: "stopped"` and an empty list (the collector logs one line and exits
-- 0 without searching or posting health), and each monitoring run records STOPPED and skips the
-- drain and the notify step. The cleanup cron, ingest, `/api/watch` and the notifications rows
-- are untouched. It is NOT the 3am kill switch: that is the monitor_lock HOLD in
-- docs/phase-3e-monitoring.md, which needs no Worker code to work.
--
-- A SINGLETON, NOT A HISTORY TABLE. `changed_at` is the one instant the page shows ("Stopped at
-- 14:38"); who stopped it and when it was last started are not kept.
--
-- NO INDEX: `id INTEGER PRIMARY KEY` is a rowid alias, so SQLite builds nothing and the
-- exhaustive index list schema.test.ts S2 asserts does not change.

CREATE TABLE monitoring_state (
  id         INTEGER NOT NULL PRIMARY KEY,
  enabled    INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  -- EXACTLY ONE ROW, the same idiom as search_settings (0003), watch_market (0005) and
  -- collector_health (0006): with a second row storable, "is monitoring on?" has two answers.
  CHECK (id = 1),
  CHECK (enabled IN (0, 1)),
  -- The typeof term is load-bearing for the affinity reason 0005 and 0006 record: with the range
  -- test alone a REAL timestamp passes and stores as typeof='real'.
  CHECK (typeof(changed_at) = 'integer' AND changed_at >= 0)
);

-- SEEDED RUNNING, so applying this migration changes nothing about an install that is collecting
-- today. `changed_at = 0` means "never changed". The readers also treat an ABSENT row as running,
-- so a hand-deleted row cannot stop collection silently either.
INSERT INTO monitoring_state (id, enabled, changed_at) VALUES (1, 1, 0);
