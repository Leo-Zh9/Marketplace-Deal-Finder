-- Phase 3E-b. Additive only: two new tables and one seed row, no change to 0001, 0002 or
-- 0003. Those three are APPLIED IN PRODUCTION and SQLite can neither drop a CHECK nor alter
-- a primary key, so nothing here issues an ALTER, DROP, UPDATE or DELETE.
--
-- monitor_lock is a singleton row, the same idiom as search_settings: CHECK (id = 1) says
-- EXACTLY ONE MONITORING RUN MAY MUTATE AT A TIME, in the schema rather than in a comment.
-- The fencing token is the Workflow instance id, which is stable across a step retry and an
-- instance replay and is not forgeable from the payload.

CREATE TABLE monitor_lock (
  id          INTEGER NOT NULL PRIMARY KEY,
  run_id      TEXT    NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  CHECK (id = 1)
);

-- SEEDED, AND NOT FOR TIDINESS. The documented 3am kill switch is a write to this row. As a
-- bare `UPDATE ... WHERE id = 1` against an empty table it reports changes 0, leaves the
-- table empty, and the next run acquires normally -- measured -- and `wrangler d1 execute`
-- does not print changes, so it reads as success. The window is "deployed, cron enabled,
-- first run not yet fired", which is exactly when an operator reaches for it. Two independent
-- fixes, both free: docs/phase-3e-monitoring.md writes the kill switch as an UPSERT, and this
-- row exists so even the bare form works.
--
-- The seed costs nothing at acquire time: expires_at = 0 satisfies `expires_at <= ?now` for
-- every legal `now`, so the first real acquire takes it through the ordinary conflict path --
-- measured at the same 2 rows read / 1 written as against an absent row.
INSERT INTO monitor_lock (id, run_id, acquired_at, expires_at) VALUES (1, '', 0, 0);

-- One row per monitoring run, written at finalize inside the same db.batch as the prune and
-- the lock release. This is the ONLY durable record a run leaves: the Workflow instance
-- output expires and there is no alerting until Phase 4.
--
-- run_seq is an INTEGER PRIMARY KEY, i.e. a rowid alias, so ordering and retention are free
-- and it adds no index. run_id TEXT UNIQUE creates sqlite_autoindex_monitor_runs_1, whose
-- `sql IS NULL` -- so schema.test.ts S2's exhaustive index list is unchanged by this file.
--
-- NO CHECK ON status, deliberately. 0003 checks `mode` because a bad mode makes
-- validateSettings throw on every call; nothing branches on monitor_runs.status. The status
-- set WILL grow -- the spec already names SOURCE_EMPTY, unreachable while collection is
-- parked -- and SQLite can neither add nor drop a CHECK in place, so a CHECK here buys a
-- production table rebuild the first time a status is added.
--
-- facebook_request_count from the spec is request_count here: nothing in storage, evaluation
-- or scheduling names a source, and `source` stays the caller's opaque value.
CREATE TABLE monitor_runs (
  run_seq             INTEGER NOT NULL PRIMARY KEY,
  run_id              TEXT    NOT NULL UNIQUE,
  scheduled_at        INTEGER NOT NULL,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER NOT NULL,
  status              TEXT    NOT NULL,
  search_revision     INTEGER,
  sources             TEXT    NOT NULL,
  sources_truncated   INTEGER NOT NULL,
  selected_components TEXT    NOT NULL,
  request_count       INTEGER NOT NULL,
  result_count        INTEGER NOT NULL,
  new_count           INTEGER NOT NULL,
  changed_count       INTEGER NOT NULL,
  unchanged_count     INTEGER NOT NULL,
  claimed_count       INTEGER NOT NULL,
  evaluation_count    INTEGER NOT NULL,
  -- Outcomes whose reason was `evaluation-error`: a per-candidate `decide` throw that
  -- evaluateBatch caught internally. NOT a run failure -- the task completes and the others are
  -- unaffected -- which is exactly why it needs a column of its own. It does not move `status`,
  -- so the console.warn never fires for it, and the Workflow instance output expires; without
  -- this column a `decide` bug that degrades every verdict to NEEDS_REVIEW leaves NO durable
  -- evidence anywhere in the system.
  evaluation_error_count INTEGER NOT NULL,
  discarded_count     INTEGER NOT NULL,
  batches             INTEGER NOT NULL,
  steps_used          INTEGER NOT NULL,
  step_failures       INTEGER NOT NULL,
  rows_read           INTEGER NOT NULL,
  rows_written        INTEGER NOT NULL,
  errors              TEXT    NOT NULL
);
