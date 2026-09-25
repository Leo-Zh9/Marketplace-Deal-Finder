// @vitest-environment node

import { createTestDatabase, splitSqlStatements, type TestDatabase } from "../testing/d1";
import schemaSql from "../../migrations/0001_initial_storage.sql?raw";
import evaluationSql from "../../migrations/0002_evaluation_tasks.sql?raw";
import monitorSql from "../../migrations/0004_monitor.sql?raw";
import watchSql from "../../migrations/0005_watch_targets.sql?raw";
import { COMPONENT_TYPES } from "../api/listings";

/**
 * Every CHECK in `sql`, innermost text only, whitespace normalised.
 *
 * DELIBERATELY NOT A REGEX, and the reason is the point of the test that uses it. A regex has
 * to bound how deeply it will count parentheses, and whatever bound it picks, a constraint
 * nested one level deeper is INVISIBLE to it -- so a test named "and no others" passes while
 * an unplanned, applied constraint sits in the file. Two bounded patterns were tried and both
 * failed that way: a line-anchored one missed the two-line CHECKs `0003` already writes, and a
 * one-level-nesting one missed `CHECK ((a) OR ((b)))`. A balanced scan has no bound and no
 * such case.
 *
 * `splitSqlStatements` has already stripped `--` comments, so a CHECK written inside a comment
 * cannot reach this. Whitespace is collapsed so that reformatting a constraint across lines
 * does not read as a deletion.
 */
const extractChecks = (sql: string): string[] => {
  const checks: string[] = [];
  const opener = /\bCHECK\s*\(/g;
  let match = opener.exec(sql);
  while (match !== null) {
    const start = match.index + match[0].length;
    let cursor = start;
    let depth = 1;
    while (cursor < sql.length && depth > 0) {
      if (sql[cursor] === "(") depth += 1;
      else if (sql[cursor] === ")") depth -= 1;
      cursor += 1;
    }
    // `depth > 0` here would mean unbalanced SQL, which cannot be applied at all; the slice
    // then runs to end-of-input and the assertion fails loudly, which is the right outcome.
    checks.push(sql.slice(start, cursor - 1).replace(/\s+/g, " ").trim());
    opener.lastIndex = cursor;
    match = opener.exec(sql);
  }
  return checks;
};

let database!: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.dispose();
});

// Test 14 -- schema / migration.
describe("0001_initial_storage.sql", () => {
  // Test S1'. createTestDatabase applies 0001 through 0005, so this asserts what the five
  // migrations together create and NOTHING ELSE: 0002 is purely additive and creates no
  // table of its own, 0003 adds exactly the two 3E-a tables, 0004 adds exactly the two
  // 3E-b ones, and 0005 adds exactly the two watch-list ones. monitor_lock used to be named
  // here as the table that would show up if someone created it early; it is 3E-b's now, it has
  // a reader (the run lock's ACQUIRE_LOCK and LOCK_HELD, every run), and a table nobody planned
  // still shows up here and nowhere else.
  it("creates exactly the ten tables 0001 through 0005 define", async () => {
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
      "monitor_lock",
      "monitor_runs",
      "price_observations",
      "search_revisions",
      "search_settings",
      "watch_market",
      "watch_targets",
    ]);
  });

  // Test S2. The whole-database index list, asserted EXHAUSTIVELY and on purpose: an index
  // nobody planned is write amplification on every insert into the table it covers, and the
  // only way that shows up is as a failure here. 0001 owns price_observations_last_seen_at;
  // 0002 owns the three evaluation_tasks indexes (queue = tiers 1/2, attempt = tier 3,
  // revision = tier 4). createTestDatabase applies 0001, 0002 and 0003, so this is the list
  // a deployed database holds -- 0003 adds no index of its own, because both its primary
  // keys are INTEGER rowid aliases and SQLite builds no child-side index for a foreign key.
  // 0004 adds none either, and that is MEASURED rather than assumed: monitor_runs.run_seq is a
  // rowid alias, and its `run_id TEXT UNIQUE` creates sqlite_autoindex_monitor_runs_1, whose
  // `sql IS NULL` -- so it is invisible to this query by the same rule that hides the composite
  // primary keys. 0005 adds none by THE SAME RULE, measured: watch_targets' TEXT PRIMARY KEY
  // creates sqlite_autoindex_watch_targets_1 whose `sql IS NULL`, and watch_market.id is an
  // INTEGER rowid alias. THE LIST BELOW NOT CHANGING IS ITSELF THE ASSERTION.
  // The list below is byte-for-byte the one master returns.
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
  // "AND NO OTHERS" IS MEANT LITERALLY, which is why `extractChecks` is a balanced scan rather
  // than a pattern -- see its docstring. An unplanned constraint added to 0001 shows up here
  // whatever its nesting or line breaks, and a deletion shows up as a missing entry.
  it("declares exactly these five CHECK constraints, and no others", () => {
    const checks = extractChecks(splitSqlStatements(schemaSql).join("\n"));

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

/**
 * Phase 3E-b's additive migration. Patterned off the 0002 block above -- applied column shapes
 * through pragma_table_info, plus a file-level assertion that the file itself is additive,
 * because a destructive statement would still leave the right columns on a FRESH database
 * while destroying a deployed one. (There is no 0003 block: 0003's tables are covered by S1
 * and by settings.test.ts.)
 */
describe("0004_monitor.sql", () => {
  // Test S5.
  it("creates monitor_lock as a singleton with the four lock columns, all NOT NULL", async () => {
    const { results } = await database.db
      .prepare("SELECT name, `notnull`, pk FROM pragma_table_info('monitor_lock')")
      .all<{ name: string; notnull: number; pk: number }>();

    expect(results.map((row) => row.name)).toEqual([
      "id",
      "run_id",
      "acquired_at",
      "expires_at",
    ]);
    // run_id NOT NULL above all: RELEASE_LOCK writes '' and the fence compares two strings.
    // `lease_token = ?` against NULL matches zero rows, and so would `run_id = ?`.
    expect(results.every((row) => row.notnull === 1)).toBe(true);
    expect(results.find((row) => row.name === "id")?.pk).toBe(1);
  });

  // Test S6. The seed row, and it is not tidiness: the documented kill switch is a write to
  // this row, and monitorLock.test.ts L10 measures what a bare UPDATE does when it is absent.
  it("seeds monitor_lock with the inert free row, and refuses a second", async () => {
    const { results } = await database.db
      .prepare("SELECT id, run_id, acquired_at, expires_at FROM monitor_lock")
      .all();

    expect(results).toEqual([{ id: 1, run_id: "", acquired_at: 0, expires_at: 0 }]);

    // CHECK (id = 1) is the schema saying EXACTLY ONE MONITORING RUN MAY MUTATE AT A TIME.
    await expect(
      database.db.prepare("INSERT INTO monitor_lock VALUES (2, '', 0, 0)").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  // Test S7. monitor_runs' columns, in order, with the two nullable ones named. Column ORDER
  // is load-bearing: INSERT_RUN binds 24 positional parameters against this list.
  it("creates monitor_runs with the spec's fields, and only search_revision nullable", async () => {
    const { results } = await database.db
      .prepare("SELECT name, `notnull` FROM pragma_table_info('monitor_runs')")
      .all<{ name: string; notnull: number }>();

    expect(results.map((row) => row.name)).toEqual([
      "run_seq",
      "run_id",
      "scheduled_at",
      "started_at",
      "finished_at",
      "status",
      "search_revision",
      "sources",
      "sources_truncated",
      "selected_components",
      "request_count",
      "result_count",
      "new_count",
      "changed_count",
      "unchanged_count",
      "claimed_count",
      "evaluation_count",
      "evaluation_error_count",
      "discarded_count",
      "batches",
      "steps_used",
      "step_failures",
      "rows_read",
      "rows_written",
      "errors",
    ]);
    // search_revision is NULL for a run that never loaded settings -- SKIPPED_LOCKED and
    // NO_SETTINGS, which is EVERY run in production until the bootstrap is applied.
    expect(results.filter((row) => row.notnull === 0).map((row) => row.name)).toEqual([
      "search_revision",
    ]);

    // run_id UNIQUE is what makes a replayed finalize an upsert rather than a UNIQUE failure
    // that rolls back the whole batch -- and the batch carries the lock release.
    await database.db
      .prepare(
        `INSERT INTO monitor_runs (run_id, scheduled_at, started_at, finished_at, status,
           search_revision, sources, sources_truncated, selected_components, request_count,
           result_count, new_count, changed_count, unchanged_count, claimed_count,
           evaluation_count, evaluation_error_count, discarded_count, batches, steps_used,
           step_failures, rows_read, rows_written, errors)
         VALUES ('dup',0,0,0,'OK',NULL,'[]',0,'[]',0,0,0,0,0,0,0,0,0,0,0,0,0,0,'[]')`,
      )
      .run();
    await expect(
      database.db
        .prepare(
          `INSERT INTO monitor_runs (run_id, scheduled_at, started_at, finished_at, status,
             search_revision, sources, sources_truncated, selected_components, request_count,
             result_count, new_count, changed_count, unchanged_count, claimed_count,
             evaluation_count, evaluation_error_count, discarded_count, batches, steps_used,
             step_failures, rows_read, rows_written, errors)
           VALUES ('dup',0,0,0,'OK',NULL,'[]',0,'[]',0,0,0,0,0,0,0,0,0,0,0,0,0,0,'[]')`,
        )
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    await database.db.prepare("DELETE FROM monitor_runs WHERE run_id = 'dup'").run();
  });

  // Test S8. The FILE, not the applied result.
  it("is two CREATE TABLEs and one seed INSERT, and nothing destructive", () => {
    const statements = splitSqlStatements(monitorSql);

    expect(statements).toHaveLength(3);
    expect(statements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(2);
    expect(
      statements.filter((statement) => statement.startsWith("INSERT INTO monitor_lock")),
    ).toHaveLength(1);

    // 0001, 0002 and 0003 are APPLIED IN PRODUCTION, and SQLite can neither drop a CHECK nor
    // alter a primary key. An ALTER or a DROP in this file is the one edit that cannot be
    // undone by editing the file again.
    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(DROP|ALTER|UPDATE|DELETE)\b/);
    }

    // The singleton CHECK, exhaustively: 0004 declares this one and no others. The status
    // column deliberately carries NO CHECK -- the status set will grow (the spec already names
    // SOURCE_EMPTY) and SQLite cannot add or drop one in place.
    expect(extractChecks(statements.join("\n"))).toEqual(["id = 1"]);
  });
});

/**
 * Phase 3F's additive migration. Same seam, same file-is-the-source-of-truth discipline as the
 * 0002 and 0004 blocks above.
 *
 * TWO DATABASES, AND THE REASON IS `CHECK (id = 1)`. `watch_market` can hold exactly one row, and
 * 0005 seeds it -- so the behavioural CHECK tests below cannot insert a candidate row into the
 * seeded database without first destroying the very seed S7c reads. `probe` is a second,
 * throwaway database whose market row each candidate replaces; `database` keeps the shipped
 * state, and S7g only ever attempts writes that are REFUSED, so it leaves that state intact.
 */
describe("0005_watch_targets.sql", () => {
  let probe!: TestDatabase;

  beforeAll(async () => {
    probe = await createTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await probe.dispose();
  });

  /** One candidate at a time: the singleton CHECK means the table can never hold two. */
  const tryMarket = async (columns: string, values: string) => {
    await probe.db.prepare("DELETE FROM watch_market").run();
    return probe.db.prepare(`INSERT INTO watch_market (id, ${columns}) VALUES (1, ${values})`).run();
  };

  // Test S7a.
  it("S7a: both tables carry exactly their columns, in order, all NOT NULL", async () => {
    const marketColumns = await database.db
      .prepare("SELECT name, `notnull`, pk FROM pragma_table_info('watch_market')")
      .all<{ name: string; notnull: number; pk: number }>();

    expect(marketColumns.results.map((row) => row.name)).toEqual([
      "id",
      "location",
      "latitude",
      "longitude",
      "radius_km",
    ]);
    expect(marketColumns.results.every((row) => row.notnull === 1)).toBe(true);
    expect(marketColumns.results.find((row) => row.name === "id")?.pk).toBe(1);

    const targetColumns = await database.db
      .prepare("SELECT name, `notnull`, pk FROM pragma_table_info('watch_targets')")
      .all<{ name: string; notnull: number; pk: number }>();

    expect(targetColumns.results.map((row) => row.name)).toEqual([
      "target_id",
      "component_type",
      "query",
    ]);
    // A nullable column here is not cosmetic: `query` NULL reaches `buildSearchUrl` as a
    // TypeError that run() launders into exit 5, and `component_type` NULL is a 400 at ingest.
    expect(targetColumns.results.every((row) => row.notnull === 1)).toBe(true);
    // A TEXT primary key: the label in the operator's only signal (the stdout line) and in the
    // settings UI. `"target":3` is unreadable.
    expect(targetColumns.results.find((row) => row.name === "target_id")?.pk).toBe(1);
  });

  // Test S7b. THE CHECKS, EXHAUSTIVELY -- and, like S2b, this is a PRESENCE pin rather than a
  // behavioural one. It is what catches a deletion that NO behavioural test would otherwise see;
  // S7e, S7f and S7g are the behavioural halves, and both halves are needed.
  it("S7b: declares exactly these eight CHECK constraints, and no others", () => {
    const checks = extractChecks(splitSqlStatements(watchSql).join("\n"));

    expect(checks).toEqual([
      "id = 1",
      "typeof(radius_km) = 'integer' AND radius_km >= 1 AND radius_km <= 25",
      "latitude >= -90 AND latitude <= 90",
      "longitude >= -180 AND longitude <= 180",
      "length(location) > 0 AND location NOT GLOB '*[^a-z0-9-]*'",
      "length(target_id) > 0",
      "length(component_type) > 0",
      "length(query) > 0",
    ]);
  });

  /**
   * Test S7c. THE SHIPPED SEED, VALIDATED RATHER THAN PINNED.
   *
   * Validated because `scripts/e2e-local.sh` OVERWRITES the market row and DELETES both targets
   * before it collects -- THE GATE NEVER EXECUTES AGAINST THE SHIPPED SEED AT ALL -- so literal
   * pins here would stay green while the shipped rows were unusable. This is the only thing in
   * the suite that looks at them.
   *
   * THE COLLECTOR-SIDE HALF IS `collector/watchTargets.test.ts` C-6, and it is a separate file
   * because it must be: `tsconfig.worker.json` cannot compile the collector's `.ts`-extension
   * imports, so `parseMarket` and `parseTarget` are not reachable from here. C-6 reads the same
   * migration file and runs the real parsers over the real seed values.
   */
  it("S7c: the shipped seed is two usable targets and one usable market", async () => {
    const targets = await database.db
      .prepare("SELECT target_id, component_type, query FROM watch_targets ORDER BY target_id")
      .all<{ target_id: string; component_type: string; query: string }>();

    expect(targets.results).toHaveLength(2);
    for (const row of targets.results) {
      // Not a literal list: a seeded 'gpuu' is a loud 400 INVALID_LISTINGS at ingest, and
      // COMPONENT_TYPES is the authority that decides it.
      expect(Object.hasOwn(COMPONENT_TYPES, row.component_type)).toBe(true);
      expect(row.target_id.length).toBeGreaterThan(0);
      expect(row.query.trim().length).toBeGreaterThan(0);
    }

    const market = await database.db
      .prepare("SELECT location, latitude, longitude, radius_km, typeof(radius_km) AS radius_type FROM watch_market")
      .all<{
        location: string;
        latitude: number;
        longitude: number;
        radius_km: number;
        radius_type: string;
      }>();

    expect(market.results).toHaveLength(1);
    const row = market.results[0];
    expect(row.radius_type).toBe("integer");
    expect(Number.isInteger(row.radius_km)).toBe(true);
    expect(row.radius_km).toBeGreaterThanOrEqual(1);
    expect(row.radius_km).toBeLessThanOrEqual(25);
    expect(Math.abs(row.latitude)).toBeLessThanOrEqual(90);
    expect(Math.abs(row.longitude)).toBeLessThanOrEqual(180);
  });

  // Test S7d. The FILE, not the applied result: a destructive statement would still leave the
  // right tables on a FRESH database while destroying the deployed one. 0001-0004 are APPLIED IN
  // PRODUCTION and SQLite can neither drop a CHECK nor alter a primary key.
  it("S7d: is two CREATE TABLEs and three seed INSERTs, and nothing destructive", () => {
    const statements = splitSqlStatements(watchSql);

    expect(statements).toHaveLength(5);
    expect(statements.filter((statement) => statement.startsWith("CREATE TABLE"))).toHaveLength(2);
    expect(statements.filter((statement) => statement.startsWith("INSERT INTO"))).toHaveLength(3);

    for (const statement of statements) {
      expect(statement).not.toMatch(/\b(DROP|ALTER|UPDATE|DELETE)\b/);
    }
  });

  /**
   * Test S7e. THE RADIUS CHECK, BEHAVIOURALLY. S7b alone is a presence pin: deleting the
   * `typeof(radius_km) = 'integer'` term leaves a range-only check that 12.5, 1.5 and the string
   * "12.5" ALL PASS, storing as typeof='real' -- MEASURED, and it is the same affinity trap that
   * jammed every settings PUT with a 60000.5 in search_revisions. These three rows are the ones
   * that go green-to-red.
   */
  it.each<[string, string]>([
    ["12.5", "12.5"],
    ["1.5", "1.5"],
    ['the string "12.5"', "'12.5'"],
    ["0", "0"],
    ["26", "26"],
    ["-3", "-3"],
    ["'abc'", "'abc'"],
  ])("S7e: radius_km %s is refused", async (_label, literal) => {
    await expect(
      tryMarket("location, latitude, longitude, radius_km", `'toronto', 43.6532, -79.3832, ${literal}`),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it.each<[string, string]>([
    ["25.0", "25.0"],
    ["the string '25'", "'25'"],
    ["1", "1"],
    ["25", "25"],
  ])("S7e: radius_km %s is accepted and stored as an integer", async (_label, literal) => {
    await tryMarket("location, latitude, longitude, radius_km", `'toronto', 43.6532, -79.3832, ${literal}`);

    const row = await probe.db
      .prepare("SELECT radius_km AS value, typeof(radius_km) AS kind FROM watch_market")
      .first<{ value: number; kind: string }>();

    // 25.0 and '25' coerce to the INTEGER 25, so the typeof term costs a legitimate writer
    // nothing -- which is the whole reason it is affordable.
    expect(row?.kind).toBe("integer");
    expect(Number.isInteger(row?.value)).toBe(true);
  });

  /**
   * Test S7f. THE LOCATION CHECK, BEHAVIOURALLY. Delete the `NOT GLOB` term and every refused row
   * below stores -- and '..' then reaches a URL path segment.
   *
   * THE INTEGER 25 IS DELIBERATELY NOT A ROW HERE, AND THAT IS A CORRECTION TO A CLAIM THAT IS
   * EASY TO MAKE AND WRONG. MEASURED: TEXT affinity stores the integer literal 25 as the text
   * "25", which is all digits, so this GLOB ACCEPTS it -- exactly as it accepts the perfectly
   * legal location '123'. Only a value carrying a '.' is caught, which is why the REAL literal
   * 25.0 (stored as "25.0") is the row instead.
   */
  it.each<[string, string]>([
    ["a path separator", "'toronto/search'"],
    ["a parent segment", "'..'"],
    ["a traversal", "'../../etc'"],
    ["upper case", "'TORONTO'"],
    ["a space", "'to ronto'"],
    ["a dot", "'a.b'"],
    ["empty", "''"],
    ["the REAL 25.0", "25.0"],
  ])("S7f: the location %s is refused", async (_label, literal) => {
    await expect(
      tryMarket("location, latitude, longitude, radius_km", `${literal}, 43.6532, -79.3832, 25`),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  it.each<[string, string]>([
    ["toronto", "'toronto'"],
    ["new-york", "'new-york'"],
  ])("S7f: the location %s is accepted", async (_label, literal) => {
    await tryMarket("location, latitude, longitude, radius_km", `${literal}, 43.6532, -79.3832, 25`);
    const row = await probe.db.prepare("SELECT COUNT(*) AS n FROM watch_market").first<{ n: number }>();
    expect(row?.n).toBe(1);
  });

  /**
   * Test S7g. THE SINGLETON, ALL FOUR ROUTES TO A SECOND MARKET.
   *
   * THE OMITTED-`id` ROW IS THE ONE THAT MATTERS MOST: `id` is an INTEGER rowid alias, so an
   * INSERT that leaves it out AUTO-ASSIGNS 2 -- and that is the shape a runbook
   * `wrangler d1 execute` or a settings-UI writer actually produces. It is where the CHECK stops
   * something a human would plausibly type.
   *
   * Every attempt here is REFUSED, so this test leaves the shipped seed exactly as it found it.
   */
  it("S7g: all four routes to a second market are refused, and one row survives", async () => {
    const attempts: Array<[string, string]> = [
      ["an explicit id 2", "INSERT INTO watch_market (id, location, latitude, longitude, radius_km) VALUES (2, 'toronto', 43.6532, -79.3832, 25)"],
      ["an explicit id 0", "INSERT INTO watch_market (id, location, latitude, longitude, radius_km) VALUES (0, 'toronto', 43.6532, -79.3832, 25)"],
      ["an OMITTED id, which auto-assigns 2", "INSERT INTO watch_market (location, latitude, longitude, radius_km) VALUES ('toronto', 43.6532, -79.3832, 25)"],
      ["moving the existing row", "UPDATE watch_market SET id = 2 WHERE id = 1"],
    ];

    for (const [label, statement] of attempts) {
      await expect(
        database.db.prepare(statement).run(),
        `${label} must be refused`,
      ).rejects.toThrow(/CHECK constraint failed/);
    }

    const row = await database.db
      .prepare("SELECT COUNT(*) AS n FROM watch_market")
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});
