// @vitest-environment node

/**
 * The query plan of tier 3's evidence-gated claim, read with EXPLAIN QUERY PLAN on Miniflare's D1.
 *
 * ITS OWN FILE ON PURPOSE. The second half runs ANALYZE, and the statistics it writes to
 * sqlite_stat1 stay with the database for the rest of the file -- they would silently change the
 * plans every other test file in this directory measures. Each test file gets its own database.
 *
 * What is pinned: evaluation_tasks is the OUTER loop, walked through evaluation_tasks_attempt so
 * the `ORDER BY evaluated_at, listing_id` costs no sort, and there is no TEMP B-TREE anywhere.
 * The second half is the case the CROSS JOIN exists for: with ANALYZE statistics describing far
 * more tasks than listings, a plain JOIN lets the planner start from listings -- SCAN l, then
 * every NEEDS_REVIEW row sorted in a TEMP B-TREE to pick 15 (reproduced).
 */

import { marketKey } from "../storage/marketKey";
import { createTestDatabase, type TestDatabase } from "../testing/d1";
import { CLAIM_NEEDS_REVIEW } from "./evaluateBatch";
import { MINIMUM_REFERENCE_COUNT } from "./types";

const SOURCE = "test-provider";
const T0 = 1_760_000_000;
const REVISION = 9;
const MARKET_KEY = marketKey({ latitude: 43.4643, longitude: -80.5204, radiusKm: 25 });

let database!: TestDatabase;
let db!: D1Database;

beforeAll(async () => {
  database = await createTestDatabase();
  db = database.db;
});

afterAll(async () => {
  await database.dispose();
});

const plan = async (): Promise<string[]> =>
  (
    await db
      .prepare(`EXPLAIN QUERY PLAN ${CLAIM_NEEDS_REVIEW}`)
      .bind(SOURCE, 15, T0 + 300, "token-plan", REVISION, MINIMUM_REFERENCE_COUNT, Number.MAX_SAFE_INTEGER)
      .all<{ detail: string }>()
  ).results.map((row) => row.detail);

const expectIndexWalkWithoutSort = (details: string[]) => {
  expect(details, details.join(" | ")).toContain(
    "SEARCH t USING INDEX evaluation_tasks_attempt (source=? AND status=?)",
  );
  expect(details.filter((detail) => detail.includes("TEMP B-TREE"))).toEqual([]);
  // evaluation_tasks is the outer loop: the subquery's first table access is t, not l, p or s.
  const subquery = details.filter((detail) => /^(SEARCH|SCAN) [tlps] /.test(detail));
  expect(subquery[0]).toMatch(/^SEARCH t /);
};

describe("tier 3 claim -- query plan", () => {
  it("P1: walks evaluation_tasks_attempt from the outside, with no sort, on an empty database", async () => {
    expectIndexWalkWithoutSort(await plan());
  });

  it("P2: keeps that plan under ANALYZE statistics with 100x more tasks than listings", async () => {
    await db
      .prepare(
        `INSERT INTO listings
                (source, listing_id, market_key, component_type, model_key, variant_key, title,
                 price_cents, location_text, url, validity, content_hash, first_seen_at, last_seen_at)
         WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200)
         SELECT ?1, 'l-' || n, ?2, 'gpu', 'M-' || (n % 50), '', 'plan', 20000 + n, NULL,
                'https://example.test/x', 'VALID', 'hash-' || n, ?3, ?3
           FROM seq`,
      )
      .bind(SOURCE, MARKET_KEY, T0)
      .run();
    await db
      .prepare(
        `INSERT INTO price_observations
                (source, listing_id, market_key, model_key, variant_key, price_cents, last_seen_at)
         SELECT source, listing_id, market_key, model_key, variant_key, price_cents, last_seen_at
           FROM listings`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO model_stats (market_key, model_key, variant_key, count, total_price_cents)
         SELECT market_key, model_key, variant_key, COUNT(*), SUM(price_cents)
           FROM price_observations GROUP BY market_key, model_key, variant_key`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO evaluation_tasks
                (source, listing_id, status, created_at, evaluated_revision, verdict, evaluated_at,
                 lease_expires_at, lease_token)
         WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 20000)
         SELECT ?1, 'l-' || n, 'NEEDS_REVIEW', ?2, ?3 - (n % 2), 'NEEDS_REVIEW', ?2 - n, 0, ''
           FROM seq`,
      )
      .bind(SOURCE, T0, REVISION)
      .run();
    await db.prepare("ANALYZE").run();

    expectIndexWalkWithoutSort(await plan());
  });
});
