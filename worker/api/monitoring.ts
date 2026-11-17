/**
 * MONITORING START/STOP, PER USER (migrations/0009: `users.monitoring_enabled`). Three readers honour
 * it, through the one definition of ACTIVE in worker/users/users.ts (allowlisted AND enabled):
 *
 *   - `GET /api/watch-targets` hands the collector only ACTIVE users' searches, and answers
 *     `monitoring: "stopped"` with an empty list only when NO user is active.
 *   - `runMonitor` records STOPPED, skipping the drain and the notify step, only when no user is
 *     active; the notify step sends nothing for a user who is not.
 *   - `GET /api/status` reports the CALLER's own state, and a stopped caller reads `status:
 *     "stopped"` rather than whatever the collector last said.
 *
 * `monitoring_state` (0008) is kept for rollback and read by nothing.
 *
 * The handlers return a RESULT, never a Response, like every other file in worker/api/:
 * worker/index.ts owns the headers and the error envelope.
 */

import type { CollectorStatusBody } from "./collectorHealth";
import type { User } from "../users/users";

export interface MonitoringState {
  state: "running" | "stopped";
  /** Unix seconds of the last real change. 0 means it has never been changed (the seed). */
  changedAt: number;
}

export type MonitoringResult =
  | { ok: true; status: 200; body: { monitoring: MonitoringState } }
  | { ok: false; status: number; code: string };

/**
 * IDEMPOTENT BY CONSTRUCTION, and SCOPED TO THE CALLER: `monitoring_changed_at` moves only when
 * `monitoring_enabled` does, so a second Stop keeps the instant of the first and the page's
 * "Stopped at 14:38" does not drift on a double click. Every SET expression reads the pre-update
 * row, so the CASE sees the old value. ?1 enabled, ?2 now, ?3 user_id.
 */
const SET_ENABLED = `UPDATE users
   SET monitoring_enabled = ?1,
       monitoring_changed_at = CASE WHEN monitoring_enabled = ?1
         THEN monitoring_changed_at ELSE ?2 END
 WHERE user_id = ?3
RETURNING monitoring_enabled, monitoring_changed_at`;

interface StateRow {
  monitoring_enabled: number;
  monitoring_changed_at: number;
}

export const monitoringOf = (user: User): MonitoringState => ({
  state: user.monitoringEnabled ? "running" : "stopped",
  changedAt: user.monitoringChangedAt,
});

export type StatusWithMonitoring = Omit<CollectorStatusBody, "status"> & {
  status: CollectorStatusBody["status"] | "stopped";
  monitoring: MonitoringState | null;
};

/**
 * STOPPED OUTRANKS EVERY HEALTH WORD, AND CLEARS THE CAUSES. A stopped collector goes stale by
 * design and its last run's causes describe a run the operator has since paused; showing
 * "Degraded" or "No recent run" beside a Stop they pressed would train them to ignore the badge.
 * `reportedAt`, `ageMinutes` and `collector` stay, so the page still says when the last run was.
 *
 * `status-unreadable` SURVIVES THE STOP. It is not a fault of the paused run but a fact about this
 * read: the health row could not be seen. Clearing it would leave `collector: null` and no cause,
 * which the panel reads as "No collector run has reported yet" -- false. M-9.
 */
export const applyMonitoring = (
  health: CollectorStatusBody,
  monitoring: MonitoringState | null,
): StatusWithMonitoring =>
  monitoring?.state === "stopped"
    ? {
        ...health,
        status: "stopped",
        causes: health.causes.filter((cause) => cause === "status-unreadable"),
        monitoring,
      }
    : { ...health, monitoring };

const write = async (
  db: D1Database,
  user: User,
  enabled: 0 | 1,
  now: number,
): Promise<MonitoringResult> => {
  const written = await db.prepare(SET_ENABLED).bind(enabled, now, user.userId).all<StateRow>();
  const row = written.results[0];
  if (row === undefined) return { ok: false, status: 503, code: "MONITORING_STORAGE_FAILED" };
  return {
    ok: true,
    status: 200,
    body: {
      monitoring: {
        state: row.monitoring_enabled === 0 ? "stopped" : "running",
        changedAt: row.monitoring_changed_at,
      },
    },
  };
};

/**
 * START NEEDS THE CALLER'S DEAL RULE, AND NOTHING ELSE. Without one nothing could ever be judged a
 * deal for them, so "Started" would be a claim the system cannot keep. 409 with the row unchanged.
 * The rule was read by provisioning in this request, so the check costs no read.
 */
export const handleStartMonitoring = async (
  db: D1Database,
  user: User,
  now: number,
): Promise<MonitoringResult> => {
  if (user.rule === null) return { ok: false, status: 409, code: "MONITORING_NOT_READY" };
  try {
    return await write(db, user, 1, now);
  } catch {
    return { ok: false, status: 503, code: "MONITORING_STORAGE_FAILED" };
  }
};

export const handleStopMonitoring = async (
  db: D1Database,
  user: User,
  now: number,
): Promise<MonitoringResult> => {
  try {
    return await write(db, user, 0, now);
  } catch {
    return { ok: false, status: 503, code: "MONITORING_STORAGE_FAILED" };
  }
};
