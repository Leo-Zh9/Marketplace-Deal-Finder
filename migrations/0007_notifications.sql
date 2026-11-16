-- Phase 4: Discord deal notifications. ADDITIVE ONLY: one new table and one new index, nothing
-- existing is altered or dropped.
--
-- ONE ROW PER LISTING, EVER. The primary key is (source, listing_id). PLAN.md §18 asks for
-- UNIQUE(user_id, platform, listing_id); there is exactly one user (ARCHITECTURE.md §1), so the
-- user column is dropped and `source` is the platform. A SENT row is never re-armed, so a listing
-- is alerted at most once however often it is re-evaluated; only a CANCELLED row (never sent) can
-- return to PENDING. docs/phase-4-notifications.md has the state machine.
--
-- A NORMAL ROWID TABLE, NOT WITHOUT ROWID. The send loop claims one row with
-- `UPDATE ... WHERE rowid = (SELECT rowid ... LIMIT 1)`, evaluateBatch's CLAIM pattern, and fences
-- every later write on that rowid. worker/storage/schema.test.ts pins that the rowid exists.
--
-- `last_attempt_at` is written on EVERY fetch outcome and kept through later status changes
-- (cancel, sweep, re-arm). `/api/status` derives `webhook-rejected` from the row with the latest
-- `last_attempt_at`, so a write path that cleared it would erase what was measured.
--
-- NOTHING HERE STORES THE WEBHOOK URL. It lives in a Worker secret and nowhere else.
CREATE TABLE notifications (
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
  PRIMARY KEY (source, listing_id),
  CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'DELIVERY_UNKNOWN', 'FAILED', 'CANCELLED')),
  CHECK (attempts >= 0),
  CHECK (last_error IS NULL OR length(last_error) <= 200)
);

-- The claim's lookup: status = 'PENDING' AND next_attempt_at due.
CREATE INDEX notifications_due ON notifications (status, next_attempt_at);
