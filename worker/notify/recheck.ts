/**
 * RE-CHECK ONE CLAIMED ROW AGAINST THE ENQUEUE PREDICATE, AND READ WHAT THE MESSAGE NEEDS.
 *
 * Same `CANDIDATE_PREDICATE` as enqueue.ts, for this one listing and the CLAIMED ROW'S USER. Any
 * failure -- the price changed so the task was re-queued, the listing is no longer a deal under the
 * user's rule against today's aggregate, the listing went stale, the user stopped watching it, the
 * model was lost, the user's area moved away from every area it was seen in -- CANCELS the row. There
 * is no fetch for a cancelled row.
 *
 * NEVER HOLD. A held row would need its own wake-up rule; a cancelled row already has one:
 * enqueue re-arms CANCELLED the next time the listing is again COMPLETE + DEAL + current
 * revision + fresh + selected, and it then sends at the price the drain just judged.
 *
 * The same read carries the message's inputs, so the alert is built from the state that passed
 * the check -- current price, the current revision's rule, the current aggregate -- and not from
 * anything remembered at enqueue time. The aggregate is computed exactly as verdicts.ts computes
 * it, excluding the candidate's own observation.
 *
 * The cancel keeps `last_attempt_at` and `last_error`: a rejection recorded earlier stays the
 * latest Discord answer (status.ts), and a cancel is not an answer.
 */

import {
  CANDIDATE_FROM,
  CANDIDATE_PREDICATE,
  freshnessCutoff,
  REFERENCE_COUNT_SQL,
  REFERENCE_TOTAL_SQL,
} from "./enqueue";
import type { NotifySelection } from "./selection";

/**
 * The claimed user's rule and area travel in the SAME read (`u`), so the message states the rule
 * the listing just passed and the user's own radius -- never another user's, and never the retired
 * `watch_market` singleton. ?1 now (unused by the predicate), ?2/?3 selection, ?4 freshness cutoff,
 * ?5 source, ?6 listing_id, ?7 the user's area market key, ?8 user_id.
 */
export const RECHECK = `SELECT l.model_key, l.title, l.price_cents, l.location_text, l.last_seen_at,
       u.mode, u.minimum_discount_bp, u.maximum_price_cents, u.radius_km,
       ${REFERENCE_COUNT_SQL}                                   AS reference_count,
       ${REFERENCE_TOTAL_SQL}                                   AS reference_total_cents
  ${CANDIDATE_FROM}
 WHERE u.user_id = ?8 AND l.source = ?5 AND l.listing_id = ?6
   AND ${CANDIDATE_PREDICATE}`;

/** Fenced on rowid and token, exactly as before; the rowid is a user_notifications rowid. */
export const CANCEL = `UPDATE user_notifications
   SET status = 'CANCELLED', lease_token = NULL, lease_expires_at = NULL, updated_at = ?1
 WHERE rowid = ?2 AND status = 'SENDING' AND lease_token = ?3`;

export interface RecheckedListing {
  modelKey: string;
  title: string;
  priceCents: number | null;
  locationText: string | null;
  lastSeenAt: number;
  mode: "DISCOUNT" | "MAXIMUM_PRICE" | "BOTH";
  minimumDiscountPercent: number | null;
  maximumPriceCents: number | null;
  radiusKm: number | null;
  referenceCount: number | null;
  referenceTotalCents: number | null;
}

interface RecheckRow {
  model_key: string;
  title: string;
  price_cents: number | null;
  location_text: string | null;
  last_seen_at: number;
  mode: "DISCOUNT" | "MAXIMUM_PRICE" | "BOTH";
  minimum_discount_bp: number | null;
  maximum_price_cents: number | null;
  radius_km: number | null;
  reference_count: number | null;
  reference_total_cents: number | null;
}

/** The listing as it now stands, or null when it no longer qualifies. */
export const recheck = async (
  db: D1Database,
  input: {
    now: number;
    selection: NotifySelection;
    marketKey: string | null;
    userId: number;
    source: string;
    listingId: string;
  },
): Promise<RecheckedListing | null> => {
  const read = await db
    .prepare(RECHECK)
    .bind(
      input.now,
      JSON.stringify(input.selection.all),
      JSON.stringify(input.selection.pairs),
      freshnessCutoff(input.now),
      input.source,
      input.listingId,
      // ?7, which CANDIDATE_PREDICATE names: the user's area key. NULL matches nothing, so a
      // claimed row with no area to check against is cancelled.
      input.marketKey,
      input.userId,
    )
    .all<RecheckRow>();
  const row = read.results[0];
  if (row === undefined) return null;
  return {
    modelKey: row.model_key,
    title: row.title,
    priceCents: row.price_cents,
    locationText: row.location_text,
    lastSeenAt: row.last_seen_at,
    mode: row.mode,
    // Exact for every legal value (worker/api/settings.ts wireRule).
    minimumDiscountPercent: row.minimum_discount_bp === null ? null : row.minimum_discount_bp / 100,
    maximumPriceCents: row.maximum_price_cents,
    radiusKm: row.radius_km,
    referenceCount: row.reference_count,
    referenceTotalCents: row.reference_total_cents,
  };
};

export const cancelClaimed = async (
  db: D1Database,
  input: { now: number; rowId: number; leaseToken: string },
): Promise<void> => {
  await db.prepare(CANCEL).bind(input.now, input.rowId, input.leaseToken).run();
};
