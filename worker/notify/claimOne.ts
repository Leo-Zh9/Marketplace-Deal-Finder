/**
 * CLAIM ONE DUE PENDING ROW, BEFORE ANY FETCH. evaluateBatch's CLAIM pattern, one row at a time.
 *
 * The claim is a single UPDATE: PENDING -> SENDING with a fresh lease token and a lease that ends
 * NOTIFY_LEASE_SECONDS after the run's `now`. Nothing is sent for a row that is not SENDING under
 * this execution's token, and every later write is fenced on that rowid AND that token.
 *
 * "Due" means `next_attempt_at` is NULL (never rate-limited) or not in the future. A rate-limited
 * row waiting out its `retry_after` is skipped, not queued behind, so it never delays a second
 * due row. Oldest `created_at` first; rowid breaks ties so the order is total.
 */

export const CLAIM_ONE = `UPDATE notifications
   SET status = 'SENDING', lease_token = ?1, lease_expires_at = ?2, updated_at = ?3
 WHERE rowid = (SELECT rowid FROM notifications
                 WHERE status = 'PENDING'
                   AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)
                 ORDER BY created_at, rowid
                 LIMIT 1)
RETURNING rowid AS row_id, source, listing_id, attempts`;

export interface ClaimedNotification {
  rowId: number;
  source: string;
  listingId: string;
  attempts: number;
}

export const claimOne = async (
  db: D1Database,
  input: { now: number; leaseSeconds: number; leaseToken: string },
): Promise<ClaimedNotification | null> => {
  const read = await db
    .prepare(CLAIM_ONE)
    .bind(input.leaseToken, input.now + input.leaseSeconds, input.now)
    .all<{ row_id: number; source: string; listing_id: string; attempts: number }>();
  const row = read.results[0];
  if (row === undefined) return null;
  return {
    rowId: row.row_id,
    source: row.source,
    listingId: row.listing_id,
    attempts: row.attempts,
  };
};
