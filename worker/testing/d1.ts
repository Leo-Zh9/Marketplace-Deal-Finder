/**
 * The offline D1 test seam. Tests must run with no network and no remote database,
 * so they boot a Miniflare worker whose only purpose is to own a local D1 instance
 * and apply the real migration file to it.
 */

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import schemaSql from "../../migrations/0001_initial_storage.sql?raw";
import evaluationSql from "../../migrations/0002_evaluation_tasks.sql?raw";
import searchSql from "../../migrations/0003_search_settings.sql?raw";

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
 * a missing table.
 */
export const applyMigrations = async (db: D1Database): Promise<void> => {
  for (const sql of [schemaSql, evaluationSql, searchSql]) {
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
 * One batch of DELETEs across all six tables, for `beforeEach` isolation.
 *
 * search_settings BEFORE search_revisions, and that is not style. D1 runs with
 * `PRAGMA foreign_keys = 1`, search_settings.current_revision REFERENCES
 * search_revisions.revision, and a failing statement rolls the WHOLE batch back -- so the
 * other order raises `FOREIGN KEY constraint failed` and truncates nothing.
 */
export const truncateAll = async (db: D1Database): Promise<void> => {
  await db.batch([
    db.prepare("DELETE FROM evaluation_tasks"),
    db.prepare("DELETE FROM price_observations"),
    db.prepare("DELETE FROM model_stats"),
    db.prepare("DELETE FROM listings"),
    db.prepare("DELETE FROM search_settings"),
    db.prepare("DELETE FROM search_revisions"),
  ]);
};
