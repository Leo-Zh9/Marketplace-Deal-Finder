// @vitest-environment node

import {
  cleanupStaleObservations,
  staleGroupStatements,
  staleGroups,
} from "./cleanupStaleObservations";
import { recordSightings } from "./recordSightings";
import { STALE_AFTER_SECONDS, type Listing, type Sighting } from "./types";
import type { Market } from "./marketKey";
import { createTestDatabase, truncateAll, type TestDatabase } from "../testing/d1";

const SOURCE = "test-provider";
const T0 = 1_760_000_000;
const DAY = 24 * 60 * 60;
const MARKET: Market = { latitude: 43.4643, longitude: -80.5204, radiusKm: 25 };
const MARKET_KEY = "43.4643,-80.5204|25km";

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

const valid = (
  overrides: Partial<Listing> & { listingId: string },
): Sighting => ({
  listing: {
    componentType: "gpu",
    modelKey: "RTX_4070_SUPER",
    variantKey: null,
    title: "RTX 4070 Super, barely used",
    priceCents: 50_000,
    locationText: "Waterloo, ON",
    // DELIBERATELY NOT DERIVED FROM listingId. `url` and `listingId` are independent fields --
    // one listing id can arrive under several urls (a tracking parameter, a canonicalisation
    // change between two pages of one scrape, a mobile form) -- and `url` is also part of the
    // content hash. A fixture that keeps them 1:1 makes the two indistinguishable, so no test
    // can tell which one the code actually keys on. Tests that need distinct urls override it.
    url: "https://example.test/listing",
    observedAt: "2026-09-20T00:00:00Z",
    ...overrides,
  },
  validity: "VALID",
});

const sight = (sightings: Sighting[], now: number) =>
  recordSightings(db, { source: SOURCE, market: MARKET, sightings, now });

interface StatsRow {
  market_key: string;
  model_key: string;
  variant_key: string;
  count: number;
  total_price_cents: number;
}

const allStats = async (): Promise<StatsRow[]> =>
  (
    await db
      .prepare(
        "SELECT market_key, model_key, variant_key, count, total_price_cents FROM model_stats" +
          " ORDER BY market_key, model_key, variant_key",
      )
      .all<StatsRow>()
  ).results;

const observationIds = async () =>
  (
    await db
      .prepare("SELECT listing_id FROM price_observations ORDER BY listing_id")
      .all<{ listing_id: string }>()
  ).results.map((row) => row.listing_id);

/** Recompute the aggregate from the observations; absence on either side counts as (0, 0). */
const recomputed = async () =>
  (
    await db
      .prepare(
        "SELECT market_key, model_key, variant_key, COUNT(*) AS count," +
          " SUM(price_cents) AS total_price_cents FROM price_observations" +
          " GROUP BY market_key, model_key, variant_key" +
          " ORDER BY market_key, model_key, variant_key",
      )
      .all<StatsRow>()
  ).results;

// ---------------------------------------------------------------------------
// Test 5 -- stale expiration.
// ---------------------------------------------------------------------------
describe("stale expiration", () => {
  it("subtracts exactly the expired members and leaves the fresh one contributing", async () => {
    await sight(
      [
        valid({ listingId: "old1", priceCents: 10_000 }),
        valid({ listingId: "old2", priceCents: 20_000 }),
        valid({ listingId: "fresh", priceCents: 30_000 }),
      ],
      T0,
    );
    expect((await allStats())[0]).toMatchObject({ count: 3, total_price_cents: 60_000 });

    // Keep only `fresh` alive: an identical re-sighting past the heartbeat interval moves its
    // observation's last_seen_at and nothing else.
    const stillSeen = T0 + 8 * DAY;
    await sight([valid({ listingId: "fresh", priceCents: 30_000 })], stillSeen);

    const now = stillSeen + 60;
    const report = await cleanupStaleObservations(db, { now });

    expect(report.groups).toBe(1);
    expect(report.observationsDeleted).toBe(2);
    expect(await observationIds()).toEqual(["fresh"]);
    expect(await allStats()).toEqual([
      {
        market_key: MARKET_KEY,
        model_key: "RTX_4070_SUPER",
        variant_key: "",
        count: 1,
        total_price_cents: 30_000,
      },
    ]);
    expect(report.usage.rowsWritten).toBeGreaterThan(0);
  });

  it("prunes the aggregate row when the WHOLE group expires", async () => {
    await sight(
      [
        valid({ listingId: "old1", priceCents: 10_000 }),
        valid({ listingId: "old2", priceCents: 20_000 }),
      ],
      T0,
    );

    const now = T0 + 8 * DAY;
    const report = await cleanupStaleObservations(db, { now });

    expect(report.observationsDeleted).toBe(2);
    // The sweep is the ONLY thing that removes a fully-expired group's aggregate row. Without
    // it a (0,0) row survives forever and 3D's total/count average reads back NULL.
    expect(report.aggregatesPruned).toBe(1);
    expect(await allStats()).toEqual([]);
    expect(await observationIds()).toEqual([]);
  });

  it("sweeps a write-path orphan even when nothing expired", async () => {
    await sight([valid({ listingId: "only", priceCents: 10_000 })], T0);
    // The last contributing listing leaves its group via price -> null: SUBTRACT_OLD drives
    // the row to (0,0) and the GROUPS query can never see it.
    await sight([valid({ listingId: "only", priceCents: null })], T0 + 60);
    expect((await allStats())[0]).toMatchObject({ count: 0, total_price_cents: 0 });

    const report = await cleanupStaleObservations(db, { now: T0 + 120 });

    expect(report.groups).toBe(0);
    expect(report.aggregatesPruned).toBe(1);
    expect(await allStats()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 6 -- cleanup retry.
// ---------------------------------------------------------------------------
describe("cleanup retry", () => {
  const seed = async () => {
    await sight(
      [
        valid({ listingId: "old1", priceCents: 10_000 }),
        valid({ listingId: "old2", priceCents: 20_000 }),
        valid({ listingId: "fresh", priceCents: 30_000 }),
      ],
      T0,
    );
    const stillSeen = T0 + 8 * DAY;
    await sight([valid({ listingId: "fresh", priceCents: 30_000 })], stillSeen);
    return stillSeen + 60;
  };

  it("re-issuing the IDENTICAL batch neither throws nor changes the aggregate", async () => {
    const now = await seed();
    const cutoff = now - STALE_AFTER_SECONDS;

    // Capture the group set BEFORE cleanup: after it, GROUPS returns nothing, and a second
    // end-to-end call would exit before any statement runs -- which is how a JS-carried-values
    // mutant survives a test that merely calls cleanup twice.
    const { groups } = await staleGroups(db, cutoff, 25);
    expect(groups).toHaveLength(1);

    await cleanupStaleObservations(db, { now });
    const afterFirst = await allStats();
    expect(afterFirst[0]).toMatchObject({ count: 1, total_price_cents: 30_000 });

    const replay = db.batch(
      groups.flatMap((group) => staleGroupStatements(db, group, cutoff)),
    );
    await expect(replay).resolves.toBeDefined();

    expect(await allStats()).toEqual(afterFirst);
    expect(await observationIds()).toEqual(["fresh"]);
  });

  it("a second end-to-end run changes nothing", async () => {
    const now = await seed();

    await cleanupStaleObservations(db, { now });
    const afterFirst = await allStats();

    const second = await cleanupStaleObservations(db, { now });

    expect(second.groups).toBe(0);
    expect(second.observationsDeleted).toBe(0);
    expect(await allStats()).toEqual(afterFirst);
  });

  it("a member refreshed between the GROUPS read and the batch is not subtracted", async () => {
    const now = await seed();
    const cutoff = now - STALE_AFTER_SECONDS;

    const { groups } = await staleGroups(db, cutoff, 25);

    // The stale read goes stale: old2 is re-sighted after the groups were chosen. The JS read
    // only picks WHICH GROUPS to visit; the amounts are computed inside the transaction, so
    // old2 must survive and the aggregate must still equal the recomputation.
    await sight([valid({ listingId: "old2", priceCents: 20_000 })], now);

    await db.batch(groups.flatMap((group) => staleGroupStatements(db, group, cutoff)));

    expect(await observationIds()).toEqual(["fresh", "old2"]);
    expect(await allStats()).toEqual(await recomputed());
    expect((await allStats())[0]).toMatchObject({ count: 2, total_price_cents: 50_000 });
  });
});

// ---------------------------------------------------------------------------
// Bounds: 3E needs `remaining` to know whether to resume, and the sweep must still run.
// ---------------------------------------------------------------------------
describe("bounded cleanup", () => {
  it("stops at maxBatches, reports remaining, and still sweeps", async () => {
    // Four groups, one listing each, all stale.
    await sight(
      ["a", "b", "c", "d"].map((model) =>
        valid({ listingId: `l-${model}`, modelKey: `MODEL_${model.toUpperCase()}`, priceCents: 1_000 }),
      ),
      T0,
    );
    expect(await allStats()).toHaveLength(4);

    const now = T0 + 8 * DAY;
    const report = await cleanupStaleObservations(db, { now, groupsPerBatch: 1, maxBatches: 2 });

    expect(report.batches).toBe(2);
    expect(report.groups).toBe(2);
    expect(report.remaining).toBe(true);
    // The sweep runs on an early exit too, so the two fully-expired groups are pruned now
    // rather than waiting for a resume.
    expect(report.aggregatesPruned).toBe(2);
    expect(await allStats()).toHaveLength(2);

    const resumed = await cleanupStaleObservations(db, { now, groupsPerBatch: 1, maxBatches: 40 });
    expect(resumed.remaining).toBe(false);
    expect(await allStats()).toEqual([]);
    expect(await observationIds()).toEqual([]);
  });
});
