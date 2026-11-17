/**
 * THE NOTIFY STEP: sweep, read the selection, enqueue, then send at most MAX_SENDS_PER_STEP rows,
 * one at a time, each claimed before its fetch.
 *
 * NOTIFICATIONS=on IS THE MASTER SWITCH. Anything else returns before the first query, so an inert
 * step does no D1 work at all. With it on, the step runs for EVERY ACTIVE user that has a
 * destination (`destinationFor`: their own webhook, else for user 1 the DISCORD_WEBHOOK_URL secret).
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
 * EVERY ACTIVE USER, ROUND-ROBIN (multi-user PR3). A user who is not ACTIVE (worker/users/users.ts:
 * allowlisted and Started) gets nothing. A user with NO DESTINATION is skipped entirely -- no
 * enqueue, no claim -- so nothing is built that cannot be sent and their existing PENDING rows stay
 * PENDING; setting a webhook re-opens their alerts (worker/api/webhook.ts). The others are served
 * ONE CLAIM PER USER PER PASS, until MAX_SENDS_PER_STEP claims in total, so one user's backlog
 * cannot starve another. The pass starts at a different user each run (by `now`), so with a
 * sustained backlog no user is always last. A response that STOPS a step (429, 401/403/404, 5xx,
 * timeout -- classifyResponse) removes ONLY THAT USER from this step's rotation: one user's broken
 * webhook never blocks another user's sends.
 *
 * BUDGET, per step, worst case at MAX_USERS = 3: user read 1 + sweep 1 + 3 x (selection read,
 * enqueue) + at most one empty claim per user (3) + 5 x (claim, recheck, result-or-cancel) = 26
 * D1 queries, against 50 per invocation on Workers Free; at most 5 subrequests to Discord.
 * notifyCpu.test.ts N17 measures it. No unbounded loop: every iteration spends a claim or removes
 * a user.
 *
 * LOGGING: exactly one counts-only line per execution. Never a URL, a title, a token or an email.
 */

import { claimOne } from "./claimOne";
import { classifyResponse, type ResultKind } from "./classifyResponse";
import {
  destinationFor,
  notificationsOn,
  resolveNotifyConfig,
  type NotifyEnvironment,
  type NotifyState,
} from "./config";
import { deliver, NOTIFY_FETCH_TIMEOUT_MS, type NotifyFetch } from "./deliver";
import { enqueueCandidates } from "./enqueue";
import { formatMessage } from "./format";
import { cancelClaimed, recheck } from "./recheck";
import { readSelection } from "./selection";
import { areaMarketKey, loadActiveUsers, readAllowlist, type User } from "../users/users";
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
  /**
   * Where the users read's cost is spent, so a monitoring run's row-count telemetry stays exact for
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

interface Sender {
  user: User;
  url: string;
  selection: Awaited<ReturnType<typeof readSelection>>;
  marketKey: string | null;
}

export const runNotify = async (db: D1Database, input: NotifyInput): Promise<NotifyCounts> => {
  // THE MASTER SWITCH, before any query. The reported state keeps the single-user precedence so
  // an operator still reads "unconfigured" or "invalid-url" for a missing or bad secret.
  if (!notificationsOn(input.environment)) {
    const config = resolveNotifyConfig(input.environment);
    const inert = zeroCounts(config.state === "on" ? "off" : config.state);
    console.log(countsLine(inert));
    return inert;
  }

  const { now } = input;
  const maxSends = input.maxSends ?? MAX_SENDS_PER_STEP;
  const leaseSeconds = input.leaseSeconds ?? NOTIFY_LEASE_SECONDS;
  const counts = zeroCounts("on");

  // Read INSIDE the step, so a Stop pressed while this run was draining sends nothing: alerting
  // after a user pressed Stop is the one thing Stop promises not to do. A throwing allowlist fails
  // the step (DEGRADED).
  const allowlist = readAllowlist(input.environment);
  const active = await loadActiveUsers(db, allowlist);
  if (input.usage !== undefined) {
    input.usage.rowsRead += active.usage.rowsRead;
    input.usage.rowsWritten += active.usage.rowsWritten;
  }
  const destined = active.users.flatMap((user) => {
    const destination = destinationFor(user, input.environment);
    return destination.state === "ok" ? [{ user, url: destination.url }] : [];
  });
  if (destined.length === 0) {
    console.log(countsLine(counts));
    return counts;
  }

  counts.swept = await sweepExpiredLeases(db, now);
  const senders: Sender[] = [];
  for (const { user, url } of destined) {
    const selection = await readSelection(db, user.userId);
    // The same key the dashboard's read filters on: an alert is never sent for a listing that the
    // user's own page would not show.
    const marketKey = areaMarketKey(user.area);
    counts.enqueued += await enqueueCandidates(db, now, selection, marketKey, user.userId);
    senders.push({ user, url, selection, marketKey });
  }

  // THE ROTATION, starting at a different user each 30-minute run.
  const start = Math.floor(now / 1800) % senders.length;
  let rotation = [...senders.slice(start), ...senders.slice(0, start)];
  let claims = 0;
  while (claims < maxSends && rotation.length > 0) {
    for (const sender of [...rotation]) {
      if (claims >= maxSends) break;
      const userId = sender.user.userId;
      const leaseToken = `${input.leaseTokenPrefix}:${crypto.randomUUID()}`;
      const claimed = await claimOne(db, { now, leaseSeconds, leaseToken, userId });
      if (claimed === null) {
        rotation = rotation.filter((entry) => entry !== sender);
        continue;
      }
      claims += 1;

      const listing = await recheck(db, {
        now,
        selection: sender.selection,
        marketKey: sender.marketKey,
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
        sender.url,
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
      // ONLY THIS USER leaves the rotation: their webhook said stop, nobody else's did.
      if (result.stop) rotation = rotation.filter((entry) => entry !== sender);
    }
  }

  console.log(countsLine(counts));
  return counts;
};
