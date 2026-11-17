/**
 * ENQUEUE: ONE STATEMENT PER USER PER RUN THAT TURNS THAT USER'S QUALIFYING DEALS INTO PENDING
 * NOTIFICATIONS (migrations/0009: `user_notifications`).
 *
 * A candidate meets ALL of (`CANDIDATE_PREDICATE`, shared word for word with recheck.ts):
 *
 *   - the listing is `validity = 'VALID'` AND carries a `model_key`. The non-null model is the
 *     gate that closes the MAXIMUM_PRICE no-evidence hole: under MAXIMUM_PRICE an un-normalized
 *     CA$0 listing is a deal (scripts/e2e-local.sh records it), and that listing has no model. It
 *     may show on the dashboard; it never pings a phone.
 *   - its task has been JUDGED and not re-queued since: `t.status IN ('COMPLETE','NEEDS_REVIEW')`.
 *     A price change re-queues the task (recordSightings QUEUE_TASK), so a listing whose price moved
 *     is not a candidate until the drain has looked at the new price. NEEDS_REVIEW is admitted
 *     because the evidence rule parks a thin-evidence listing there, and under THIS user's
 *     MAXIMUM_PRICE rule that listing may well be a deal.
 *   - it is a deal under THIS USER'S rule, applied to the live aggregate (RULE_PREDICATE) -- the
 *     stored `t.verdict` is the frozen evidence rule's and is not consulted.
 *   - it was seen within NOTIFY_FRESH_SECONDS. A sighting of an unchanged listing refreshes
 *     `last_seen_at` at most once per HEARTBEAT_SECONDS, so a live listing can look up to 6 h old;
 *     the extra hour is margin for a late collector run.
 *   - it is selected by this user's searches (selection.ts, the verdicts.ts predicate).
 *   - it was seen in this user's AREA (`listing_markets`, the verdicts.ts membership term). Nothing
 *     deletes from `listings`, so without this a DEAL found in the old area would still alert for up
 *     to NOTIFY_FRESH_SECONDS after an area change. A NULL key (no area) matches nothing.
 *
 * THE NOT EXISTS RUNS BEFORE THE LIMIT, and that ordering is the anti-starvation property. With
 * the filter after the limit, the 20 newest DEALs -- already SENT -- would fill the window every
 * run and a 21st, new DEAL would never be enqueued. notify.test.ts N-starve pins it.
 *
 * ONLY CANCELLED RE-ARMS. NOT EXISTS excludes every listing with a non-CANCELLED row FOR THIS USER,
 * so the only conflict this INSERT can raise is against a CANCELLED row, and the `DO UPDATE ...
 * WHERE` says so a second time. SENT, DELIVERY_UNKNOWN and FAILED never come back on their own:
 * once is the contract (PLAN.md §6), and an unknown delivery is a human's call (the runbook's manual
 * resend). A re-armed row starts a fresh delivery -- attempts 0, no backoff, a new `created_at` --
 * and KEEPS `last_attempt_at` and `last_error`, which are what /api/status reads.
 *
 * Bindings: ?1 now, ?2 watched-type JSON, ?3 watched-pair JSON, ?4 freshness cutoff, ?5 limit,
 * ?6 the recent-evaluation cutoff, ?7 the user's area market key, ?8 user_id.
 */

import { SELECTION_PREDICATE } from "../api/verdicts";
import { REFERENCE_COUNT_SQL, REFERENCE_TOTAL_SQL, STATS_JOIN_KEYS } from "../evaluation/evaluateBatch";
import { areaMembership, RULE_PREDICATE } from "../evaluation/rulePredicate";
import { HEARTBEAT_SECONDS } from "../storage/types";
import type { NotifySelection } from "./selection";

/** The heartbeat window plus an hour. Imported, never written as a literal. */
export const NOTIFY_FRESH_SECONDS = HEARTBEAT_SECONDS + 3600;

/**
 * "NEW DEALS FROM NOW ON", NOT A BACKLOG. Enqueue (only -- the re-check does not test it) also
 * requires the task to have been JUDGED within the last day. Without it, turning alerts on would
 * send every fresh DEAL in the corpus, weeks-old listings included, 5 per run.
 *
 * WHY `evaluated_at` AND NOT `listings.first_seen_at`: a price change re-queues the task and the
 * drain re-judges it, so a price DROP on a listing first seen weeks ago is a newly judged DEAL and
 * still alerts -- and a row cancelled by that price change re-arms through this same statement.
 * A `first_seen_at` gate blocks both: measured, it turns N8 (cancel -> re-judge -> re-arm -> send)
 * red for a listing first seen 30 days earlier.
 *
 * OR THE USER RE-OPENED ALERTS WITHIN THE DAY (`users.alerts_reopened_at`, stamped by every watch
 * save and every rule change). The drain no longer re-judges anything when a user's rule, searches
 * or area change -- the rule is applied at read time -- so without this a rule loosened today would
 * never alert a deal judged yesterday. That is the user asking for them.
 *
 * What it does give up: a row cancelled because its listing went stale or was un-watched, which
 * becomes eligible again more than a day after its last judgment, does not re-arm.
 */
export const NOTIFY_RECENT_EVALUATION_SECONDS = 86_400;

/** How many candidates one run may enqueue. The send loop drains at most 5 per run. */
export const ENQUEUE_LIMIT = 20;

/**
 * The qualification test, over `l` listings, `t` evaluation_tasks, `u` users, `p` price_observations
 * and `s` model_stats, with `?2`/`?3` the selection, `?4` the freshness cutoff and `?7` the user's
 * area market key.
 */
export const CANDIDATE_PREDICATE = `l.validity = 'VALID'
   AND l.model_key IS NOT NULL
   AND t.status IN ('COMPLETE', 'NEEDS_REVIEW')
   AND l.last_seen_at >= ?4
   AND ${areaMembership("?7")}
   AND (${SELECTION_PREDICATE})
   AND ${RULE_PREDICATE}`;

/**
 * The joins CANDIDATE_PREDICATE reads. `users u CROSS JOIN listings l` pins the one user row as the
 * outer loop; `p` and `s` are the candidate read's own reference joins (evaluateBatch.ts).
 */
export const CANDIDATE_FROM = `FROM users u
 CROSS JOIN listings l
  JOIN evaluation_tasks t ON t.source = l.source AND t.listing_id = l.listing_id
  LEFT JOIN price_observations p
         ON p.source = l.source AND p.listing_id = l.listing_id
  LEFT JOIN model_stats s
         ON ${STATS_JOIN_KEYS}`;

export const ENQUEUE = `INSERT INTO user_notifications
       (user_id, source, listing_id, model_key, status, created_at, updated_at, attempts)
SELECT u.user_id, l.source, l.listing_id, l.model_key, 'PENDING', ?1, ?1, 0
  ${CANDIDATE_FROM}
 WHERE u.user_id = ?8
   AND ${CANDIDATE_PREDICATE}
   AND (t.evaluated_at >= ?6 OR u.alerts_reopened_at >= ?6)
   AND NOT EXISTS (SELECT 1 FROM user_notifications n
                    WHERE n.user_id = u.user_id
                      AND n.source = l.source AND n.listing_id = l.listing_id
                      AND n.status <> 'CANCELLED')
 ORDER BY t.evaluated_at DESC, l.listing_id
 LIMIT ?5
ON CONFLICT (user_id, source, listing_id) DO UPDATE
   SET status = 'PENDING', model_key = excluded.model_key, created_at = excluded.created_at,
       updated_at = excluded.updated_at, attempts = 0, next_attempt_at = NULL,
       lease_token = NULL, lease_expires_at = NULL, sent_price_cents = NULL, sent_at = NULL
 WHERE user_notifications.status = 'CANCELLED'`;

/** The reference expressions, re-exported for recheck.ts's message inputs. */
export { REFERENCE_COUNT_SQL, REFERENCE_TOTAL_SQL };

export const freshnessCutoff = (now: number): number => now - NOTIFY_FRESH_SECONDS;

/** Returns how many rows were inserted or re-armed. */
export const enqueueCandidates = async (
  db: D1Database,
  now: number,
  selection: NotifySelection,
  marketKey: string | null,
  userId: number,
): Promise<number> => {
  const result = await db
    .prepare(ENQUEUE)
    .bind(
      now,
      JSON.stringify(selection.all),
      JSON.stringify(selection.pairs),
      freshnessCutoff(now),
      ENQUEUE_LIMIT,
      now - NOTIFY_RECENT_EVALUATION_SECONDS,
      marketKey,
      userId,
    )
    .run();
  return result.meta.changes ?? 0;
};
