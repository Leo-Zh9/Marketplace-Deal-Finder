-- Phase 3D evaluation columns. Additive only: 0001 is merged and may already have been
-- applied, and SQLite cannot alter a primary key or drop a constraint.

-- The search revision the last COMPLETED evaluation ran under. NULL is load-bearing: it is
-- what ALTER TABLE leaves on every task a database that already ran 3C holds, which makes
-- each of those eligible exactly once after this deploys, and stamped thereafter.
ALTER TABLE evaluation_tasks ADD COLUMN evaluated_revision INTEGER;

-- The verdict that was committed. NOT observability: 3D marks a task COMPLETE before Phase 4
-- can record a notification, so without this column a crash in between leaves a DEAL that is
-- ineligible under every claim tier and is never re-derived. This column is what lets it be
-- recovered.
ALTER TABLE evaluation_tasks ADD COLUMN verdict TEXT;

-- When 3D last produced a verdict for this task. Its reader is tier 3's ORDER BY, and that is
-- not decoration -- it is the only thing that makes the NEEDS_REVIEW queue rotate.
--
-- HISTORY, because this column was removed once and the removal shipped a defect. It was cut on
-- review as "a column with no reader". That was correct about the code as written and wrong about
-- the code as needed: tier 3 was then ordered by created_at, nothing ever advances created_at for
-- a task that stays in the queue (COMPLETE_TASK does not write it, and QUEUE_TASK only fires on a
-- content change), so the claim returned THE SAME 15 ROWS on every call forever while every other
-- NEEDS_REVIEW task was never re-examined. Measured over five real calls. Do not remove it again
-- without first re-reading Decision 5.
ALTER TABLE evaluation_tasks ADD COLUMN evaluated_at INTEGER;

-- Crash recovery timer. NOT NULL is not stylistic: a NULL lease is never <= now, so the row
-- would never be re-claimed and the task would be stranded forever.
ALTER TABLE evaluation_tasks ADD COLUMN lease_expires_at INTEGER NOT NULL DEFAULT 0;

-- The fencing token for the claim that is currently allowed to complete this task. A claim
-- writes a fresh token; a completion only applies if the token still matches. See Decision 3:
-- the lease VALUE cannot serve as the token, and the interleaving that breaks it is measured.
ALTER TABLE evaluation_tasks ADD COLUMN lease_token TEXT NOT NULL DEFAULT '';

-- Tiers 1 and 2: oldest-queued-first over PENDING and expired PROCESSING.
-- listing_id is in the index so `ORDER BY created_at, listing_id` is a pure index scan: a whole
-- scan writes one `now` to every task it queues, so created_at ties are the normal case, and
-- without the tiebreak in the index SQLite sorts the entire tier to pick 15.
-- Measured: COVERING INDEX, no TEMP B-TREE, 15 rows read over 20,000 PENDING sharing one created_at.
CREATE INDEX evaluation_tasks_queue ON evaluation_tasks (source, status, created_at, listing_id);

-- Tier 3: least-recently-evaluated-first over NEEDS_REVIEW. Same reasoning for listing_id --
-- every completion in one batch writes the same `now`, so evaluated_at ties are the normal case.
-- Measured: COVERING INDEX, no TEMP B-TREE, 15 rows read over 20,000 NEEDS_REVIEW sharing one
-- evaluated_at.
CREATE INDEX evaluation_tasks_attempt ON evaluation_tasks (source, status, evaluated_at, listing_id);

-- Tier 4: the stale-revision set, as three index ranges (IS NULL / < / >).
-- Measured: MULTI-INDEX OR over covering ranges, no TEMP B-TREE, 15 rows read over 20,000 stale.
CREATE INDEX evaluation_tasks_revision ON evaluation_tasks (source, status, evaluated_revision);
