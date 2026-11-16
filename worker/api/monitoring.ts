/**
 * MONITORING START/STOP: one singleton row (migrations/0008) that three readers honour.
 *
 *   - `GET /api/watch-targets` answers `monitoring: "stopped"` with an empty list, and the
 *     collector exits 0 without searching (collector/runTargets.ts).
 *   - `runMonitor` reads it inside its `load-settings` step and records STOPPED, skipping the
 *     drain and the notify step.
 *   - `GET /api/status` reports it, and a stopped install reads `status: "stopped"` rather than
 *     whatever the collector last said -- a deliberately paused collector going stale is not a
 *     fault.
 *
 * Nothing else changes when monitoring is stopped: the cleanup cron, ingest, `/api/watch` and the
 * notifications rows all carry on. It is not the 3am kill switch (the monitor_lock HOLD in
 * docs/phase-3e-monitoring.md); this one needs a deployed Worker that knows the row exists.
 *
 * The handlers return a RESULT, never a Response, like every other file in worker/api/:
 * worker/index.ts owns the headers and the error envelope.
 */

import type { CollectorStatusBody } from "./collectorHealth";
import { loadCurrentSettings } from "../search/settings";
import type { D1Usage } from "../storage/types";

export interface MonitoringState {
  state: "running" | "stopped";
  /** Unix seconds of the last real change. 0 means it has never been changed (the seed). */
  changedAt: number;
}

export type MonitoringResult =
  | { ok: true; status: 200; body: { monitoring: MonitoringState } }
  | { ok: false; status: number; code: string };

const SELECT = `SELECT enabled, changed_at FROM monitoring_state WHERE id = 1`;

/**
 * IDEMPOTENT BY CONSTRUCTION: `changed_at` moves only when `enabled` does, so a second Stop keeps
 * the instant of the first and the page's "Stopped at 14:38" does not drift on a double click.
 * In `DO UPDATE` the table-qualified column is the EXISTING row and `excluded.` the proposed one,
 * and every SET expression reads the pre-update values, so the CASE sees the old `enabled`.
 */
const UPSERT = `INSERT INTO monitoring_state (id, enabled, changed_at) VALUES (1, ?1, ?2)
  ON CONFLICT(id) DO UPDATE SET
    enabled = excluded.enabled,
    changed_at = CASE WHEN monitoring_state.enabled = excluded.enabled
      THEN monitoring_state.changed_at ELSE excluded.changed_at END
  RETURNING enabled, changed_at`;

interface StateRow {
  enabled: number;
  changed_at: number;
}

/** ONLY an explicit 0 stops anything. An absent row is the running seed. */
const fromRow = (row: StateRow | undefined): MonitoringState =>
  row === undefined
    ? { state: "running", changedAt: 0 }
    : { state: row.enabled === 0 ? "stopped" : "running", changedAt: row.changed_at };

/**
 * THE READ THAT THROWS, with its cost. `runMonitor` spends `usage` so the run's own row-count
 * telemetry stays exact, and `/api/watch-targets` lets a throw reach its existing 503 -- answering
 * "running" on a failed read would be a guess, and answering "stopped" would be a silent stop.
 */
export const loadMonitoringState = async (
  db: D1Database,
): Promise<{ monitoring: MonitoringState; usage: D1Usage }> => {
  const read = await db.prepare(SELECT).all<StateRow>();
  return {
    monitoring: fromRow(read.results[0]),
    usage: { rowsRead: read.meta.rows_read, rowsWritten: read.meta.rows_written },
  };
};

/**
 * THE READ THAT NEVER THROWS, for `/api/status`. `null` for a missing binding or a failed read,
 * and then nothing is overridden: the one endpoint that reports health must not go dark, and it
 * must not claim "stopped" (or "running") on a read it could not make.
 */
export const readMonitoring = async (
  db: D1Database | undefined,
): Promise<MonitoringState | null> => {
  if (db === undefined) return null;
  try {
    return (await loadMonitoringState(db)).monitoring;
  } catch {
    return null;
  }
};

export type StatusWithMonitoring = Omit<CollectorStatusBody, "status"> & {
  status: CollectorStatusBody["status"] | "stopped";
  monitoring: MonitoringState | null;
};

/**
 * STOPPED OUTRANKS EVERY HEALTH WORD, AND CLEARS THE CAUSES. A stopped collector goes stale by
 * design and its last run's causes describe a run the operator has since paused; showing
 * "Degraded" or "No recent run" beside a Stop they pressed would train them to ignore the badge.
 * `reportedAt`, `ageMinutes` and `collector` stay, so the page still says when the last run was.
 */
export const applyMonitoring = (
  health: CollectorStatusBody,
  monitoring: MonitoringState | null,
): StatusWithMonitoring =>
  monitoring?.state === "stopped"
    ? { ...health, status: "stopped", causes: [], monitoring }
    : { ...health, monitoring };

const write = async (db: D1Database, enabled: 0 | 1, now: number): Promise<MonitoringResult> => {
  const written = await db.prepare(UPSERT).bind(enabled, now).all<StateRow>();
  return { ok: true, status: 200, body: { monitoring: fromRow(written.results[0]) } };
};

/**
 * START NEEDS A DEAL RULE, AND NOTHING ELSE. With no settings every monitoring run records
 * NO_SETTINGS and drains nothing, so "Started" would be a claim the system cannot keep. 409 with
 * the row unchanged; there is no initial run -- the collector and the cron pick it up on their
 * next fire.
 */
export const handleStartMonitoring = async (
  db: D1Database,
  now: number,
): Promise<MonitoringResult> => {
  try {
    const current = await loadCurrentSettings(db);
    if (current.settings === null) {
      return { ok: false, status: 409, code: "MONITORING_NOT_READY" };
    }
    return await write(db, 1, now);
  } catch {
    return { ok: false, status: 503, code: "MONITORING_STORAGE_FAILED" };
  }
};

export const handleStopMonitoring = async (
  db: D1Database,
  now: number,
): Promise<MonitoringResult> => {
  try {
    return await write(db, 0, now);
  } catch {
    return { ok: false, status: 503, code: "MONITORING_STORAGE_FAILED" };
  }
};
