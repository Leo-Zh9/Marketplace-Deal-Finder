// @vitest-environment node

/**
 * The CPU invariant: p95 < 8 ms on a 15-listing batch, and every claim tier O(batchSize) in rows
 * read at any corpus or eligible-set size.
 *
 * WHAT THIS HARNESS MUST NOT BE. createTestDatabase() hands the Node test process a PROXY: every
 * prepare, bind and all is an HTTP round trip to workerd. Measured directly, one 15-candidate
 * batch is ~120 ms wall and ~27 ms of Node CPU, and instrumenting the awaits attributes only
 * ~9 ms of that to D1 -- the rest is proxy machinery THAT DOES NOT EXIST IN A WORKER. Reporting
 * that as "CPU" would fail a gate the code passes by three orders of magnitude.
 *
 * So: capture, then replay. C4 runs evaluateBatch once against the real D1 over a realistic
 * fixture, captures the EXACT result rows D1 returns, and replays those captured rows through a
 * small in-process D1Database-shaped stub. What is timed is everything evaluateBatch does that
 * is not waiting on D1 -- SQL string construction, bind-argument marshalling, result mapping,
 * `decide`, statement construction. That is Cloudflare's own definition; CPU time excludes I/O.
 *
 * THE REPLAY STUB IS NOT A SECOND DATABASE SEAM. It executes no SQL and owns no schema; its data
 * comes from the real seam. It lives in this file so it cannot be mistaken for one.
 *
 * HONEST LIMITATION: the stub does not pay the real D1 binding's prepare/bind cost or the
 * deserialisation of the response, which a real Worker does. Both are bounded by a 15-row
 * result; at this headroom the conclusion survives them.
 *
 * C1-C3 are the tests that actually pin the row budget, and they are deterministic. C2 is the one
 * that cannot be faked: a fixture with a small eligible set and a growing INELIGIBLE corpus is
 * structurally incapable of seeing the sort a single-statement claim would introduce.
 */

import { marketKey } from "../storage/marketKey";
import type { Market } from "../storage/marketKey";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";
import { claimEvaluationTasks, evaluateBatch } from "./evaluateBatch";
import type { EvaluationSettings } from "./types";

const SOURCE = "test-provider";
const T0 = 1_760_000_000;
const MARKET_A: Market = { latitude: 43.4643, longitude: -80.5204, radiusKm: 25 };
const MARKET_A_KEY = marketKey(MARKET_A);
const MODEL = "RTX_4070_SUPER";

/** The whole-call ceiling C1 and C2 share. Measured: 150 steady state, 129 post-bump. */
const ROWS_READ_CEILING = 250;

const CURRENT_REVISION = 9;
const STALE_REVISION = 8;

const settings = (searchRevision: number): EvaluationSettings => ({
  mode: "DISCOUNT",
  minimumDiscountPercent: 20,
  maximumPriceCents: null,
  searchRevision,
});

let database!: TestDatabase;
let db!: D1Database;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
});

afterAll(async () => {
  await database.dispose();
});

beforeEach(async () => {
  await truncateAll(db);
});

/**
 * Bulk fixtures are built with one recursive-CTE INSERT rather than N prepared statements: the
 * proxy round trip, not the insert, is what makes a 20,000-row fixture slow.
 */
const bulkListings = async (prefix: string, count: number): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO listings
              (source, listing_id, market_key, component_type, model_key, variant_key, title,
               price_cents, location_text, url, validity, content_hash, first_seen_at, last_seen_at)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?3)
       SELECT ?1, ?2 || printf('%06d', n), ?4, 'gpu', ?5, '', 'bulk', 25000, 'Waterloo, ON',
              'https://example.test/x', 'VALID', 'hash-' || n, ?6, ?6
         FROM seq`,
    )
    .bind(SOURCE, prefix, count, MARKET_A_KEY, MODEL, T0)
    .run();
};

const bulkTasks = async (args: {
  prefix: string;
  count: number;
  status: string;
  createdAt: number;
  evaluatedRevision: number | null;
  evaluatedAt: number | null;
}): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO evaluation_tasks
              (source, listing_id, status, created_at, evaluated_revision, verdict, evaluated_at,
               lease_expires_at, lease_token)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?3)
       SELECT ?1, ?2 || printf('%06d', n), ?4, ?5, ?6, 'NOT_DEAL', ?7, 0, '' FROM seq`,
    )
    .bind(
      SOURCE,
      args.prefix,
      args.count,
      args.status,
      args.createdAt,
      args.evaluatedRevision,
      args.evaluatedAt,
    )
    .run();
};

/**
 * One market, 60 contributing observations and the aggregate they produce, written directly so a
 * 20,000-row corpus does not cost 20,000 proxy round trips. Prices are 20100..26000 in steps of
 * 100; the total is asserted from the database rather than assumed.
 */
const MARKET_SIZE = 60;

const marketFixture = async (): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO listings
              (source, listing_id, market_key, component_type, model_key, variant_key, title,
               price_cents, location_text, url, validity, content_hash, first_seen_at, last_seen_at)
       WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?3)
       SELECT ?1, ?2 || printf('%06d', n), ?4, 'gpu', ?5, '', 'market', 20000 + n * 100,
              'Waterloo, ON', 'https://example.test/x', 'VALID', 'hash-m-' || n, ?6, ?6
         FROM seq`,
    )
    .bind(SOURCE, "mkt-", MARKET_SIZE, MARKET_A_KEY, MODEL, T0)
    .run();

  await db
    .prepare(
      `INSERT INTO price_observations
              (source, listing_id, market_key, model_key, variant_key, price_cents, last_seen_at)
       SELECT source, listing_id, market_key, model_key, variant_key, price_cents, last_seen_at
         FROM listings WHERE source = ?1 AND listing_id LIKE 'mkt-%'`,
    )
    .bind(SOURCE)
    .run();

  await db
    .prepare(
      `INSERT INTO model_stats (market_key, model_key, variant_key, count, total_price_cents)
       SELECT market_key, model_key, variant_key, COUNT(*), SUM(price_cents)
         FROM price_observations GROUP BY market_key, model_key, variant_key`,
    )
    .run();
};

describe("evaluation CPU -- rows read per call", () => {
  // C1. STEADY STATE: 15 PENDING inside a 20,000-row evaluation_tasks table. The whole call --
  // four claims, one read, one completion batch -- must stay under the ceiling regardless of how
  // much INELIGIBLE work sits beside it.
  it("C1: reads a bounded number of rows with 15 PENDING inside 20,000 tasks", async () => {
    await marketFixture();
    await bulkListings("cold-", 19_940);

    // 15 fresh PENDING over real listings with a real aggregate behind them; the other 45
    // market listings are COMPLETE at the current revision.
    await db
      .prepare(
        `INSERT INTO evaluation_tasks
                (source, listing_id, status, created_at, evaluated_revision, verdict, evaluated_at,
                 lease_expires_at, lease_token)
         SELECT ?1, listing_id,
                CASE WHEN CAST(substr(listing_id, 5) AS INTEGER) <= 15 THEN 'PENDING' ELSE 'COMPLETE' END,
                ?2,
                CASE WHEN CAST(substr(listing_id, 5) AS INTEGER) <= 15 THEN NULL ELSE ?3 END,
                'NOT_DEAL', ?2, 0, ''
           FROM listings WHERE source = ?1 AND listing_id LIKE 'mkt-%'`,
      )
      .bind(SOURCE, T0, CURRENT_REVISION)
      .run();
    // The rest of the corpus: COMPLETE at the CURRENT revision, so ineligible in every tier.
    await bulkTasks({
      prefix: "cold-",
      count: 19_940,
      status: "COMPLETE",
      createdAt: T0,
      evaluatedRevision: CURRENT_REVISION,
      evaluatedAt: T0,
    });

    const total = await db
      .prepare("SELECT COUNT(*) AS n FROM evaluation_tasks")
      .first<{ n: number }>();
    expect(total!.n).toBe(20_000);

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: settings(CURRENT_REVISION),
      now: T0 + 1000,
      leaseToken: "token-c1",
    });

    expect(report.claimed).toBe(15);
    console.log(`C1 steady state: whole-call rowsRead=${report.usage.rowsRead} over 20,000 tasks`);
    expect(report.usage.rowsRead).toBeLessThan(ROWS_READ_CEILING);
    // EXACT, not just under the ceiling, and this is the only place the whole call is pinned to a
    // number. Every ceiling in this file is only as honest as the accounting behind it: drop one
    // `usage.rowsRead +=` and every ceiling still passes while measuring less than it claims.
    // 165 = 90 (tier 1 claim) + 60 (candidate read) + 15 (completion batch). Dropping the
    // completion loop's accounting measures 150 -- which is exactly the figure the plan carried
    // for this scenario, and exactly what it would omit.
    expect(report.usage.rowsRead).toBe(165);
  });

  /**
   * C1b. TIERS 1 AND 2 AT SCALE -- the hot path, and the shape a first full scan actually has:
   * every listing queued PENDING by one scan, so they all share ONE `created_at`.
   *
   * C1 above cannot see this. Its eligible set is 15 PENDING among 19,985 ineligible rows, so the
   * sort a narrower index would force is a sort over 15 rows and costs nothing. Here the tie group
   * IS the corpus, which is why `listing_id` is the fourth column of evaluation_tasks_queue.
   *
   * Measured: 90 rows for the four-tier claim (15 for the select, COVERING INDEX, no TEMP B-TREE).
   * With `created_at, listing_id` dropped from the index the same claim reads 40,075 and EXPLAIN
   * reports USE TEMP B-TREE FOR ORDER BY -- draining a 20,000-task backlog at 15 a call would cost
   * ~53M rows instead of ~120K.
   */
  it("C1b: claims 15 of 20,000 PENDING sharing one created_at", async () => {
    await bulkTasks({
      prefix: "pend-",
      count: 20_000,
      status: "PENDING",
      createdAt: T0,
      evaluatedRevision: null,
      evaluatedAt: null,
    });

    const claim = await claimEvaluationTasks(db, {
      source: SOURCE,
      batchSize: 15,
      now: T0 + 1000,
      leaseSeconds: 300,
      leaseToken: "token-c1b",
      searchRevision: CURRENT_REVISION,
    });

    expect(claim.tasks).toHaveLength(15);
    console.log(`C1b tier-1 claim over 20,000 PENDING: rowsRead=${claim.usage.rowsRead}`);
    expect(claim.usage.rowsRead).toBeLessThanOrEqual(150);
  });

  // C2. POST-BUMP, AND THE ONE TEST THAT CANNOT BE FAKED. Every task is eligible, which is the
  // state the spec's own revision mechanism produces and this design's own recovery path relies
  // on. A single-statement claim with a CASE in the ORDER BY works and costs rows_read ~
  // 2 * |eligible|, because an ORDER BY cannot ride a MULTI-INDEX OR: EXPLAIN reports USE TEMP
  // B-TREE FOR ORDER BY and the ENTIRE eligible set is materialised to pick 15.
  it("C2: reads the same bounded number of rows at 200, 5,000 and 20,000 eligible", async () => {
    const measured: Array<{ eligible: number; rowsRead: number }> = [];

    for (const eligible of [200, 5_000, 20_000]) {
      await truncateAll(db);
      await bulkListings("stale-", eligible);
      await bulkTasks({
        prefix: "stale-",
        count: eligible,
        status: "COMPLETE",
        createdAt: T0,
        evaluatedRevision: STALE_REVISION,
        evaluatedAt: T0,
      });

      const report = await evaluateBatch(db, {
        source: SOURCE,
        settings: settings(CURRENT_REVISION),
        now: T0 + 1000,
        leaseToken: `token-c2-${eligible}`,
      });

      expect(report.claimed).toBe(15);
      measured.push({ eligible, rowsRead: report.usage.rowsRead });
    }

    console.log(
      `C2 post-bump: ${measured.map((s) => `${s.eligible} eligible -> ${s.rowsRead} rows read`).join(", ")}`,
    );
    for (const sample of measured) {
      expect(sample.rowsRead, `eligible=${sample.eligible}`).toBeLessThan(ROWS_READ_CEILING);
    }
    // It does not GROW with the eligible set: 100x the eligible rows, the same budget.
    expect(measured[2].rowsRead).toBeLessThanOrEqual(measured[0].rowsRead + 20);
  });

  /**
   * C2b. THE SPARSE STALE SET -- and the only fixture in this file that discriminates between
   * tier 4's three index ranges and the two forms the plan rejects.
   *
   * MEASURED, and the reason this test exists. With EVERY task eligible (C2 above), the first 15
   * index entries the claim touches all match, so `evaluated_revision IS NOT ?5` and the form
   * with `source` factored out of the OR group are exactly as cheap as the three ranges -- 90
   * rows read for all three. Put the eligible rows BEHIND a large block of ineligible ones at a
   * LOWER revision, though, and the index order stops helping the forms that cannot seek:
   *
   *   three ranges  -> MULTI-INDEX OR over covering ranges, 16 rows read
   *   IS NOT ?5     -> SEARCH ... (source=? AND status=?), 20,015 rows read
   *   source factored out of the OR group -> SEARCH ... (source=?), 20,015 rows read
   *
   * This is the rollback shape from E12 at scale, and it is also what a corpus looks like once a
   * bump has drained: a handful of stale rows behind a very large settled majority.
   */
  it("C2b: reads a bounded number of rows for 15 stale tasks behind 20,000 settled ones", async () => {
    await bulkTasks({
      prefix: "blk-",
      count: 20_000,
      status: "COMPLETE",
      createdAt: T0,
      evaluatedRevision: CURRENT_REVISION,
      evaluatedAt: T0,
    });
    await bulkListings("elg-", 15);
    await bulkTasks({
      prefix: "elg-",
      count: 15,
      status: "COMPLETE",
      createdAt: T0,
      // HIGHER than the current revision, so these rows sort AFTER the whole ineligible block
      // inside evaluation_tasks_revision. A form that cannot seek must walk past all 20,000.
      evaluatedRevision: CURRENT_REVISION + 1,
      evaluatedAt: T0,
    });

    const report = await evaluateBatch(db, {
      source: SOURCE,
      settings: settings(CURRENT_REVISION),
      now: T0 + 1000,
      leaseToken: "token-c2b",
    });

    expect(report.claimed).toBe(15);
    console.log(`C2b sparse stale set: whole-call rowsRead=${report.usage.rowsRead}`);
    expect(report.usage.rowsRead).toBeLessThan(ROWS_READ_CEILING);
  });

  /**
   * C3. TIER 3 AT SCALE. Every completion in one batch writes the same `now`, so evaluated_at
   * ties are the NORMAL case -- which is why listing_id is in evaluation_tasks_attempt. Without
   * it SQLite sorts the whole tier to pick 15.
   *
   * MEASURED HERE, not assumed: the four-tier claim reads 101 rows against 200, 5,000 and 20,000
   * NEEDS_REVIEW rows -- IDENTICAL at every size. Tier 3's own UPDATE ... RETURNING accounts for
   * 90 of them: D1 charges the index maintenance of the claim's own write, not only the 15-row
   * covering scan that chooses the rows. The property under test is that the number does not
   * move with the corpus; the ceiling is set just above the measurement so the named mutation
   * (which sorts the whole tier) cannot hide under it.
   */
  it("C3: claims 15 of 20,000 NEEDS_REVIEW rows sharing one evaluated_at", async () => {
    await bulkTasks({
      prefix: "nr-",
      count: 20_000,
      status: "NEEDS_REVIEW",
      createdAt: T0,
      evaluatedRevision: CURRENT_REVISION,
      evaluatedAt: T0,
    });

    const claim = await claimEvaluationTasks(db, {
      source: SOURCE,
      batchSize: 15,
      now: T0 + 1000,
      leaseSeconds: 300,
      leaseToken: "token-c3",
      searchRevision: CURRENT_REVISION,
    });

    expect(claim.tasks).toHaveLength(15);
    expect(claim.usage.rowsRead).toBeLessThanOrEqual(150);
  });
});

/** Captured D1 results, keyed by the exact SQL evaluateBatch asked for. */
interface Capture {
  all: Map<string, unknown>;
  batch: unknown[];
}

const REAL = Symbol("real-statement");

/**
 * A recorder that DELEGATES to the real D1 and writes down what it returned. It runs exactly one
 * real evaluateBatch call; everything timed afterwards replays what this captured.
 */
const recordingDatabase = (real: D1Database, capture: Capture): D1Database => {
  const wrap = (sql: string, bound: D1PreparedStatement): D1PreparedStatement =>
    ({
      [REAL]: bound,
      bind: (...args: unknown[]) => wrap(sql, bound.bind(...args)),
      all: async () => {
        const result = await bound.all();
        capture.all.set(sql, result);
        return result;
      },
      run: () => bound.run(),
      first: () => bound.first(),
      raw: () => bound.raw(),
    }) as unknown as D1PreparedStatement;

  return {
    prepare: (sql: string) => wrap(sql, real.prepare(sql)),
    batch: async (statements: D1PreparedStatement[]) => {
      const results = await real.batch(
        statements.map((statement) => (statement as unknown as Record<symbol, D1PreparedStatement>)[REAL]),
      );
      capture.batch = results;
      return results;
    },
  } as unknown as D1Database;
};

/**
 * The replay stub. It executes no SQL and owns no schema: every result it returns was produced by
 * the real D1 above, over a real fixture.
 */
const replayDatabase = (capture: Capture): D1Database => {
  const empty = { results: [], success: true, meta: { rows_read: 0, rows_written: 0, changes: 0 } };
  return {
    prepare: (sql: string) => {
      const result = capture.all.get(sql) ?? empty;
      const statement: Record<string, unknown> = {
        bind: () => statement,
        all: () => Promise.resolve(result),
        run: () => Promise.resolve(result),
        first: () => Promise.resolve(null),
        raw: () => Promise.resolve([]),
      };
      return statement as unknown as D1PreparedStatement;
    },
    batch: (statements: D1PreparedStatement[]) =>
      Promise.resolve(capture.batch.slice(0, statements.length)),
  } as unknown as D1Database;
};

const percentile = (sorted: number[], fraction: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];

describe("evaluation CPU -- measurement", () => {
  // C4. p95 < 8 ms over 3,000 replayed samples after an 800-sample warm-up. The numbers are
  // PRINTED on every run so the measurement is recorded rather than merely asserted.
  it("C4: p95 CPU is far under the 8 ms budget on a realistic 15-listing batch", async () => {
    await marketFixture();
    await bulkListings("cold-", 3_000);
    await bulkTasks({
      prefix: "cold-",
      count: 3_000,
      status: "COMPLETE",
      createdAt: T0,
      evaluatedRevision: CURRENT_REVISION,
      evaluatedAt: T0,
    });
    // THE PESSIMISTIC SHAPE: the 15 claimed candidates are spread so that ALL FOUR tier
    // statements run -- 5 PENDING, 4 expired PROCESSING, 3 stale-revision COMPLETE and the rest
    // NEEDS_REVIEW, of which tier 3 takes the last 3. The steady state fills in tier 1 and issues
    // ONE claim statement; capturing that would measure the cheap case.
    await db
      .prepare(
        `INSERT INTO evaluation_tasks
                (source, listing_id, status, created_at, evaluated_revision, verdict, evaluated_at,
                 lease_expires_at, lease_token)
         SELECT ?1, listing_id,
                CASE WHEN CAST(substr(listing_id, 5) AS INTEGER) <= 5  THEN 'PENDING'
                     WHEN CAST(substr(listing_id, 5) AS INTEGER) <= 9  THEN 'PROCESSING'
                     WHEN CAST(substr(listing_id, 5) AS INTEGER) <= 12 THEN 'COMPLETE'
                     ELSE 'NEEDS_REVIEW' END,
                ?2,
                CASE WHEN CAST(substr(listing_id, 5) AS INTEGER) <= 9  THEN NULL
                     WHEN CAST(substr(listing_id, 5) AS INTEGER) <= 12 THEN ?4
                     ELSE ?3 END,
                'NOT_DEAL', ?2, 0, ''
           FROM listings
          WHERE source = ?1 AND listing_id LIKE 'mkt-%'`,
      )
      .bind(SOURCE, T0, CURRENT_REVISION, STALE_REVISION)
      .run();

    const capture: Capture = { all: new Map(), batch: [] };
    const input = {
      source: SOURCE,
      settings: settings(CURRENT_REVISION),
      now: T0 + 1000,
      leaseToken: "token-c4",
    };

    const real = await evaluateBatch(recordingDatabase(db, capture), input);
    expect(real.claimed).toBe(15);
    expect(real.outcomes).toHaveLength(15);
    // All four claim statements, plus the candidate read -- a REAL 15-row result over a real
    // 60-observation aggregate.
    expect(capture.all.size).toBe(5);
    expect(capture.batch).toHaveLength(15);

    const stub = replayDatabase(capture);
    const sample = async () => {
      const start = performance.now();
      await evaluateBatch(stub, input);
      return performance.now() - start;
    };

    for (let index = 0; index < 800; index += 1) {
      await sample();
    }
    const samples: number[] = [];
    for (let index = 0; index < 3_000; index += 1) {
      samples.push(await sample());
    }
    samples.sort((a, b) => a - b);

    const p50 = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    const p99 = percentile(samples, 0.99);
    const max = samples[samples.length - 1];
    console.log(
      `evaluateBatch CPU over ${samples.length} replayed samples (batch 15): ` +
        `p50 ${p50.toFixed(4)} ms, p95 ${p95.toFixed(4)} ms, p99 ${p99.toFixed(4)} ms, ` +
        `max ${max.toFixed(4)} ms`,
    );

    expect(p95).toBeLessThan(8);
  });
});
