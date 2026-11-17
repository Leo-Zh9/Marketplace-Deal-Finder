-- Multi-user (up to MAX_USERS = 3 approved people in one deployment). ADDITIVE ONLY: five new tables,
-- one new index, seeds and copies. 0001-0008 are APPLIED IN PRODUCTION and every old table stays
-- exactly as it is, so a `wrangler rollback` of the Worker finds the tables it reads. The rollback
-- runbook (docs/multi-user.md) copies user 1's rows back into them.
--
-- WHAT EACH PERSON OWNS: an area (any catalog location + radius), a watch list, a deal rule,
-- Start/Stop and (PR3) their own alerts. Areas MAY OVERLAP.
--
-- ONE EVIDENCE POOL. `listings.market_key`, `price_observations.market_key` and `model_stats.market_key`
-- NO LONGER MEAN "the market the collector ran in". recordSightings binds the code constant
-- EVIDENCE_POOL_KEY (worker/storage/marketKey.ts) into all three, so price averages pool across every
-- user's area (all catalog locations are Ontario / CAD). WHICH AREA A LISTING WAS SEEN IN is the new
-- `listing_markets` membership table below, and every per-user read filters on it.
--
-- THE DEAL RULE MOVES TO `users`. search_settings / search_revisions become a FROZEN internal
-- DISCOUNT "evidence rule": the drain still evaluates every listing once under it (that is what keeps
-- evaluation_tasks.status meaningful -- NEEDS_REVIEW means "not enough market evidence yet"), and no
-- API writes it any more. Each user's own rule is applied at read and notify time (RULE_PREDICATE,
-- worker/evaluation/rulePredicate.ts).
--
-- THE SEED IS USER 1, WITH NO EMAIL. The operator claims it after migrating:
--   UPDATE users SET email = '<owner email, lowercase>' WHERE user_id = 1 AND email IS NULL;
-- Until then every browser route answers 503 OWNER_UNCLAIMED rather than auto-creating an empty
-- second user for the owner's own sign-in.

CREATE TABLE users (
  user_id               INTEGER NOT NULL PRIMARY KEY,
  email                 TEXT UNIQUE,
  -- The area. All four are NULL together (a new user who has not saved yet) or all set.
  location              TEXT,
  latitude              REAL,
  longitude             REAL,
  radius_km             INTEGER,
  -- The user's deal rule, stored as the PROJECTION validateSettings applies (dealRules.ts): the
  -- basis points discountBasisPoints computes, and NULL for the field the mode makes inert.
  mode                  TEXT,
  minimum_discount_bp   INTEGER,
  maximum_price_cents   INTEGER,
  monitoring_enabled    INTEGER NOT NULL,
  monitoring_changed_at INTEGER NOT NULL,
  -- Written on every watch save and every rule change. The enqueue window admits a candidate when
  -- its task was judged in the last day OR this user re-opened alerts in the last day, so a rule or
  -- area change alerts the deals it newly qualifies (the drain no longer re-judges on a rule change).
  alerts_reopened_at    INTEGER,
  created_at            INTEGER NOT NULL,
  CHECK (user_id >= 1),
  -- Stored normalised, because authenticateRequest compares the lowercased, trimmed token email.
  -- A mixed-case claim would otherwise never match and the owner would be provisioned as user 2.
  CHECK (email IS NULL OR (length(email) > 0 AND email = lower(trim(email)))),
  CHECK ((location IS NULL) = (latitude IS NULL)
     AND (location IS NULL) = (longitude IS NULL)
     AND (location IS NULL) = (radius_km IS NULL)),
  -- The area CHECKs are 0005's watch_market CHECKs, for the same measured reasons.
  CHECK (location IS NULL OR (length(location) > 0 AND location NOT GLOB '*[^a-z0-9-]*')),
  CHECK (radius_km IS NULL OR (typeof(radius_km) = 'integer' AND radius_km >= 1 AND radius_km <= 25)),
  CHECK (latitude  IS NULL OR (latitude  >= -90  AND latitude  <= 90)),
  CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180)),
  -- The rule CHECKs mirror validateSettings (dealRules.ts). The typeof terms are load-bearing for
  -- the affinity reason 0005 records: with a range test alone 60000.5 stores as REAL.
  CHECK (mode IS NULL OR mode IN ('DISCOUNT', 'MAXIMUM_PRICE', 'BOTH')),
  CHECK (minimum_discount_bp IS NULL
         OR (typeof(minimum_discount_bp) = 'integer'
             AND minimum_discount_bp >= 0 AND minimum_discount_bp <= 10000)),
  CHECK (maximum_price_cents IS NULL
         OR (typeof(maximum_price_cents) = 'integer' AND maximum_price_cents >= 0)),
  CHECK (mode IS NULL OR mode = 'MAXIMUM_PRICE' OR minimum_discount_bp IS NOT NULL),
  CHECK (mode IS NULL OR mode = 'DISCOUNT'      OR maximum_price_cents IS NOT NULL),
  CHECK (monitoring_enabled IN (0, 1)),
  CHECK (typeof(monitoring_changed_at) = 'integer' AND monitoring_changed_at >= 0)
);

-- One user's searches. The MARKET IS NOT STORED PER ROW: it is derived from the owning user's area
-- (join users), so a row can never drift from the area it is collected in. An area change can
-- therefore turn two users' shared search into two distinct ones -- and legitimately 409 at the cap.
-- No CHECK on component_type, for the reason 0005 records.
CREATE TABLE user_watch_targets (
  user_id        INTEGER NOT NULL REFERENCES users (user_id),
  target_id      TEXT    NOT NULL,
  component_type TEXT    NOT NULL,
  query          TEXT    NOT NULL,
  PRIMARY KEY (user_id, target_id),
  CHECK (length(target_id) > 0),
  CHECK (length(component_type) > 0),
  CHECK (length(query) > 0)
);

-- 0007's notifications, per user: ONE ROW PER (user, listing), EVER, and the same state machine
-- (docs/phase-4-notifications.md). A rowid table for the same reason as 0007: the claim fences on
-- rowid.
CREATE TABLE user_notifications (
  user_id          INTEGER NOT NULL REFERENCES users (user_id),
  source           TEXT    NOT NULL,
  listing_id       TEXT    NOT NULL,
  model_key        TEXT    NOT NULL,
  status           TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,
  lease_token      TEXT,
  lease_expires_at INTEGER,
  last_attempt_at  INTEGER,
  sent_price_cents INTEGER,
  sent_at          INTEGER,
  last_error       TEXT,
  PRIMARY KEY (user_id, source, listing_id),
  CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'DELIVERY_UNKNOWN', 'FAILED', 'CANCELLED')),
  CHECK (attempts >= 0),
  CHECK (last_error IS NULL OR length(last_error) <= 200)
);

-- The claim's lookup, per user.
CREATE INDEX user_notifications_due ON user_notifications (user_id, status, next_attempt_at);

-- WHICH AREAS A LISTING HAS BEEN SEEN IN. One row per (area market key, listing). Every sighting
-- path upserts it, keyed by marketKey(envelope.market), with the same heartbeat suppression as
-- HEARTBEAT_LISTING. NOTHING DELETES FROM IT (ruled: the storage is trivial, and a cleanup that
-- raced a sighting would hide a live listing from its area). Freshness is still read from
-- listings.last_seen_at; this table's own last_seen_at only bounds the heartbeat writes.
CREATE TABLE listing_markets (
  market_key   TEXT    NOT NULL,
  source       TEXT    NOT NULL,
  listing_id   TEXT    NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (market_key, source, listing_id)
) WITHOUT ROWID;

-- THE SHARED SEARCH CAP, IN THE SCHEMA. A watch save's LAST batch statement inserts a 0 here when
-- the distinct (component_type, query, area) count over every user's stored targets exceeds 9; the
-- CHECK refuses it and D1 rolls the whole save back. No row is ever stored. No trigger.
CREATE TABLE watch_cap_guard (
  ok INTEGER NOT NULL,
  CONSTRAINT watch_budget CHECK (ok = 1)
);

-- THE MIGRATION REFUSES AN INSTALL WHOSE SAVED MARKET IS NOT THE EVIDENCE POOL. EVIDENCE_POOL_KEY
-- (worker/storage/marketKey.ts) is 43.6532,-79.3832|25km because that is the market every stored
-- hash, observation and aggregate was written under. On any other saved market the pool constant
-- would re-key every listing on its next sighting -- a write storm -- and orphan the aggregates. So
-- the same CHECK trick as the cap: a 0 into watch_cap_guard, refused, and the whole file rolls back
-- (measured with `wrangler d1 execute --local --file`: no table of a failing file survives). The
-- error names `watch_budget`; docs/multi-user.md says what it means here. A fresh install passes:
-- 0005 seeds exactly that row. An install with no market row passes too: there is nothing to re-key.
INSERT INTO watch_cap_guard (ok)
SELECT 0
 WHERE EXISTS (SELECT 1 FROM watch_market
                WHERE id = 1
                  AND NOT (latitude = 43.6532 AND longitude = -79.3832 AND radius_km = 25));

-- USER 1 IS THE EXISTING INSTALL: its area is watch_market, its rule is the rule in force, its
-- Start/Stop is monitoring_state. LEFT JOINs, so an absent singleton seeds NULLs rather than no user
-- at all. SEEDED BEFORE THE EVIDENCE-RULE BUMP BELOW, so it copies the owner's rule, not the bump.
INSERT INTO users (user_id, email, location, latitude, longitude, radius_km, mode,
                   minimum_discount_bp, maximum_price_cents, monitoring_enabled,
                   monitoring_changed_at, alerts_reopened_at, created_at)
SELECT 1, NULL, wm.location, wm.latitude, wm.longitude, wm.radius_km, r.mode,
       CASE WHEN r.mode = 'MAXIMUM_PRICE' THEN NULL
            ELSE CAST(ROUND(r.minimum_discount_percent * 100) AS INTEGER) END,
       CASE WHEN r.mode = 'DISCOUNT' THEN NULL ELSE r.maximum_price_cents END,
       COALESCE(ms.enabled, 1), COALESCE(ms.changed_at, 0), NULL, 0
  FROM (SELECT 1 AS one) seed
  LEFT JOIN watch_market wm ON wm.id = 1
  LEFT JOIN monitoring_state ms ON ms.id = 1
  LEFT JOIN search_settings ss ON ss.id = 1
  LEFT JOIN search_revisions r ON r.revision = ss.current_revision;

-- AN EVIDENCE RULE MUST EXIST AND BE DISCOUNT. An install whose current rule is not DISCOUNT gets
-- ONE new DISCOUNT revision at its own percent (0 when it has none); a fresh install with no
-- settings gets one at 0%. The bump re-opens every task once (claim tiers 4 and 4b), which the
-- operator pre-flight counts. The threshold itself decides nothing a user sees any more: labels and
-- alerts apply each user's own rule to the live aggregate.
INSERT INTO search_revisions (revision, mode, minimum_discount_percent, maximum_price_cents, created_at)
SELECT COALESCE((SELECT MAX(revision) FROM search_revisions), -1) + 1,
       'DISCOUNT',
       COALESCE((SELECT r.minimum_discount_percent
                   FROM search_settings s JOIN search_revisions r ON r.revision = s.current_revision
                  WHERE s.id = 1), 0),
       NULL,
       CAST(strftime('%s', 'now') AS INTEGER)
 WHERE NOT EXISTS (SELECT 1
                     FROM search_settings s JOIN search_revisions r ON r.revision = s.current_revision
                    WHERE s.id = 1 AND r.mode = 'DISCOUNT');

INSERT INTO search_settings (id, current_revision)
VALUES (1, (SELECT MAX(revision) FROM search_revisions))
ON CONFLICT (id) DO UPDATE SET current_revision = excluded.current_revision
 WHERE (SELECT mode FROM search_revisions WHERE revision = search_settings.current_revision)
       <> 'DISCOUNT';

INSERT INTO user_watch_targets (user_id, target_id, component_type, query)
SELECT 1, target_id, component_type, query FROM watch_targets;

INSERT INTO user_notifications (user_id, source, listing_id, model_key, status, created_at,
                                updated_at, attempts, next_attempt_at, lease_token,
                                lease_expires_at, last_attempt_at, sent_price_cents, sent_at,
                                last_error)
SELECT 1, source, listing_id, model_key, status, created_at, updated_at, attempts,
       next_attempt_at, lease_token, lease_expires_at, last_attempt_at, sent_price_cents, sent_at,
       last_error
  FROM notifications;

-- One write per listing: every stored listing is a member of the area it was collected in, which is
-- exactly what the old `l.market_key = <saved key>` filter tested.
INSERT INTO listing_markets (market_key, source, listing_id, last_seen_at)
SELECT market_key, source, listing_id, last_seen_at FROM listings;
