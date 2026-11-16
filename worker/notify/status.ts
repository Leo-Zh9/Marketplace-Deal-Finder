/**
 * THE `notifications` FIELD OF `/api/status`. Additive: nothing else in that body changes.
 *
 * In `unconfigured`, `invalid-url` and `off` the body is `{state}` alone and THE TABLE IS NOT
 * QUERIED -- so a deploy that lands ahead of migration 0007 still answers 200.
 *
 * In `on` it carries the counts, and `state` becomes `webhook-rejected` IF AND ONLY IF the row
 * with the latest `last_attempt_at` (any status) has `last_error LIKE 'webhook-rejected%'`. That
 * says exactly what was measured: the most recent answer Discord gave was a rejection.
 *   - A later 2xx clears it by being newer. A cancel cannot erase it: cancels, sweeps and
 *     re-arms never write `last_attempt_at` or `last_error`.
 *   - With nothing PENDING nothing probes, so the state stays `webhook-rejected` until the next
 *     deal tests the webhook again.
 *   - TIES. Rows written in one step share the run's `now`. A rejection stops the step, so within
 *     one execution the rejected row is the last fetch -- and the tie-break therefore prefers the
 *     rejected row. That is the order the answers actually arrived in.
 *
 * `pending` counts PENDING and SENDING (in flight). `lastSentAt` is epoch seconds or null.
 * A read failure answers `{state: "on"}` without counts rather than failing the route.
 */

import { resolveNotifyConfig, type NotifyEnvironment, type NotifyState } from "./config";

export const SENT_WINDOW_SECONDS = 86_400;

export const SELECT_NOTIFY_STATUS = `SELECT
  (SELECT COUNT(*) FROM notifications WHERE status IN ('PENDING', 'SENDING'))   AS pending,
  (SELECT COUNT(*) FROM notifications WHERE status = 'SENT' AND sent_at >= ?1)  AS sent_24h,
  (SELECT COUNT(*) FROM notifications WHERE status = 'DELIVERY_UNKNOWN')        AS delivery_unknown,
  (SELECT COUNT(*) FROM notifications WHERE status = 'FAILED')                  AS failed,
  (SELECT MAX(sent_at) FROM notifications WHERE status = 'SENT')                AS last_sent_at,
  (SELECT COALESCE(last_error, '') LIKE 'webhook-rejected%' FROM notifications
    WHERE last_attempt_at IS NOT NULL
    ORDER BY last_attempt_at DESC, COALESCE(last_error, '') LIKE 'webhook-rejected%' DESC
    LIMIT 1)                                                                    AS rejected`;

export type NotificationsStatus =
  | { state: Exclude<NotifyState, "on" | "webhook-rejected"> }
  | { state: "on" }
  | {
      state: "on" | "webhook-rejected";
      pending: number;
      sent24h: number;
      deliveryUnknown: number;
      failed: number;
      lastSentAt: number | null;
    };

interface StatusRow {
  pending: number;
  sent_24h: number;
  delivery_unknown: number;
  failed: number;
  last_sent_at: number | null;
  rejected: number | null;
}

export const readNotificationsStatus = async (
  db: D1Database | undefined,
  environment: NotifyEnvironment,
  now: number,
): Promise<NotificationsStatus> => {
  const config = resolveNotifyConfig(environment);
  if (config.state !== "on") return { state: config.state };
  if (db === undefined) return { state: "on" };

  let row: StatusRow | undefined;
  try {
    const read = await db.prepare(SELECT_NOTIFY_STATUS).bind(now - SENT_WINDOW_SECONDS).all<StatusRow>();
    row = read.results[0];
  } catch {
    console.warn("status: the notifications table could not be read");
    return { state: "on" };
  }
  if (row === undefined) return { state: "on" };

  return {
    state: row.rejected === 1 ? "webhook-rejected" : "on",
    pending: row.pending,
    sent24h: row.sent_24h,
    deliveryUnknown: row.delivery_unknown,
    failed: row.failed,
    lastSentAt: row.last_sent_at,
  };
};
