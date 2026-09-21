// @vitest-environment node

import { createTestDatabase, splitSqlStatements, type TestDatabase } from "../testing/d1";
import schemaSql from "../../migrations/0001_initial_storage.sql?raw";

let database!: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.dispose();
});

// Test 14 -- schema / migration.
describe("0001_initial_storage.sql", () => {
  it("creates exactly the four tables 3C exercises", async () => {
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
    ]);
  });

  it("creates the price_observations(last_seen_at) index cleanup depends on", async () => {
    const { results } = await database.db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
      .all<{ name: string }>();

    expect(results.map((row) => row.name)).toEqual(["price_observations_last_seen_at"]);
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

  it("splits the migration into four CREATE TABLEs and one CREATE INDEX", () => {
    const statements = splitSqlStatements(schemaSql);
    expect(statements).toHaveLength(5);
    expect(statements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(4);
    expect(statements.filter((statement) => statement.startsWith("CREATE INDEX"))).toHaveLength(1);
  });
});
