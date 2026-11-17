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
import collectorHealthSql from "../../migrations/0006_collector_health.sql?raw";
import notificationsSql from "../../migrations/0007_notifications.sql?raw";
import monitoringStateSql from "../../migrations/0008_monitoring_state.sql?raw";
import multiUserSql from "../../migrations/0009_multi_user.sql?raw";
import userWebhooksSql from "../../migrations/0010_user_webhooks.sql?raw";

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

/** User 1's email after `truncateAll`. In the allowlist every test environment builds. */
export const TEST_OWNER_EMAIL = "owner@example.com";

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
 * monitor_lock; without 0005, every watch-list test would fail on a missing watch_targets;
 * without 0006, every collector-health test would fail on a missing collector_health and S-n1
 * would report ten tables instead of eleven; without 0007, every notification test would fail on
 * a missing notifications table; without 0008, every monitoring-controls test would fail on a
 * missing monitoring_state and S1 would report twelve tables instead of thirteen.
 */
export const MIGRATIONS: readonly string[] = [
  schemaSql,
  evaluationSql,
  searchSql,
  monitorSql,
  watchTargetsSql,
  collectorHealthSql,
  notificationsSql,
  monitoringStateSql,
  multiUserSql,
  userWebhooksSql,
];

/**
 * `through` applies only the first N files -- the migration test (worker/storage/migration0009.test.ts)
 * builds a pre-0009 install, seeds it, measures it, and only then applies 0009.
 */
export const applyMigrations = async (
  db: D1Database,
  through: number = MIGRATIONS.length,
): Promise<void> => {
  for (const sql of MIGRATIONS.slice(0, through)) {
    await db.batch(splitSqlStatements(sql).map((statement) => db.prepare(statement)));
  }
};

export const createTestDatabase = async (
  through: number = MIGRATIONS.length,
): Promise<TestDatabase> => {
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
  await applyMigrations(db, through);

  return { db, dispose: () => mf.dispose() };
};

/**
 * One batch of DELETEs across every table, for `beforeEach` isolation.
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
    // DELETED, NOT RESTORED, AND THAT DIFFERS FROM monitor_lock FOR THE SAME REASON THE TWO
    // WATCH-LIST TABLES DO. monitor_lock's seed is load-bearing because the documented kill
    // switch is a bare `UPDATE ... WHERE id = 1`, a silent no-op against an empty table.
    // collector_health's only writer is an UPSERT, which creates the row it needs -- so the seed
    // is not load-bearing for any writer. Both states it distinguishes are EXPLICIT, tested ones:
    // no row at all reads as `unknown` with `collector: null` ("No collector run has reported
    // yet"), and the seeded `reported_at = 0` reads as `unknown` too (H-7). The SHIPPED seed's own
    // correctness is asserted by schema.test.ts S-n5, against a database this function never
    // touches.
    db.prepare("DELETE FROM collector_health"),
    // Phase 4. No seed, no foreign key: an ordinary delete.
    db.prepare("DELETE FROM notifications"),
    // 0009. Children before `users` (foreign keys are on), and user 1 is RESTORED -- claimed by
    // TEST_OWNER_EMAIL, monitoring on, with NO area and NO rule, the multi-user analogue of the
    // deleted watch_market and search_settings above: each test sets the area and rule it needs
    // (worker/testing/users.ts). The SHIPPED seed (email NULL) is asserted by schema.test.ts.
    db.prepare("DELETE FROM user_watch_targets"),
    db.prepare("DELETE FROM user_notifications"),
    db.prepare("DELETE FROM listing_markets"),
    db.prepare("DELETE FROM watch_cap_guard"),
    db.prepare("DELETE FROM users"),
    db.prepare(
      `INSERT INTO users (user_id, email, monitoring_enabled, monitoring_changed_at, created_at)
       VALUES (1, '${TEST_OWNER_EMAIL}', 1, 0, 0)`,
    ),
    db.prepare(
      `INSERT INTO monitor_lock (id, run_id, acquired_at, expires_at) VALUES (1, '', 0, 0)
       ON CONFLICT(id) DO UPDATE SET run_id = '', acquired_at = 0, expires_at = 0`,
    ),
    // RESET TO THE SEED, like monitor_lock and for a sharper reason: a test that stops
    // monitoring and leaves it stopped would turn every later runMonitor test in the same file
    // into a STOPPED run that drains nothing, and every watch-targets test into an empty list.
    db.prepare(
      `INSERT INTO monitoring_state (id, enabled, changed_at) VALUES (1, 1, 0)
       ON CONFLICT(id) DO UPDATE SET enabled = 1, changed_at = 0`,
    ),
  ]);
};
