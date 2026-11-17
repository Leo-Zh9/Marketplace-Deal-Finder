/**
 * RE-CHECK ONE CLAIMED ROW AGAINST THE ENQUEUE PREDICATE, AND READ WHAT THE MESSAGE NEEDS.
 *
 * Same `CANDIDATE_PREDICATE` as enqueue.ts, for this one listing. Any failure -- the price
 * changed so the task was re-queued, the task is no longer a DEAL, the revision moved, the
 * listing went stale, the user stopped watching it, the model was lost, the saved market moved
 * away from the one it was collected in -- CANCELS the row. There
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

import { CANDIDATE_PREDICATE, freshnessCutoff } from "./enqueue";
import type { NotifySelection } from "./selection";

export const RECHECK = `SELECT l.model_key, l.title, l.price_cents, l.location_text, l.last_seen_at,
       sr.mode, sr.minimum_discount_percent, sr.maximum_price_cents,
       wm.radius_km,
       CASE WHEN p.listing_id IS NULL THEN s.count
            ELSE s.count - 1 END                               AS reference_count,
       CASE WHEN p.listing_id IS NULL THEN s.total_price_cents
            ELSE s.total_price_cents - p.price_cents END        AS reference_total_cents
  FROM listings l
  JOIN evaluation_tasks t ON t.source = l.source AND t.listing_id = l.listing_id
  JOIN search_settings ss ON ss.id = 1
  JOIN search_revisions sr ON sr.revision = ss.current_revision
  LEFT JOIN watch_market wm ON wm.id = 1
  LEFT JOIN price_observations p
         ON p.source = l.source AND p.listing_id = l.listing_id
  LEFT JOIN model_stats s
         ON s.market_key  = COALESCE(p.market_key,  l.market_key)
        AND s.model_key   = COALESCE(p.model_key,   l.model_key)
        AND s.variant_key = COALESCE(p.variant_key, l.variant_key)
 WHERE l.source = ?5 AND l.listing_id = ?6
   AND ${CANDIDATE_PREDICATE}`;

export const CANCEL = `UPDATE notifications
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
  minimum_discount_percent: number | null;
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
      // ?7, which CANDIDATE_PREDICATE names: the saved market key. NULL matches nothing, so a
      // claimed row with no market to check against is cancelled.
      input.marketKey,
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
    minimumDiscountPercent: row.minimum_discount_percent,
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
