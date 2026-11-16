-- The alerting slice. Additive only: ONE new table and ONE seed row. 0001-0005 are APPLIED IN
-- PRODUCTION and SQLite can neither drop a CHECK nor alter a primary key, so nothing here issues
-- an ALTER, DROP, UPDATE or DELETE.
--
-- WHAT THIS TABLE IS FOR, AND WHY IT IS NOT WHERE THE GUARD'S STATE LIVES. `GET /api/status` was
-- a hardcoded stub answering `{status:"ok", phase:2}` UNCONDITIONALLY -- it said "ok" when
-- collection had been dead for a week. This row is what lets it tell the truth. It is NOT the
-- collector's cross-run counter: exit 5's documented meaning explicitly includes "the POST failed
-- with 5xx or a network error", so a counter kept HERE could not increment during the outage it
-- exists to detect. That state lives in `~/.marketplace-collector-state.json`, mode 600.
--
-- A SINGLETON, NOT A HISTORY TABLE, AND THE REASON IS RETENTION. A history needs a retention
-- policy and a sweep, and `listings` retention is out of this slice's scope; the laptop's
-- timestamped JSONL log already IS the history. The consequence is named rather than discovered:
-- alarm history is not readable from the page, only the current state.
--
-- ONE UPSERT PER RUN LINE = 48 rows/day against a measured 45,627 of 100,000 rows/24 h: +0.05 %,
-- 45.6 % -> 45.7 %. It grows with neither the target count nor time, and the read side is one row
-- per page load.
--
-- NO INDEX, BY THE SAME RULE 0003, 0004 AND 0005 RECORD: `id INTEGER PRIMARY KEY` is a rowid
-- alias, so SQLite builds nothing, and the exhaustive index list schema.test.ts S2 asserts does
-- not change. THAT LIST NOT CHANGING IS ITSELF THE ASSERTION (S-n2).

CREATE TABLE collector_health (
  id          INTEGER NOT NULL PRIMARY KEY,
  -- THE SERVER'S CLOCK, NEVER THE COLLECTOR'S, and that is enforced in the handler rather than
  -- here: the wire body has no `reportedAt` field at all and an unknown field is a 400. A laptop
  -- whose clock is wrong would otherwise report itself permanently fresh, and freshness is the
  -- single most load-bearing value on the page. H-2 is the guard.
  reported_at INTEGER NOT NULL,
  exit_code   INTEGER NOT NULL,
  -- BOTH `complete` AND `exit_code` ARE CARRIED, AND THE EQUIVALENCE IS NOTED SO A REVIEWER NEED
  -- NOT FIND IT. With `canary` true only on a STRICT reduction,
  -- `complete <=> (exit_code = 0 AND NOT canary)` in every case, whole-run failures included. The
  -- column is carried anyway because that equivalence holds only by virtue of THREE separate
  -- collector properties -- every returned target is attempted and never removed; `worstExitCode`
  -- ranks every non-zero code above 0; `canary` is true only on a strict reduction -- NONE of
  -- which anything on the Worker side can see. Deriving it here would make the page's correctness
  -- depend on three invariants of another process. One INTEGER on a singleton row removes that
  -- dependency, and it gives `complete` its first production consumer.
  complete    INTEGER NOT NULL,
  canary      INTEGER NOT NULL,
  -- THE DRY-RUN TRAP, IN A COLUMN. A launchd environment file with COLLECTOR_DRY_RUN set produces
  -- `complete:true, exitCode:0` FOREVER WHILE COLLECTING NOTHING, and `fixture` is the same lie by
  -- a different mechanism (COLLECTOR_HTML_FILE: a punctual run, exit 0, every listing stored, off
  -- a saved page). The report is SENT under both, carrying the flag -- skipping it is the obvious
  -- reading and it rebuilds the lie in the STALE disguise, where "stale" reads as a broken cron
  -- instead of saying why.
  dry_run     INTEGER NOT NULL,
  fixture     INTEGER NOT NULL,
  -- THE COUNT THE SERVER RETURNED, exactly as the run line defines it -- never the count that ran.
  -- The page's reduced-coverage sentence is derived from this and CANARY_TARGETS, so a 3-target
  -- watch list cannot read "instead of all 9" (P-8).
  targets     INTEGER NOT NULL,
  -- A JSON ARRAY OF CAUSE STRINGS, as text. D1 has no array type and no JSON type; the shape is
  -- validated IN THE HANDLER before the write, which is what keeps a bad body a 400 rather than a
  -- 503 -- the CHECK below alone would put two different fixes (fix the collector, fix D1) behind
  -- one code. H-4 is the guard.
  alarms      TEXT    NOT NULL,
  -- EXACTLY ONE HEALTH ROW, in the schema rather than in a comment -- the same idiom and the same
  -- reason as `search_settings` in 0003 and `watch_market` in 0005. With a second row storable,
  -- "the latest health" becomes ambiguous and the page would show whichever row the read happened
  -- to return. S-n4 asserts the refusal behaviourally; S-n3 pins this list's membership.
  CHECK (id = 1),
  -- THE typeof TERM IS LOAD-BEARING AND IS NOT DECORATION, for the reason 0005 measures: SQLite
  -- INTEGER is AFFINITY, so with the range test alone a REAL 1759500000.5 passes and stores as
  -- typeof='real'. That is the same affinity trap worker/api/settings.ts records jamming every
  -- subsequent settings PUT (60000.5 in search_revisions). Here it would make `ageMinutes`
  -- fractional and the badge's boundary unreproducible. SQLite cannot add a CHECK in place.
  CHECK (typeof(reported_at) = 'integer' AND reported_at >= 0),
  -- NOT an enumeration of 0/2/3/4/5/6: 0004 states the rule that a CHECK on a set that WILL grow
  -- buys a production table rebuild the first time it does, and `collector/run.ts` documents an
  -- unnamed code as a REACHABLE bug state that must stay visible rather than be refused here.
  CHECK (typeof(exit_code) = 'integer' AND exit_code >= 0),
  CHECK (complete IN (0, 1)),
  CHECK (canary   IN (0, 1)),
  CHECK (dry_run  IN (0, 1)),
  CHECK (fixture  IN (0, 1)),
  CHECK (typeof(targets) = 'integer' AND targets >= 0),
  -- A LAST-DITCH SHAPE GUARD, AND ITS OWN LIMIT IS MEASURED RATHER THAN GUESSED: it refuses
  -- `"boom"`, `null`, `{}` and `[oops` (verified -- the trailing `]` is required), and it ACCEPTS
  -- `[oops]` and `[1,2]`. So it cannot tell an array of cause strings from an array of numbers or
  -- from text that merely has brackets on both ends. The real validation is the handler's (H-4);
  -- this exists only so that a future second writer cannot put a plainly non-array value in the
  -- column the page parses.
  CHECK (alarms LIKE '[%]')
);

-- SEEDED HERE, NOT IN A RUNBOOK, for the reason 0005 records: a hand-written `wrangler d1
-- execute` bootstrap is a writer that sits OUTSIDE the CHECKs, and worker/api/settings.ts
-- documents what one such writer actually produced.
--
-- `reported_at = 0` IS THE INERT ROW AND IT IS READ AS `unknown`, NEVER AS `stale`. Without the
-- `= 0` branch in `readCollectorHealth` this row reads as roughly 29,000,000 minutes old, so a
-- freshly migrated database would claim the collector died 55 years ago. H-7 is the guard.
INSERT INTO collector_health
  (id, reported_at, exit_code, complete, canary, dry_run, fixture, targets, alarms)
VALUES (1, 0, 0, 0, 0, 0, 0, 0, '[]');
