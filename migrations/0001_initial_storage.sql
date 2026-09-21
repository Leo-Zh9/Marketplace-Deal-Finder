-- Phase 3C initial storage schema.
--
-- variant_key is NOT NULL with '' as the "no variant" sentinel on every table.
-- This is not stylistic: SQLite does not deduplicate NULLs in a UNIQUE index,
-- ON CONFLICT never fires on them, and `WHERE variant_key = ?` bound to NULL
-- matches zero rows -- which would make the aggregate arithmetic silently skip
-- every variant-less listing.

CREATE TABLE listings (
  source         TEXT    NOT NULL,
  listing_id     TEXT    NOT NULL,
  market_key     TEXT    NOT NULL,
  component_type TEXT    NOT NULL,
  model_key      TEXT,
  variant_key    TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  price_cents    INTEGER,
  location_text  TEXT,
  url            TEXT    NOT NULL,
  validity       TEXT    NOT NULL,
  content_hash   TEXT    NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (source, listing_id),
  CHECK (price_cents IS NULL OR price_cents >= 0)
);

CREATE TABLE price_observations (
  source       TEXT    NOT NULL,
  listing_id   TEXT    NOT NULL,
  market_key   TEXT    NOT NULL,
  model_key    TEXT    NOT NULL,
  variant_key  TEXT    NOT NULL,
  price_cents  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (source, listing_id),
  CHECK (price_cents >= 0)
);

CREATE TABLE model_stats (
  market_key        TEXT    NOT NULL,
  model_key         TEXT    NOT NULL,
  variant_key       TEXT    NOT NULL,
  count             INTEGER NOT NULL,
  total_price_cents INTEGER NOT NULL,
  PRIMARY KEY (market_key, model_key, variant_key),
  CHECK (count >= 0),
  CHECK (total_price_cents >= 0),
  CHECK (count > 0 OR total_price_cents = 0)
);

CREATE TABLE evaluation_tasks (
  source     TEXT    NOT NULL,
  listing_id TEXT    NOT NULL,
  status     TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (source, listing_id)
);

CREATE INDEX price_observations_last_seen_at ON price_observations (last_seen_at);
