/**
 * The offline D1 test seam. Tests must run with no network and no remote database,
 * so they boot a Miniflare worker whose only purpose is to own a local D1 instance
 * and apply the real migration file to it.
 */

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import schemaSql from "../../migrations/0001_initial_storage.sql?raw";
import evaluationSql from "../../migrations/0002_evaluation_tasks.sql?raw";
import searchSql from "../../migrations/0003_search_settings.sql?raw";
import monitorSql from "../../migrations/0004_monitor.sql?raw";
import watchTargetsSql from "../../migrations/0005_watch_targets.sql?raw";

/**
 * Strip `--` line comments, split on `;`, trim, drop empties. The schema contains no
 * `;` inside a literal. The migration file is the single source of truth: tests apply
 * the exact file wrangler applies.
 */
export const splitSqlStatements = (sql: string): string[] =>
  sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

export interface TestDatabase {
  db: D1Database;
  dispose: () => Promise<void>;
}

/**
 * Every migration file, in wrangler's order, through one mechanism.
 *
 * db.batch, never db.exec: exec splits the string on newlines and runs each line as a
 * statement, so a pretty-printed CREATE TABLE fails with `incomplete input`.
 *
 * THIS LIST IS THE ONE PLACE A NEW MIGRATION IS ADDED. Both test seams -- this file's
 * createTestDatabase and workerBundle.ts's workerd-hosted worker -- call it, so they cannot
 * drift apart. Without 0002 here, every 3D test would run against an evaluation_tasks table
 * with none of the evaluation columns; without 0003, every 3E-a settings test would fail on
 * a missing table; without 0004, every 3E-b monitoring test would fail on a missing
 * monitor_lock; without 0005, every watch-list test would fail on a missing watch_targets.
 */
export const applyMigrations = async (db: D1Database): Promise<void> => {
  for (const sql of [schemaSql, evaluationSql, searchSql, monitorSql, watchTargetsSql]) {
    await db.batch(splitSqlStatements(sql).map((statement) => db.prepare(statement)));
  }
};

export const createTestDatabase = async (): Promise<TestDatabase> => {
  // Miniflare 5 rejects the flat v4 options object ("workers: undefined ... expected
  // array"); convertV4MiniflareOptions is the exported compat helper for it.
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch(){ return new Response('ok'); } }",
      compatibilityDate: "2026-09-11",
      d1Databases: { DB: "test" },
    }),
  );

  await mf.ready;
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(db);

  return { db, dispose: () => mf.dispose() };
};

/**
 * One batch of DELETEs across all ten tables, for `beforeEach` isolation.
 *
 * search_settings BEFORE search_revisions, and that is not style. D1 runs with
 * `PRAGMA foreign_keys = 1`, search_settings.current_revision REFERENCES
 * search_revisions.revision, and a failing statement rolls the WHOLE batch back -- so the
 * other order raises `FOREIGN KEY constraint failed` and truncates nothing.
 *
 * monitor_lock is RESET, not deleted. 0004 seeds `(1, '', 0, 0)` because the documented kill
 * switch is a write to that row and, against an empty table, a bare UPDATE is a silent no-op
 * -- so a truncate that left the table empty would reintroduce, in every test after the first,
 * exactly the state the seed exists to prevent. The upsert restores the seed even when a test
 * deleted the row on purpose.
 *
 * THE TWO WATCH-LIST TABLES ARE DELETED, NOT RESTORED, AND THAT DIFFERS FROM monitor_lock FOR A
 * REASON. monitor_lock's seed is load-bearing: the documented kill switch is a bare
 * `UPDATE ... WHERE id = 1`, which against an empty table is a silent no-op. NEITHER watch-list
 * seed is load-bearing for any test -- no code path degrades quietly when they are absent;
 * `market: null` and an empty `targets` array are both explicit, tested states (W-4, W-5, L-6).
 * So they are deleted for ordinary isolation and each test inserts what it needs. The SHIPPED
 * seed's own correctness is asserted by schema.test.ts S7c, which runs against a database this
 * function never touches.
 */
export const truncateAll = async (db: D1Database): Promise<void> => {
  await db.batch([
    db.prepare("DELETE FROM evaluation_tasks"),
    db.prepare("DELETE FROM price_observations"),
    db.prepare("DELETE FROM model_stats"),
    db.prepare("DELETE FROM listings"),
    db.prepare("DELETE FROM search_settings"),
    db.prepare("DELETE FROM search_revisions"),
    db.prepare("DELETE FROM monitor_runs"),
    db.prepare("DELETE FROM watch_targets"),
    db.prepare("DELETE FROM watch_market"),
    db.prepare(
      `INSERT INTO monitor_lock (id, run_id, acquired_at, expires_at) VALUES (1, '', 0, 0)
       ON CONFLICT(id) DO UPDATE SET run_id = '', acquired_at = 0, expires_at = 0`,
    ),
  ]);
};
