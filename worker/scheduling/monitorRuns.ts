/**
 * The monitoring run log: one durable row per run, pruned to a fixed window.
 *
 * WHY A TABLE AND NOT THE INSTANCE OUTPUT. `wrangler workflows instances describe` answers
 * "what did THAT run do"; it expires, and it needs someone watching. The question this phase
 * actually has to answer at 3am is "what have the last 48 runs been doing", and only a table
 * answers it. There is no alerting until Phase 4.
 *
 * Style follows worker/storage/: SQL as module constants, plain functions taking `db` first,
 * no clock, no platform imports.
 */

import type { D1Usage } from "../storage/types";

/**
 * 7 days x 48 runs/day, matching STALE_AFTER_SECONDS -- a week of history is the window every
 * other retention decision in this system already uses.
 *
 * I CREATE THIS TABLE, SO ITS GROWTH IS MINE TO BOUND. `listings` and `evaluation_tasks` grow
 * unbounded and neither is this PR's to fix; `monitor_runs` would be a table this PR adds and
 * never bounds, which is a different thing entirely.
 */
export const MONITOR_RUN_RETENTION = 336;

/**
 * ?1..?24, in column order.
 *
 * ON CONFLICT(run_id) DO UPDATE, not a bare INSERT. A replayed finalize -- the platform
 * redelivering an instance, or a step body retried after its write landed -- would otherwise
 * raise a UNIQUE violation, and D1 rolls back THE WHOLE BATCH on a failing statement, taking
 * the prune and the lock release with it. The upsert makes the replay idempotent instead.
 */
export const INSERT_RUN = `INSERT INTO monitor_runs
  (run_id, scheduled_at, started_at, finished_at, status, search_revision, sources,
   sources_truncated, selected_components, request_count, result_count, new_count,
   changed_count, unchanged_count, claimed_count, evaluation_count, evaluation_error_count,
   discarded_count, batches, steps_used, step_failures, rows_read, rows_written, errors)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
          ?19, ?20, ?21, ?22, ?23, ?24)
ON CONFLICT(run_id) DO UPDATE SET
  scheduled_at=excluded.scheduled_at, started_at=excluded.started_at,
  finished_at=excluded.finished_at, status=excluded.status,
  search_revision=excluded.search_revision, sources=excluded.sources,
  sources_truncated=excluded.sources_truncated,
  selected_components=excluded.selected_components, request_count=excluded.request_count,
  result_count=excluded.result_count, new_count=excluded.new_count,
  changed_count=excluded.changed_count, unchanged_count=excluded.unchanged_count,
  claimed_count=excluded.claimed_count, evaluation_count=excluded.evaluation_count,
  evaluation_error_count=excluded.evaluation_error_count,
  discarded_count=excluded.discarded_count, batches=excluded.batches,
  steps_used=excluded.steps_used, step_failures=excluded.step_failures,
  rows_read=excluded.rows_read, rows_written=excluded.rows_written, errors=excluded.errors`;

/**
 * ?1 retentionRuns. run_seq is a rowid alias, so this is a rowid range delete:
 * `SEARCH monitor_runs USING INTEGER PRIMARY KEY (rowid<?)`, measured at 4 rows read /
 * 1 written in steady state.
 *
 * `<=` and not `<`: at retention 9 over 14 runs the survivors are run-5 .. run-13, exactly 9.
 * The off-by-one leaves 10.
 */
export const PRUNE_RUNS = `DELETE FROM monitor_runs
 WHERE run_seq <= (SELECT MAX(run_seq) FROM monitor_runs) - ?1`;

/**
 * The previous run's status, read at finalize BEFORE the insert.
 *
 * This is monitor_runs' in-code reader, and it is what makes the table more than a log
 * nobody opens: the instance output of ANY SINGLE RUN then distinguishes a blip from the
 * 400th consecutive NO_SETTINGS.
 */
export const PREVIOUS_RUN = `SELECT status FROM monitor_runs ORDER BY run_seq DESC LIMIT 1`;

export interface MonitorRunRecord {
  runId: string;
  scheduledAt: number;
  startedAt: number;
  finishedAt: number;
  status: string;
  searchRevision: number | null;
  /** JSON array. OPAQUE: nothing here enumerates or branches on a source name. */
  sources: string[];
  sourcesTruncated: boolean;
  selectedComponents: string[];
  requestCount: number;
  resultCount: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  claimedCount: number;
  evaluationCount: number;
  evaluationErrorCount: number;
  discardedCount: number;
  batches: number;
  stepsUsed: number;
  stepFailures: number;
  rowsRead: number;
  rowsWritten: number;
  errors: string[];
}

export interface PreviousRun {
  status: string;
}

/**
 * ONE COLUMN, because one column is read. `finished_at` was in this SELECT and nothing consumed
 * it -- committed surface with no reader is the thing this repo refuses elsewhere, and the row
 * is already in hand if a later phase wants more of it.
 */
export const readPreviousRun = async (
  db: D1Database,
): Promise<{ previous: PreviousRun | null; usage: D1Usage }> => {
  const read = await db.prepare(PREVIOUS_RUN).all<{ status: string }>();
  const usage: D1Usage = { rowsRead: read.meta.rows_read, rowsWritten: read.meta.rows_written };
  const row = read.results[0];
  if (row === undefined) return { previous: null, usage };
  return { previous: { status: row.status }, usage };
};

/**
 * The insert and the prune, as STATEMENTS. The caller puts them in ONE db.batch together
 * with the fenced lock release, because a single db.batch is the only atomicity primitive D1
 * offers and a run that records itself without releasing -- or releases without recording --
 * is the state telemetry exists to prevent.
 */
export const recordMonitorRun = (
  db: D1Database,
  record: MonitorRunRecord,
  retentionRuns: number,
): D1PreparedStatement[] => [
  db
    .prepare(INSERT_RUN)
    .bind(
      record.runId,
      record.scheduledAt,
      record.startedAt,
      record.finishedAt,
      record.status,
      record.searchRevision,
      JSON.stringify(record.sources),
      record.sourcesTruncated ? 1 : 0,
      JSON.stringify(record.selectedComponents),
      record.requestCount,
      record.resultCount,
      record.newCount,
      record.changedCount,
      record.unchangedCount,
      record.claimedCount,
      record.evaluationCount,
      record.evaluationErrorCount,
      record.discardedCount,
      record.batches,
      record.stepsUsed,
      record.stepFailures,
      record.rowsRead,
      record.rowsWritten,
      JSON.stringify(record.errors),
    ),
  db.prepare(PRUNE_RUNS).bind(retentionRuns),
];
