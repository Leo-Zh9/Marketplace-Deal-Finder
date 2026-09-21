/**
 * The offline D1 test seam. Tests must run with no network and no remote database,
 * so they boot a Miniflare worker whose only purpose is to own a local D1 instance
 * and apply the real migration file to it.
 */

import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import schemaSql from "../../migrations/0001_initial_storage.sql?raw";

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

  // db.batch, never db.exec: exec splits the string on newlines and runs each line as
  // a statement, so a pretty-printed CREATE TABLE fails with `incomplete input`.
  await db.batch(splitSqlStatements(schemaSql).map((statement) => db.prepare(statement)));

  return { db, dispose: () => mf.dispose() };
};

/** One batch of DELETEs across all four tables, for `beforeEach` isolation. */
export const truncateAll = async (db: D1Database): Promise<void> => {
  await db.batch([
    db.prepare("DELETE FROM evaluation_tasks"),
    db.prepare("DELETE FROM price_observations"),
    db.prepare("DELETE FROM model_stats"),
    db.prepare("DELETE FROM listings"),
  ]);
};
