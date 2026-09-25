-- Phase 3F. Additive only: two new tables and three seed rows. 0001-0004 are APPLIED IN
-- PRODUCTION and SQLite can neither drop a CHECK nor alter a primary key, so nothing here
-- issues an ALTER, DROP, UPDATE or DELETE.
--
-- WHY THIS IS NOT IN search_revisions. That table is the append-only revision log and its
-- revision number is evaluateBatch's staleness key: a bump re-opens every task in the corpus
-- (CLAIM_STALE_REVISION, worker/evaluation/evaluateBatch.ts). Editing what you hunt says nothing
-- about whether an already-judged listing was a deal, so it must cost zero verdicts. A separate
-- table is what makes that structural rather than careful.

CREATE TABLE watch_market (
  id        INTEGER NOT NULL PRIMARY KEY,
  location  TEXT    NOT NULL,
  latitude  REAL    NOT NULL,
  longitude REAL    NOT NULL,
  radius_km INTEGER NOT NULL,
  -- EXACTLY ONE MARKET, in the schema rather than in a comment -- the same idiom, and the same
  -- reason, as search_settings' CHECK (id = 1) in 0003: "a second concurrent overlapping search
  -- would make a listing's contribution MOVE between markets and its verdict flap." Measured:
  -- a per-target market moves market_key every run and leaves a model_stats row at count 0 until
  -- the cleanup sweep, which cleanupStaleObservations.ts already names as a thing it exists
  -- to mop up ("one dead row per group per location or radius change").
  CHECK (id = 1),
  -- THE typeof TERM IS LOAD-BEARING AND IS NOT DECORATION. SQLite INTEGER is AFFINITY: with the
  -- range test alone, 12.5, 1.5 and the string "12.5" all pass and store as typeof='real'.
  -- That is the same affinity trap worker/api/settings.ts records jamming every subsequent
  -- settings PUT (60000.5 in search_revisions). 25.0 and '25' still coerce to the integer 25,
  -- so this costs a legitimate writer nothing. SQLite cannot add a CHECK in place.
  CHECK (typeof(radius_km) = 'integer' AND radius_km >= 1 AND radius_km <= 25),
  CHECK (latitude  >= -90  AND latitude  <= 90),
  CHECK (longitude >= -180 AND longitude <= 180),
  -- location IS A URL PATH SEGMENT (collector/searchUrl.ts). With length > 0 as its only guard,
  -- measured: 'toronto/search', '..', '../../etc', 'TORONTO', 'to ronto' and the REAL literal
  -- 25.0 (stored, by TEXT affinity, as the text "25.0") are ALL storable. The GLOB refuses every
  -- one.
  --
  -- MEASURED CORRECTION TO A CLAIM THIS GUARD IS EASY TO OVERSTATE: the INTEGER literal 25 is
  -- NOT refused. TEXT affinity stores it as the text "25", which is all digits, so both this
  -- GLOB and collector/searchUrl.ts's LOCATION_PATTERN accept it -- exactly as both accept the
  -- location '123'. Only a value that reaches the column carrying a '.' (a REAL, e.g. 25.0) is
  -- caught here. Do not write a test row claiming the integer is refused; it is not.
  --
  -- IT IS A CHARACTER-CLASS GUARD, NOT A SHAPE GUARD, AND THE DIFFERENCE IS MEASURED: it is
  -- LOOSER than LOCATION_PATTERN on a leading hyphen, a trailing hyphen and a doubled hyphen,
  -- which parseMarket refuses. It is never TIGHTER: nothing the pattern accepts is refused here.
  -- So the two guards compose instead of fighting.
  CHECK (length(location) > 0 AND location NOT GLOB '*[^a-z0-9-]*')
);

CREATE TABLE watch_targets (
  target_id      TEXT NOT NULL PRIMARY KEY,
  component_type TEXT NOT NULL,
  query          TEXT NOT NULL,
  -- NO CHECK ON component_type, deliberately, and 0004 states the rule: a CHECK on a set that
  -- WILL grow buys a production table rebuild the first time it does. The set is already
  -- TS-enforced -- COMPONENT_TYPES in worker/api/listings.ts is an exhaustive
  -- Record<Listing["componentType"], true> -- and a bad value is a loud 400 INVALID_LISTINGS at
  -- ingest, not a silent one.
  CHECK (length(target_id) > 0),
  CHECK (length(component_type) > 0),
  CHECK (length(query) > 0)
);

-- SEEDED HERE, NOT IN A RUNBOOK. 0003 deliberately seeds nothing and hands the bootstrap to a
-- hand-written `wrangler d1 execute` -- and worker/api/settings.ts records what that writer
-- produced: a value that passes a lower-bound CHECK, stores as REAL, and jams the API
-- permanently. Collection must start before the control panel exists, so the alternative here is
-- exactly that hand-written statement. Seeding inside the migration puts the seed BEHIND the
-- CHECKs above, which a runbook cannot bypass.
--
-- The coordinates are downtown Toronto (Nathan Phillips Square) -- a public landmark, chosen so
-- that a leaked collector token does not disclose the operator's home. The settings UI must
-- preserve that property. Every value here becomes editable there.
INSERT INTO watch_market (id, location, latitude, longitude, radius_km)
VALUES (1, 'toronto', 43.6532, -79.3832, 25);

INSERT INTO watch_targets (target_id, component_type, query)
VALUES ('cpu-toronto', 'cpu', 'cpu');
INSERT INTO watch_targets (target_id, component_type, query)
VALUES ('gpu-toronto', 'gpu', 'graphics card');
