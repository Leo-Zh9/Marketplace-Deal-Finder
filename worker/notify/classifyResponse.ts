/**
 * WHAT A DELIVERY OUTCOME MEANS FOR THE ROW. Pure: no clock, no I/O.
 *
 *   2xx                  SENT. `sent_at`, `sent_price_cents`; `last_error` cleared.
 *   429                  PENDING until now + ceil(retry_after); counts an attempt; stops the step.
 *                        The sixth 429 (attempts would exceed MAX_ATTEMPTS) is FAILED instead.
 *   401 / 403 / 404      PENDING, NOT counted: the webhook was deleted or its token is wrong, so
 *                        the row is not at fault. `last_error = 'webhook-rejected:<status>'`;
 *                        stops the step. The next run probes again with one message -- one probe
 *                        per run, at most 48 a day -- until a 2xx clears it.
 *   other 1xx/3xx/4xx    FAILED, with the status (and Discord's JSON code when there is one). A
 *                        400 is this message being refused; sending it again would be refused again.
 *   5xx, timeout,        DELIVERY_UNKNOWN, never re-sent automatically. Discord may have posted
 *   network error        the message before failing, and a rare lost alert is better than a
 *                        duplicate. Also stops the step: the next row would face the same outage.
 *
 * Any response with `X-RateLimit-Remaining: 0` stops the step after this row is recorded.
 */

import type { DeliveryOutcome } from "./deliver";

/** 429s tolerated per arming. The next one is FAILED. */
export const MAX_ATTEMPTS = 5;

/** A Retry-After we cannot read waits a minute; one we can is capped at a day. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;
export const MAX_RETRY_AFTER_SECONDS = 86_400;

export type ResultKind = "sent" | "rate-limited" | "rejected" | "failed" | "unknown";

export interface Classification {
  kind: ResultKind;
  status: "SENT" | "PENDING" | "FAILED" | "DELIVERY_UNKNOWN";
  /** Whether this outcome adds one to `attempts`. */
  countsAttempt: boolean;
  nextAttemptAt: number | null;
  lastError: string | null;
  /** Stop the send loop after recording this row. */
  stop: boolean;
}

export const classifyResponse = (
  outcome: DeliveryOutcome,
  attemptsBefore: number,
  now: number,
): Classification => {
  if (outcome.kind === "timeout" || outcome.kind === "network") {
    return {
      kind: "unknown",
      status: "DELIVERY_UNKNOWN",
      countsAttempt: true,
      nextAttemptAt: null,
      lastError: outcome.kind === "timeout" ? "timeout" : "network-error",
      stop: true,
    };
  }

  const { status } = outcome;

  if (status >= 200 && status < 300) {
    return {
      kind: "sent",
      status: "SENT",
      countsAttempt: true,
      nextAttemptAt: null,
      lastError: null,
      stop: outcome.bucketEmpty,
    };
  }

  if (status === 429) {
    if (attemptsBefore + 1 > MAX_ATTEMPTS) {
      return {
        kind: "failed",
        status: "FAILED",
        countsAttempt: true,
        nextAttemptAt: null,
        lastError: "rate-limited:attempts-exhausted",
        stop: true,
      };
    }
    const wait = Math.min(
      MAX_RETRY_AFTER_SECONDS,
      Math.max(1, Math.ceil(outcome.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS)),
    );
    return {
      kind: "rate-limited",
      status: "PENDING",
      countsAttempt: true,
      nextAttemptAt: now + wait,
      lastError: "rate-limited",
      stop: true,
    };
  }

  if (status === 401 || status === 403 || status === 404) {
    return {
      kind: "rejected",
      status: "PENDING",
      countsAttempt: false,
      nextAttemptAt: null,
      lastError: `webhook-rejected:${status}`,
      stop: true,
    };
  }

  if (status >= 500) {
    return {
      kind: "unknown",
      status: "DELIVERY_UNKNOWN",
      countsAttempt: true,
      nextAttemptAt: null,
      lastError: `server-error:${status}`,
      stop: true,
    };
  }

  return {
    kind: "failed",
    status: "FAILED",
    countsAttempt: true,
    nextAttemptAt: null,
    lastError:
      outcome.errorCode === null ? `refused:${status}` : `refused:${status}:${outcome.errorCode}`,
    stop: outcome.bucketEmpty,
  };
};
