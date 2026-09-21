-- Phase 3E-a. Additive only: two new tables, no change to 0001 or 0002.
--
-- search_revisions is the source of truth and is append-only: one row per applied
-- revision, which is what makes a bump cost zero writes to evaluation_tasks (3D made
-- eligibility a read-time predicate over evaluated_revision).
--
-- search_settings is a two-column singleton pointer. CHECK (id = 1) is the design
-- decision in the schema: EXACTLY ONE ACTIVE SEARCH. That limitation already exists in
-- the merged tables -- price_observations and evaluation_tasks are both
-- PRIMARY KEY (source, listing_id), so one listing carries one market_key and one
-- evaluated_revision -- and a second concurrent overlapping search would make a
-- listing's contribution MOVE between markets and its verdict flap. The CHECK does not
-- create the limitation; it refuses the state loudly instead of letting it happen.
--
-- The REFERENCES makes a dangling pointer unrepresentable. It also fixes the write
-- order: the revision row must exist before anything points at it.
--
-- No seed row: a fresh database has no settings, and loadCurrentSettings returns null
-- for it. docs/phase-3e-scheduling.md carries the bootstrap.
--
-- No index. Both primary keys are INTEGER rowid aliases, so neither table adds an
-- entry to the exhaustive index list schema.test.ts S2 asserts.

CREATE TABLE search_revisions (
  revision                 INTEGER NOT NULL PRIMARY KEY,
  mode                     TEXT    NOT NULL,
  minimum_discount_percent REAL,
  maximum_price_cents      INTEGER,
  created_at               INTEGER NOT NULL,
  CHECK (revision >= 0),
  CHECK (mode IN ('DISCOUNT', 'MAXIMUM_PRICE', 'BOTH')),
  CHECK (maximum_price_cents IS NULL OR maximum_price_cents >= 0),
  CHECK (minimum_discount_percent IS NULL
         OR (minimum_discount_percent >= 0 AND minimum_discount_percent <= 100))
);

CREATE TABLE search_settings (
  id               INTEGER NOT NULL PRIMARY KEY,
  current_revision INTEGER NOT NULL REFERENCES search_revisions (revision),
  CHECK (id = 1)
);
