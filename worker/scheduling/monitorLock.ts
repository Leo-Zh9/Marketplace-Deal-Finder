/**
 * The monitoring run lock: mutual exclusion between monitoring runs, with a lease so a
 * crashed run frees it without anyone intervening.
 *
 * Style follows worker/storage/ and worker/evaluation/: SQL as module constants, plain
 * functions taking `db` first, no clock (the caller passes `now`), no platform imports.
 *
 * WHAT THIS LOCK IS. It bounds wasted work and gives LOCK_LOST somewhere to be reported.
 * IT IS ADVISORY AND NOT AN ATOMICITY PRIMITIVE: `monitorLockHeld` and the work that
 * follows it are two D1 round trips with a real window between them, and `step.do`
 * guarantees at-most-once, not indivisibility. The only atomicity primitive D1 offers is a
 * single db.batch, and everything that must be indivisible lives in one.
 *
 * The drain does not need this lock for correctness: `evaluateBatch` fences every completion
 * on a per-claim lease_token and its claim is a single atomic UPDATE ... RETURNING, so two
 * concurrent drains claim disjoint sets. For the drain the lock buys duplicated work avoided
 * and spec compliance, not correctness.
 */

import type { D1Usage } from "../storage/types";

/**
 * The lease. THE CEILING IS INCLUSIVE AND THAT IS THE WHOLE ARGUMENT: ACQUIRE_LOCK's
 * predicate is `expires_at <= ?now`, so a crashed run holding a lease of exactly the Cron
 * period is still displaced by the next fire. Measured, crashed run at T and the next fire at
 * T+1800: leases 900, 1500, 1799 and 1800 are all displaced; 1801 and 2000 are not. The
 * entire interval (0, 1800] therefore costs ZERO skipped fires, so anything below 1800 is
 * free headroom and 900 forfeited it for nothing.
 *
 * WHAT THE LOWER BOUND BUYS: NOTHING REACHABLE. Every contender this system can produce is a
 * cron fire at `T + 1800k`, so for every lease in [1, 1800] the predicate is identically true --
 * 900 and 1500 are indistinguishable on every cron-reachable path, a redelivery and a step retry
 * carry the same scheduledTime, and LOCK_HELD has no expiry term so a short lease never
 * self-aborts. 1500 is not SAFER than 900; 900 is dominated, not wrong. Only the upper bound has
 * a consequence, and monitorLock.test.ts L9 is what pins it -- upward only.
 *
 * 1500 takes the headroom with 300s of cushion so nothing depends on hitting the inclusive
 * boundary exactly -- and the cushion is not decoration: `now` is controller.scheduledTime,
 * not the instant the run starts, so CRON DELIVERY DELAY IS SUBTRACTED FROM THE LEASE. A run
 * delivered five minutes late is protected for 1,200s, not 1,500.
 */
export const MONITOR_LOCK_SECONDS = 1500;

/**
 * ?1 runId, ?2 now, ?3 now + lockSeconds.
 *
 * Every clause is a distinct measured cell (first acquire / a different run while unexpired /
 * the same run re-entering / a different run at exactly expires_at):
 *
 *   as written                      1  0  1  1
 *   DO UPDATE with no WHERE         1  1  1  1   <- a second run steals a live lock
 *   drop `OR run_id = ?1`           1  0  0  1   <- a retried step body locks itself out
 *   `<=` becomes `<`                1  0  1  0   <- a crashed run skips a fire
 *
 * `OR monitor_lock.run_id = ?1` is what makes acquisition RE-ENTRANT for the same instance.
 * A step body that throws and is retried, an instance replayed from a later step and a
 * platform redelivery all re-acquire and proceed; without it the retry sees its own lock and
 * reports SKIPPED_LOCKED -- a healthy run permanently converted to a no-op.
 *
 * RETURNING, not meta.changes. Both work -- contention measures `results: []` AND
 * `changes: 0`, no error -- but RETURNING also hands back the row for telemetry in one round
 * trip and does not depend on how D1 reports `changes` for a suppressed upsert.
 */
export const ACQUIRE_LOCK = `INSERT INTO monitor_lock (id, run_id, acquired_at, expires_at) VALUES (1, ?1, ?2, ?3)
ON CONFLICT(id) DO UPDATE SET run_id=?1, acquired_at=?2, expires_at=?3
 WHERE monitor_lock.expires_at <= ?2 OR monitor_lock.run_id = ?1
RETURNING run_id, acquired_at, expires_at`;

/**
 * The advisory fence. ?1 runId.
 *
 * NO EXPIRY TERM, on purpose. `now` is frozen at the run's scheduled instant and a run's own
 * expires_at is `now + lockSeconds` with lockSeconds >= 1, so `expires_at > now` holds for
 * the holder throughout its own run: an `AND expires_at > ?2` term is unreachable by
 * construction, a line no mutation could kill. It would also be WRONG: a run whose lease has
 * lapsed but whose lock NOBODY HAS TAKEN would abort for nothing and discard its work over a
 * contention that never happened. The lease is enforced at ACQUIRE_LOCK, where the
 * contender's `now` is a later instant, and nowhere else.
 */
export const LOCK_HELD = `SELECT run_id FROM monitor_lock WHERE id = 1 AND run_id = ?1`;

/**
 * The release, FENCED on the holder. ?1 runId.
 *
 * Unfenced (`WHERE id = 1` alone), a zombie's release reports changes 1 and wipes the live
 * holder's row -- measured. Fenced, it reports changes 0 and the holder is untouched, which
 * is what lets SKIPPED_LOCKED and LOCK_LOST put the release in their finalize batch
 * unconditionally.
 *
 * acquired_at is deliberately LEFT INTACT. "The lock was released" is otherwise satisfied by
 * "it was never acquired"; a surviving acquired_at is what distinguishes them.
 */
export const RELEASE_LOCK = `UPDATE monitor_lock SET expires_at = 0, run_id = '' WHERE id = 1 AND run_id = ?1`;

export interface LockHolder {
  runId: string;
  acquiredAt: number;
  expiresAt: number;
}

interface LockRow {
  run_id: string;
  acquired_at: number;
  expires_at: number;
}

export const acquireMonitorLock = async (
  db: D1Database,
  input: { runId: string; now: number; lockSeconds: number },
): Promise<{ acquired: boolean; holder: LockHolder | null; usage: D1Usage }> => {
  // `>= 1`, not `>= 0`, and it is load-bearing: at 0 the lease is exactly `now`, a second run
  // at the same `now` satisfies `expires_at <= ?2`, and the lock is stolen immediately.
  if (!Number.isSafeInteger(input.lockSeconds) || input.lockSeconds < 1) {
    throw new Error(
      `acquireMonitorLock: lockSeconds must be a safe integer >= 1: ${input.lockSeconds}`,
    );
  }

  const result = await db
    .prepare(ACQUIRE_LOCK)
    .bind(input.runId, input.now, input.now + input.lockSeconds)
    .all<LockRow>();

  const usage: D1Usage = {
    rowsRead: result.meta.rows_read,
    rowsWritten: result.meta.rows_written,
  };
  const row = result.results[0];
  if (row === undefined) {
    return { acquired: false, holder: null, usage };
  }
  return {
    acquired: true,
    holder: { runId: row.run_id, acquiredAt: row.acquired_at, expiresAt: row.expires_at },
    usage,
  };
};

export const monitorLockHeld = async (db: D1Database, runId: string): Promise<boolean> => {
  const held = await db.prepare(LOCK_HELD).bind(runId).all<{ run_id: string }>();
  return held.results.length === 1;
};

/**
 * Exported as a STATEMENT, not as a function that runs it, so `runMonitor` can put the
 * release inside the finalize db.batch -- one transaction with the telemetry insert and the
 * prune -- and so tests re-issue the BYTE-IDENTICAL statement rather than a hand copy that
 * would not carry a mutation applied here. Same discipline as `completionStatement`.
 */
export const releaseStatement = (db: D1Database, runId: string): D1PreparedStatement =>
  db.prepare(RELEASE_LOCK).bind(runId);
