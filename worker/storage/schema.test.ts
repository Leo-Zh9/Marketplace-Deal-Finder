// @vitest-environment node

import { createTestDatabase, splitSqlStatements, type TestDatabase } from "../testing/d1";
import schemaSql from "../../migrations/0001_initial_storage.sql?raw";
import evaluationSql from "../../migrations/0002_evaluation_tasks.sql?raw";

let database!: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.dispose();
});

// Test 14 -- schema / migration.
describe("0001_initial_storage.sql", () => {
  // Test S1. createTestDatabase applies 0001, 0002 AND 0003, so this asserts what the three
  // migrations together create and NOTHING ELSE: 0002 is purely additive and creates no
  // table of its own, and 0003 adds exactly the two 3E-a tables. A table nobody planned --
  // monitor_lock above all, which belongs to 3E-b and whose only reader is 3E-b's run lock
  // -- shows up here and nowhere else.
  it("creates exactly the six tables 0001, 0002 and 0003 define", async () => {
    // The filter is required: after the migration sqlite_master also holds D1's internal
    // _cf_METADATA and four sqlite_autoindex_* entries for the composite primary keys.
    const { results } = await database.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name",
      )
      .all<{ name: string }>();

    expect(results.map((row) => row.name)).toEqual([
      "evaluation_tasks",
      "listings",
      "model_stats",
      "price_observations",
      "search_revisions",
      "search_settings",
    ]);
  });

  // Test S2. The whole-database index list, asserted EXHAUSTIVELY and on purpose: an index
  // nobody planned is write amplification on every insert into the table it covers, and the
  // only way that shows up is as a failure here. 0001 owns price_observations_last_seen_at;
  // 0002 owns the three evaluation_tasks indexes (queue = tiers 1/2, attempt = tier 3,
  // revision = tier 4). createTestDatabase applies 0001, 0002 and 0003, so this is the list
  // a deployed database holds -- 0003 adds no index of its own, because both its primary
  // keys are INTEGER rowid aliases and SQLite builds no child-side index for a foreign key.
  it("creates exactly the 0001 and 0002 indexes, and no others", async () => {
    const { results } = await database.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
      .all<{ name: string }>();

    expect(results.map((row) => row.name)).toEqual([
      "evaluation_tasks_attempt",
      "evaluation_tasks_queue",
      "evaluation_tasks_revision",
      "price_observations_last_seen_at",
    ]);
  });

  it("stores no average: model_stats holds exactly the five spec columns", async () => {
    const { results } = await database.db
      .prepare("SELECT name, `notnull` FROM pragma_table_info('model_stats')")
      .all<{ name: string; notnull: number }>();

    expect(results.map((row) => row.name)).toEqual([
      "market_key",
      "model_key",
      "variant_key",
      "count",
      "total_price_cents",
    ]);
    // Every column NOT NULL -- variant_key above all. A nullable variant_key would stop the
    // primary key deduplicating, stop ON CONFLICT firing, and make every
    // `WHERE variant_key = ?` bound to NULL match zero rows.
    expect(results.every((row) => row.notnull === 1)).toBe(true);
  });

  it("requires variant_key NOT NULL on all three tables that carry it", async () => {
    for (const table of ["listings", "price_observations", "model_stats"]) {
      const { results } = await database.db
        .prepare("SELECT name, `notnull` FROM pragma_table_info(?1) WHERE name = 'variant_key'")
        .bind(table)
        .all<{ name: string; notnull: number }>();
      expect(results).toEqual([{ name: "variant_key", notnull: 1 }]);
    }
  });

  // Test S2b. THE CHECKS, EXHAUSTIVELY -- and this is a PRESENCE pin, not a behavioural one.
  // It says the lines are still in the file wrangler applies; it does NOT say any live path
  // reaches them. Measured, at master AND with this PR applied: deleting
  // `CHECK (total_price_cents >= 0)` or `CHECK (count > 0 OR total_price_cents = 0)` from 0001
  // leaves the ENTIRE suite green -- two of the three model_stats CHECKs are pinned by nothing
  // at all. They are the difference between a broken subtract/add pairing throwing and drifting
  // silently, SQLite cannot add or drop a CHECK in place, and 0001 is merged and about to be
  // applied: this is the last moment a deletion could be caught.
  //
  // Read from splitSqlStatements, not from the raw file, so a `CHECK (...)` written inside a
  // `--` comment cannot satisfy it.
  it("declares exactly these five CHECK constraints, and no others", () => {
    // Matched across the whole statement text, not line by line: 0003 already writes long
    // CHECKs over two lines, and a line-anchored pattern is BLIND to those -- a sixth CHECK
    // in that style would satisfy "and no others" while never being seen. The inner
    // alternation allows one level of nested parens, which is every CHECK in 0001 and 0003,
    // and the whitespace is normalised so a reformat does not read as a deletion.
    const checks = [
      ...splitSqlStatements(schemaSql)
        .join("\n")
        .matchAll(/\bCHECK\s*\(((?:[^()]|\([^()]*\))*)\)/g),
    ].map((match) => match[1].replace(/\s+/g, " ").trim());

    expect(checks).toEqual([
      "price_cents IS NULL OR price_cents >= 0",
      "price_cents >= 0",
      "count >= 0",
      "total_price_cents >= 0",
      "count > 0 OR total_price_cents = 0",
    ]);
  });

  it("splits the migration into four CREATE TABLEs and one CREATE INDEX", () => {
    const statements = splitSqlStatements(schemaSql);
    expect(statements).toHaveLength(5);
    expect(statements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(4);
    expect(statements.filter((statement) => statement.startsWith("CREATE INDEX"))).toHaveLength(1);
  });
});

// Phase 3D's additive migration. Same seam, same file-is-the-source-of-truth discipline.
describe("0002_evaluation_tasks.sql", () => {
  // Test S3.
  it("adds the five 3D columns to evaluation_tasks with the right nullability and defaults", async () => {
    const { results } = await database.db
      .prepare("SELECT name, `notnull`, dflt_value FROM pragma_table_info('evaluation_tasks')")
      .all<{ name: string; notnull: number; dflt_value: string | null }>();

    // The 3C four first, in their original order, then the 3D five in migration order.
    // ALTER TABLE ADD COLUMN appends, so this order is also the proof that 0002 did not
    // rebuild the table.
    expect(results.map((row) => row.name)).toEqual([
      "source",
      "listing_id",
      "status",
      "created_at",
      "evaluated_revision",
      "verdict",
      "evaluated_at",
      "lease_expires_at",
      "lease_token",
    ]);

    const column = (name: string) => results.find((row) => row.name === name);

    // lease_expires_at NOT NULL DEFAULT 0 is not stylistic. A NULL lease is never <= now,
    // so tier 2 could never re-claim the row and a crashed task would be stranded forever.
    expect(column("lease_expires_at")).toEqual({
      name: "lease_expires_at",
      notnull: 1,
      dflt_value: "0",
    });
    // lease_token NOT NULL DEFAULT '' so the fence compares two strings, never a NULL --
    // `lease_token = ?` against NULL matches zero rows and no completion would ever apply.
    expect(column("lease_token")).toEqual({
      name: "lease_token",
      notnull: 1,
      dflt_value: "''",
    });

    // These three must stay nullable. evaluated_revision NULL above all: it is the state
    // ALTER TABLE leaves on every task a database that already ran 3C holds, and tier 4's
    // `evaluated_revision IS NULL` term is what makes each of those eligible exactly once.
    for (const name of ["evaluated_revision", "verdict", "evaluated_at"]) {
      expect(column(name)).toEqual({ name, notnull: 0, dflt_value: null });
    }
  });

  // Test S4. The file itself, not the applied result: a destructive statement would still
  // leave the columns above in place on a fresh database while destroying a deployed one.
  it("is five ALTER TABLE ADD COLUMNs and three CREATE INDEXes, and nothing destructive", () => {
    const statements = splitSqlStatements(evaluationSql);

    expect(statements).toHaveLength(8);
    expect(
      statements.filter((statement) => /^ALTER TABLE evaluation_tasks ADD COLUMN /.test(statement)),
    ).toHaveLength(5);
    expect(statements.filter((statement) => statement.startsWith("CREATE INDEX"))).toHaveLength(3);

    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(DROP|CREATE TABLE|UPDATE|DELETE)\b/);
    }
  });
});
