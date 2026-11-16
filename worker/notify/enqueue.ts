/**
 * ENQUEUE: ONE STATEMENT PER RUN THAT TURNS QUALIFYING DEALS INTO PENDING NOTIFICATIONS.
 *
 * A candidate meets ALL of (`CANDIDATE_PREDICATE`, shared word for word with recheck.ts):
 *
 *   - the listing is `validity = 'VALID'` AND carries a `model_key`. The non-null model is the
 *     gate that closes the MAXIMUM_PRICE no-evidence hole: under MAXIMUM_PRICE the drain marks an
 *     un-normalized CA$0 listing DEAL (scripts/e2e-local.sh records it), and that listing has no
 *     model. It may show on the dashboard; it never pings a phone.
 *   - its task is `COMPLETE`, `verdict = 'DEAL'`, judged at the CURRENT `search_settings`
 *     revision. A price change re-queues the task (recordSightings QUEUE_TASK), so a listing whose
 *     price moved is not a candidate until the drain has judged the new price.
 *   - it was seen within NOTIFY_FRESH_SECONDS. A sighting of an unchanged listing refreshes
 *     `last_seen_at` at most once per HEARTBEAT_SECONDS, so a live listing can look up to 6 h old;
 *     the extra hour is margin for a late collector run.
 *   - it is selected on the dashboard (selection.ts, the verdicts.ts predicate).
 *
 * THE NOT EXISTS RUNS BEFORE THE LIMIT, and that ordering is the anti-starvation property. With
 * the filter after the limit, the 20 newest DEALs -- already SENT -- would fill the window every
 * run and a 21st, new DEAL would never be enqueued. notify.test.ts N-starve pins it.
 *
 * ONLY CANCELLED RE-ARMS. NOT EXISTS excludes every listing with a non-CANCELLED row, so the only
 * conflict this INSERT can raise is against a CANCELLED row, and the `DO UPDATE ... WHERE` says so
 * a second time. SENT, DELIVERY_UNKNOWN and FAILED never come back on their own: once is the
 * contract (PLAN.md §6), and an unknown delivery is a human's call (the runbook's manual resend).
 * A re-armed row starts a fresh delivery -- attempts 0, no backoff, a new `created_at` -- and
 * KEEPS `last_attempt_at` and `last_error`, which are what /api/status reads.
 *
 * Bindings: ?1 now, ?2 watched-type JSON, ?3 watched-pair JSON, ?4 freshness cutoff, ?5 limit.
 */

import { SELECTION_PREDICATE } from "../api/verdicts";
import { HEARTBEAT_SECONDS } from "../storage/types";
import type { NotifySelection } from "./selection";

/** The heartbeat window plus an hour. Imported, never written as a literal. */
export const NOTIFY_FRESH_SECONDS = HEARTBEAT_SECONDS + 3600;

/** How many candidates one run may enqueue. The send loop drains at most 5 per run. */
export const ENQUEUE_LIMIT = 20;

/**
 * The qualification test, over `l` (listings), `t` (evaluation_tasks) and `ss` (search_settings),
 * with `?2`/`?3` the selection and `?4` the freshness cutoff.
 */
export const CANDIDATE_PREDICATE = `l.validity = 'VALID'
   AND l.model_key IS NOT NULL
   AND t.status = 'COMPLETE'
   AND t.verdict = 'DEAL'
   AND t.evaluated_revision = ss.current_revision
   AND l.last_seen_at >= ?4
   AND (${SELECTION_PREDICATE})`;

export const ENQUEUE = `INSERT INTO notifications
       (source, listing_id, model_key, status, created_at, updated_at, attempts)
SELECT l.source, l.listing_id, l.model_key, 'PENDING', ?1, ?1, 0
  FROM listings l
  JOIN evaluation_tasks t ON t.source = l.source AND t.listing_id = l.listing_id
  JOIN search_settings ss ON ss.id = 1
 WHERE ${CANDIDATE_PREDICATE}
   AND NOT EXISTS (SELECT 1 FROM notifications n
                    WHERE n.source = l.source AND n.listing_id = l.listing_id
                      AND n.status <> 'CANCELLED')
 ORDER BY t.evaluated_at DESC, l.listing_id
 LIMIT ?5
ON CONFLICT (source, listing_id) DO UPDATE
   SET status = 'PENDING', model_key = excluded.model_key, created_at = excluded.created_at,
       updated_at = excluded.updated_at, attempts = 0, next_attempt_at = NULL,
       lease_token = NULL, lease_expires_at = NULL, sent_price_cents = NULL, sent_at = NULL
 WHERE notifications.status = 'CANCELLED'`;

export const freshnessCutoff = (now: number): number => now - NOTIFY_FRESH_SECONDS;

/** Returns how many rows were inserted or re-armed. */
export const enqueueCandidates = async (
  db: D1Database,
  now: number,
  selection: NotifySelection,
): Promise<number> => {
  const result = await db
    .prepare(ENQUEUE)
    .bind(
      now,
      JSON.stringify(selection.all),
      JSON.stringify(selection.pairs),
      freshnessCutoff(now),
      ENQUEUE_LIMIT,
    )
    .run();
  return result.meta.changes ?? 0;
};
