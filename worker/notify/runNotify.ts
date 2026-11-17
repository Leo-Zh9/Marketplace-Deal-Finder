/**
 * THE NOTIFY STEP: sweep, read the selection, enqueue, then send at most MAX_SENDS_PER_STEP rows,
 * one at a time, each claimed before its fetch.
 *
 * INERT STATES DO NO D1 WORK. `unconfigured`, `invalid-url` and `off` return before the first
 * query, so a Worker deployed ahead of migration 0007 runs every other step exactly as before.
 *
 * WHY A RETRY OF THIS STEP CANNOT RESEND. The Workflow retries a failed step once
 * (MONITOR_STEP_CONFIG), and the retry runs with the SAME `now` -- the run's fixed `params.now`.
 *   1. A row is claimed (PENDING -> SENDING, `lease_expires_at = now + 600`) BEFORE its fetch.
 *   2. If anything throws after the claim -- the fetch's result write, say -- the row stays
 *      SENDING. The retry's claim selects only PENDING rows, so it cannot pick it up.
 *   3. The retry's sweep moves SENDING rows only when `lease_expires_at < now`, and with `now`
 *      frozen that is `now + 600 < now`: false. So it cannot release it either.
 *   4. The next run, 30 minutes later, has `now' > now + 600` and sweeps the row to
 *      DELIVERY_UNKNOWN -- never back to PENDING. A human decides whether to resend.
 * Rows that were still PENDING behind the failure are untouched by it and the retry sends them.
 *
 * ONE USER PER STEP IN PR2 (migrations/0009): the owner, `OWNER_USER_ID`, through the owner's
 * fallback webhook DISCORD_WEBHOOK_URL -- exactly today's behaviour. A user who is not ACTIVE
 * (worker/users/users.ts: allowlisted and Started) gets nothing, and the step then makes no other
 * D1 query: that is the single-user STOPPED skip, per user. PR3 adds the round-robin over users.
 *
 * BUDGET, per step, worst case: user read 1 + sweep 1 + selection read 1 + enqueue 1 + 5 x
 * (claim, recheck, result-or-cancel) = 19 D1 queries, against 50 per invocation on Workers Free;
 * at most 5 subrequests to Discord. No unbounded loop: every iteration spends a claim.
 *
 * LOGGING: exactly one counts-only line per execution. Never the URL, a title or a token.
 */

import { claimOne } from "./claimOne";
import { classifyResponse, type ResultKind } from "./classifyResponse";
import { resolveNotifyConfig, type NotifyEnvironment, type NotifyState } from "./config";
import { deliver, NOTIFY_FETCH_TIMEOUT_MS, type NotifyFetch } from "./deliver";
import { enqueueCandidates } from "./enqueue";
import { formatMessage } from "./format";
import { cancelClaimed, recheck } from "./recheck";
import { readSelection } from "./selection";
import { areaMarketKey, isActive, loadUser, OWNER_USER_ID, readAllowlist } from "../users/users";
import { NOTIFY_LEASE_SECONDS, sweepExpiredLeases } from "./sweep";
import type { D1Usage } from "../storage/types";

export const MAX_SENDS_PER_STEP = 5;

/**
 * The result write, fenced on the rowid AND the lease token this execution claimed with: a row
 * swept or re-claimed by anyone else is not overwritten. `sent_at` / `sent_price_cents` are only
 * ever SET (COALESCE keeps them otherwise), and `last_attempt_at` is written on every outcome.
 */
export const WRITE_RESULT = `UPDATE user_notifications
   SET status = ?1, attempts = attempts + ?2, next_attempt_at = ?3, last_attempt_at = ?4,
       last_error = ?5, sent_at = COALESCE(?6, sent_at),
       sent_price_cents = COALESCE(?7, sent_price_cents),
       lease_token = NULL, lease_expires_at = NULL, updated_at = ?4
 WHERE rowid = ?8 AND status = 'SENDING' AND lease_token = ?9`;

export interface NotifyCounts {
  state: Exclude<NotifyState, "webhook-rejected">;
  swept: number;
  enqueued: number;
  sent: number;
  rateLimited: number;
  rejected: number;
  failed: number;
  unknown: number;
  cancelled: number;
  /**
   * Result writes that changed 0 rows: the row was no longer SENDING under this token -- an
   * overlapping run swept it (to DELIVERY_UNKNOWN) or re-claimed it while this fetch was in
   * flight. The fetch's outcome is then NOT recorded. It cannot cause a duplicate on its own, but a
   * delivered message can sit as DELIVERY_UNKNOWN, which is why the runbook says to check the
   * channel before any manual resend.
   */
  unrecorded: number;
}

export interface NotifyInput {
  /** APPROVED_EMAILS decides who is ACTIVE; see worker/users/users.ts. */
  environment: NotifyEnvironment & { APPROVED_EMAILS?: string };
  /** Whose alerts this step sends. PR2: always the owner. */
  userId?: number;
  /**
   * Where the user read's cost is spent, so a monitoring run's row-count telemetry stays exact for
   * the read that decides whether the step does anything at all (runMonitor R-s5).
   */
  usage?: D1Usage;
  now: number;
  fetch: NotifyFetch;
  /** Prefixed onto each claim's fresh UUID so a stranded SENDING row names its run. */
  leaseTokenPrefix: string;
  maxSends?: number;
  leaseSeconds?: number;
  timeoutMs?: number;
}

export const zeroCounts = (state: NotifyCounts["state"]): NotifyCounts => ({
  state,
  swept: 0,
  enqueued: 0,
  sent: 0,
  rateLimited: 0,
  rejected: 0,
  failed: 0,
  unknown: 0,
  cancelled: 0,
  unrecorded: 0,
});

const COUNT_FOR: Record<ResultKind, Exclude<keyof NotifyCounts, "state" | "unrecorded">> = {
  sent: "sent",
  "rate-limited": "rateLimited",
  rejected: "rejected",
  failed: "failed",
  unknown: "unknown",
};

export const countsLine = (counts: NotifyCounts): string =>
  `notify state=${counts.state} enqueued=${counts.enqueued} sent=${counts.sent} ` +
  `unknown=${counts.unknown} cancelled=${counts.cancelled} failed=${counts.failed} ` +
  `rate_limited=${counts.rateLimited} rejected=${counts.rejected} swept=${counts.swept} ` +
  `unrecorded=${counts.unrecorded}`;

export const runNotify = async (db: D1Database, input: NotifyInput): Promise<NotifyCounts> => {
  const config = resolveNotifyConfig(input.environment);
  if (config.state !== "on") {
    const inert = zeroCounts(config.state);
    console.log(countsLine(inert));
    return inert;
  }

  const { now } = input;
  const userId = input.userId ?? OWNER_USER_ID;
  const maxSends = input.maxSends ?? MAX_SENDS_PER_STEP;
  const leaseSeconds = input.leaseSeconds ?? NOTIFY_LEASE_SECONDS;
  const counts = zeroCounts("on");

  // AFTER the inert return above, so an inert step still makes no D1 query. Read INSIDE the step,
  // so a Stop pressed while this run was draining sends nothing: alerting after the user pressed
  // Stop is the one thing Stop promises not to do. A throwing allowlist fails the step (DEGRADED).
  const allowlist = readAllowlist(input.environment);
  const user = await loadUser(db, userId, input.usage);
  if (user === null || !isActive(user, allowlist)) {
    console.log(countsLine(counts));
    return counts;
  }

  counts.swept = await sweepExpiredLeases(db, now);
  const selection = await readSelection(db, userId);
  // The same key the dashboard's read filters on: an alert is never sent for a listing that the
  // user's own page would not show.
  const marketKey = areaMarketKey(user.area);
  counts.enqueued = await enqueueCandidates(db, now, selection, marketKey, userId);

  for (let index = 0; index < maxSends; index += 1) {
    const leaseToken = `${input.leaseTokenPrefix}:${crypto.randomUUID()}`;
    const claimed = await claimOne(db, { now, leaseSeconds, leaseToken, userId });
    if (claimed === null) break;

    const listing = await recheck(db, {
      now,
      selection,
      marketKey,
      userId,
      source: claimed.source,
      listingId: claimed.listingId,
    });
    if (listing === null) {
      await cancelClaimed(db, { now, rowId: claimed.rowId, leaseToken });
      counts.cancelled += 1;
      continue;
    }

    const content = formatMessage({ listingId: claimed.listingId, listing, now });
    const outcome = await deliver(
      input.fetch,
      config.url,
      content,
      input.timeoutMs ?? NOTIFY_FETCH_TIMEOUT_MS,
    );
    const result = classifyResponse(outcome, claimed.attempts, now);
    const sent = result.status === "SENT";

    const written = await db
      .prepare(WRITE_RESULT)
      .bind(
        result.status,
        result.countsAttempt ? 1 : 0,
        result.nextAttemptAt,
        now,
        result.lastError,
        sent ? now : null,
        sent ? listing.priceCents : null,
        claimed.rowId,
        leaseToken,
      )
      .run();

    counts[COUNT_FOR[result.kind]] += 1;
    if ((written.meta.changes ?? 0) === 0) {
      counts.unrecorded += 1;
      // Counts only: no URL, title or token.
      console.warn(`notify result write changes=0 outcome=${result.kind}`);
    }
    if (result.stop) break;
  }

  console.log(countsLine(counts));
  return counts;
};
