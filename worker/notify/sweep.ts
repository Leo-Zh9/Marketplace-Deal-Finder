/**
 * SWEEP: A SENDING ROW WHOSE LEASE HAS EXPIRED BECOMES DELIVERY_UNKNOWN. Once, at step start.
 *
 * A row is SENDING only between its claim and its result write. If it is still SENDING after the
 * lease, the run that claimed it died somewhere in between -- possibly AFTER Discord accepted the
 * message. So it is never re-sent automatically; it goes to DELIVERY_UNKNOWN for a human to check
 * the channel (docs/phase-4-notifications.md, the manual resend).
 *
 * AN UNEXPIRED SENDING ROW IS LEFT ALONE, on purpose: a run that lost the monitor lock, or the
 * other execution of a retried step, may be mid-fetch on it right now.
 *
 * `last_attempt_at` and `last_error` are NOT touched: they record the last answer Discord gave,
 * and the sweep has no new answer.
 */

/** The SENDING lease. Far under the 30-minute cron period, far over one 10 s fetch. */
export const NOTIFY_LEASE_SECONDS = 600;

/** Every user's rows: an expired lease is an unknown delivery whoever it was for. */
export const SWEEP_EXPIRED = `UPDATE user_notifications
   SET status = 'DELIVERY_UNKNOWN', lease_token = NULL, lease_expires_at = NULL, updated_at = ?1
 WHERE status = 'SENDING' AND lease_expires_at < ?1`;

export const sweepExpiredLeases = async (db: D1Database, now: number): Promise<number> => {
  const result = await db.prepare(SWEEP_EXPIRED).bind(now).run();
  return result.meta.changes ?? 0;
};
